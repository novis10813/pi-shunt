import { existsSync, readFileSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { loadDiagnosticsConfig } from "../../shared/diagnostics/config.ts";
import { lintFile } from "../../shared/diagnostics/linters.ts";
import { annotateSource, appendIndexDiagnostics, readStartLine } from "./diagnostic-render.ts";
import {
	CONFIG_DIR_NAME,
	isReadToolResult,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import {
	decideIntercept,
	detectBashReads,
	isTargetedRead,
	normalizeConfig,
	stripPathSelector,
	type ShuntConfig,
} from "./rules.ts";
import { probeLargeFile } from "./probe.ts";
import {
	MAX_DETERMINISTIC_CHARS,
	MAX_CODE_PARSE_CHARS,
	buildCodeIndex,
	buildCsvProfile,
	buildJsonlProfile,
	buildMarkdownOutline,
	detectKind,
	extensionOf,
	grammarForPath,
	initStructureEngine,
	renderCodeIndex,
	renderStructure,
	type EngineName,
} from "./structure.ts";

/**
 * shunt — token routing for the pi coding agent.
 *
 * Keeps large file reads out of the main model's context — only a compact,
 * navigable structure index enters it.
 *
 * Mechanism (stacks with any `read` override, e.g. the global read-selector
 * extension — shunt itself registers NO tool):
 * - read rule (tool_result hook): after a successful, non-targeted full read
 *   of a text file above minLines, the result is replaced by the first engine
 *   that succeeds (config: <cwd>/.pi/shunt.json):
 *   code (tree-sitter, local) / markdown / csv / jsonl — deterministic
 *   structure index, no model call, up to 20MB.
 *   Targeted reads, small files, other file types, images, binaries, missing
 *   files, and every engine failure keep the original result untouched (fail open).
 * - bash rule (tool_call hook): blocks `cat|head|tail|less|more` on large
 *   files and redirects to the read tool. Piped/redirected/bounded-targeted
 *   usage passes through.
 *
 * Heuristic, not a sandbox: bash detection and the selector mirror are
 * string-based, like guard's. See README.md next to this file.
 */

/** Bounded in-memory LRU (64 entries). */
const CACHE_MAX = 64;
function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
	const value = cache.get(key);
	if (value) { cache.delete(key); cache.set(key, value); }
	return value;
}
function lruSet<V>(cache: Map<string, V>, key: string, value: V): void {
	cache.delete(key);
	if (cache.size >= CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
}

/** Deterministic-engine output (spec §3.8): same file re-read within a session
 *  skips re-reading and re-parsing. */
const structCache = new Map<string, { text: string; engine: EngineName; lines: number }>();
const structCacheGet = (key: string) => lruGet(structCache, key);
const structCacheSet = (key: string, value: { text: string; engine: EngineName; lines: number }) => lruSet(structCache, key, value);

/** Per-extension-instance "announced once" set so fail-open warnings don't spam. */
const announced = new Set<string>();
function announceOnce(ctx: ExtensionContext, key: string, message: string) {
	if (announced.has(key)) return;
	announced.add(key);
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

/** Load and validate <cwd>/.pi/shunt.json; undefined disables shunt (fail open). */
function loadConfig(cwd: string): ShuntConfig | undefined {
	const file = join(cwd, CONFIG_DIR_NAME, "shunt.json");
	if (!existsSync(file)) return undefined;
	try {
		return normalizeConfig(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
}

/** readFile that returns an empty buffer on error, so decision code never throws. */
async function safeRead(cwd: string, path: string): Promise<Buffer> {
	try {
		return await readFile(isAbsolute(path) ? path : resolve(cwd, path));
	} catch {
		return Buffer.alloc(0);
	}
}

export default function (pi: ExtensionAPI) {
	// Read rule: after a successful non-targeted full read, replace the result
	// with a structure index when the file is large. Returning undefined keeps
	// the original result — so every pass-through is behaviorally identical
	// to shunt not existing.
	pi.on("tool_result", async (event, ctx) => {
		if (!isReadToolResult(event) || event.isError) return;
		if (event.content.some((part) => part.type !== "text")) return;
		const input = event.input as ReadToolInput;
		if (typeof input?.path !== "string") return;
		const diagnostics = loadDiagnosticsConfig(ctx.cwd);
		const cfg = loadConfig(ctx.cwd);
		// Keep the original shunt routing intact. Decoration happens in this
		// same handler after the routing decision, never in another extension.
		async function decorate(index?: { content: typeof event.content; details?: unknown }) {
			if (!diagnostics) return index;
			const original = event.content;
			if (original.length !== 1 || original[0]?.type !== "text" || typeof original[0].text !== "string") return index;
			const literal = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
			const base = existsSync(literal) ? input.path : stripPathSelector(input.path);
			const file = isAbsolute(base) ? base : resolve(ctx.cwd, base);
			const ext = extname(file).slice(1).toLowerCase();
			if (!diagnostics.languages.includes(ext)) return index;
			if (index && (index.details as { engine?: string } | undefined)?.engine !== "tree-sitter") return index;
			try {
				const checked = await lintFile(file, diagnostics);
				if (checked.kind !== "ok" || checked.diagnostics.length === 0) return index;
				if (index) {
					if (index.content.length !== 1 || index.content[0]?.type !== "text") return index;
					return { ...index, content: [{ type: "text" as const, text: appendIndexDiagnostics(index.content[0].text, checked.diagnostics, diagnostics.maxFindings) }] };
				}
				const start = readStartLine(input, literal);
				if (!start) return;
				// Verify the tool's actual text is an exact source slice. This also
				// rejects tool truncation banners and binary notices.
				const sourceStat = await stat(file);
				if (!sourceStat.isFile() || sourceStat.size > 2_000_000) return;
				const source = await readFile(file, "utf8");
				const annotated = annotateSource(original[0].text, source, start, checked.diagnostics, diagnostics.maxFindings);
				return annotated === undefined ? undefined : { content: [{ ...original[0], text: annotated }], details: event.details };
			} catch { return index; }
		}
		if (!cfg || isTargetedRead(input)) return decorate();

		const literalPath = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
		const basePath = existsSync(literalPath) ? input.path : stripPathSelector(input.path);
		const absPath = isAbsolute(basePath) ? basePath : resolve(ctx.cwd, basePath);
		// Bounded probe: stat before reading so a multi-GB file can never OOM or
		// block. Missing files and non-regular files pass through.
		let st: Stats;
		try {
			st = await stat(absPath);
		} catch {
			return;
		}
		if (!st.isFile()) return;
		// Spec §3.1: the size cap is chosen after stat, by extension only
		// (no read needed) — md/csv/jsonl get 20MB; code gets 1MB, because
		// tree-sitter's synchronous WASM parse must not stall the session.
		const kind = detectKind(basePath, cfg.languages);
		if (kind === "other") return decorate();
		const sizeCap = kind === "code" ? MAX_CODE_PARSE_CHARS : MAX_DETERMINISTIC_CHARS;
		if (st.size > sizeCap) return decorate();

		// Deterministic track (code / markdown / csv / jsonl) — fully local, no
		// model call. Any failure keeps the original result (fail open).
		// The cache key is stat+config only, so a hit implies unchanged content —
		// serve it before reading the file at all. Config in the key: a
		// mid-session edit of `languages`/`minLines` must not serve an
		// index rendered or decided under the old config.
		const cacheKey = `${absPath}\u0000${st.mtimeMs}\u0000${st.size}\u0000${cfg.minLines}\u0000${cfg.languages.join(",")}`;
		const cached = structCacheGet(cacheKey);
		if (cached) {
			return decorate({
				content: [{ type: "text", text: cached.text }],
				details: { shunt: true, engine: cached.engine, lines: cached.lines },
			});
		}

		const buf = await safeRead(ctx.cwd, basePath);
		const decision = decideIntercept(input, buf, cfg.minLines, sizeCap);
		if (!decision.intercept || !decision.lines) return decorate();

		const text = buf.toString("utf8");
		let engine: EngineName | undefined;
		let body: string[] | undefined;
		if (kind === "code") {
			const grammar = grammarForPath(basePath, cfg.languages);
			if (grammar) {
				const eng = await initStructureEngine();
				if (!eng) {
					announceOnce(
						ctx,
						"structure-engine-missing",
						"shunt: tree-sitter engine unavailable — code files pass through unchanged.",
					);
				} else {
					const ci = await buildCodeIndex(text, grammar);
					if (ci) {
						engine = "tree-sitter";
						body = renderCodeIndex(ci);
					}
				}
			}
		} else if (kind === "markdown") {
			body = buildMarkdownOutline(text);
			engine = body ? "markdown" : undefined;
		} else if (kind === "csv") {
			body = buildCsvProfile(text, extensionOf(basePath) === "tsv" ? "\t" : ",");
			engine = "csv";
		} else {
			body = buildJsonlProfile(text);
			engine = body ? "jsonl" : undefined;
		}
		if (engine && body) {
			const rendered = renderStructure(input.path, decision.lines, engine, body);
			structCacheSet(cacheKey, { text: rendered, engine, lines: decision.lines });
			return decorate({
				content: [{ type: "text", text: rendered }],
				details: { shunt: true, engine, lines: decision.lines },
			});
		}

		return decorate();
	});

	// Bash rule: direct reads of large files via cat/head/tail/less/more.
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const cfg = loadConfig(ctx.cwd);
		if (!cfg) return;
		// A malformed event must not crash the hook (fail open).
		const command: unknown = event.input?.command;
		if (typeof command !== "string") return;
		for (const hit of detectBashReads(command, cfg.minLines)) {
			const abs = isAbsolute(hit.file) ? hit.file : resolve(ctx.cwd, hit.file);
			let sourceStat: Stats;
			try {
				sourceStat = await stat(abs);
			} catch {
				continue;
			}
			if (!sourceStat.isFile()) continue;
			let target: string;
			if (sourceStat.size > MAX_CODE_PARSE_CHARS) {
				target = `${hit.file} (over ${MAX_CODE_PARSE_CHARS} bytes)`;
			} else {
				const probe = await probeLargeFile(abs, cfg.minLines);
				if (!probe || !probe.isText || probe.lines <= cfg.minLines) continue;
				target = probe.truncated
					? `${hit.file} (${probe.lines}+ lines)`
					: `the ${probe.lines}-line file ${hit.file}`;
			}
			return {
				block: true,
				reason:
					`shunt: "${hit.command}" on ${target} would dump it directly into context. ` +
					`Use the read tool instead — for files this large it returns a compact structured summary with a line-range index ` +
					`(targeted reads with offset/limit or :range are always allowed for exact content).`,
			};
		}
	});
}
