import { existsSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	SettingsManager,
	getAgentDir,
	isReadToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { decideIntercept, isTargetedRead, normalizeConfig, stripPathSelector, type ShuntConfig } from "./rules.ts";
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
 * shunt — keeps large file reads out of the main model's context.
 *
 * read rule (tool_result hook, shunt registers NO tool): after a successful,
 * non-targeted full read of a code, markdown, csv or jsonl file above minLines, the
 * result is replaced by a local structure index. Config is the `shunt` key of
 * pi's settings.json (global, overridden by a trusted project's .pi/settings.json):
 *   - code — tree-sitter index (up to 1MB);
 *   - markdown — heading outline (up to 20MB);
 *   - csv/tsv, jsonl/ndjson — rows/fields/sample profile (up to 20MB).
 * Targeted reads, small files, other file types, images, binaries, missing
 * files, and every engine failure keep the original result untouched (fail open).
 *
 * Heuristic, not a sandbox: the selector mirror is string-based. See README.md
 * next to this file.
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

/** Same file re-read within a session skips re-reading and re-parsing. */
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

/** Read the merged `shunt` settings; undefined disables shunt (fail open). */
function loadConfig(ctx: ExtensionContext): ShuntConfig | undefined {
	try {
		const projectTrusted = ctx.isProjectTrusted?.() ?? false;
		const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
		// An unreadable settings file would silently look like "no settings".
		if (manager.drainErrors().length > 0) return undefined;
		return normalizeConfig((manager.getSettings() as Record<string, unknown>).shunt);
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
	// After a successful non-targeted full read, replace the result with a
	// structure index when the file is large. Returning undefined keeps the
	// original result, so every pass-through behaves as if shunt did not exist.
	pi.on("tool_result", async (event, ctx) => {
		if (!isReadToolResult(event) || event.isError) return;
		if (event.content.some((part) => part.type !== "text")) return;
		const input = event.input as ReadToolInput;
		if (typeof input?.path !== "string") return;
		const cfg = loadConfig(ctx);
		if (!cfg || isTargetedRead(input)) return;

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
		// The size cap is chosen by extension only (no read needed): code gets
		// 1MB because tree-sitter's synchronous WASM parse must not stall the
		// session, markdown/csv/jsonl get 20MB.
		const kind = detectKind(basePath, cfg.languages);
		if (kind === "other") return;
		const sizeCap = kind === "code" ? MAX_CODE_PARSE_CHARS : MAX_DETERMINISTIC_CHARS;
		if (st.size > sizeCap) return;

		// The cache key is stat+config only, so a hit implies unchanged content.
		// Serve it before reading the file at all. Config is in the key so a
		// mid-session edit of `languages`/`minLines` never serves a stale index.
		const cacheKey = `${absPath}\u0000${st.mtimeMs}\u0000${st.size}\u0000${cfg.minLines}\u0000${cfg.languages.join(",")}`;
		const cached = structCacheGet(cacheKey);
		if (cached) {
			return {
				content: [{ type: "text", text: cached.text }],
				details: { shunt: true, engine: cached.engine, lines: cached.lines },
			};
		}

		const buf = await safeRead(ctx.cwd, basePath);
		const decision = decideIntercept(input, buf, cfg.minLines, sizeCap);
		if (!decision.intercept || !decision.lines) return;

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
		if (!engine || !body) return;
		const rendered = renderStructure(input.path, decision.lines, engine, body);
		structCacheSet(cacheKey, { text: rendered, engine, lines: decision.lines });
		return {
			content: [{ type: "text", text: rendered }],
			details: { shunt: true, engine, lines: decision.lines },
		};
	});
}
