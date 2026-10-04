/**
 * shunt/rules.ts — pure decision logic for the shunt extension.
 *
 * No pi imports; runnable directly under Node (see test-shunt.mjs).
 * Decides when a full-file read of a large text file should be intercepted
 * for worker summarization, and when a bash command reads a large file
 * directly into context (to be blocked and redirected to `read`).
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DEFAULT_LANGUAGES } from "./structure.ts";

export interface ShuntConfig {
	/** Worker model as "provider/modelId", e.g. "cliproxyapi/gemini-3.8-flash-high" */
	worker: string;
	/** Files with more than this many lines are intercepted on full reads */
	minLines: number;
	/** Extensions treated as code (case-insensitive). Unknown extensions stay "other". */
	languages: string[];
	/** Large "other" text files: "worker" (LLM summary) or "passthrough" (no interception). */
	nonCode: "worker" | "passthrough";
}

export const DEFAULT_CONFIG: ShuntConfig = {
	worker: "cliproxyapi/gemini-3.8-flash-high",
	minLines: 350,
	languages: DEFAULT_LANGUAGES,
	nonCode: "worker",
};

/** Content ceiling for a single worker call (~well under a 1M-token context). */
export const MAX_WORKER_CHARS = 2_000_000;

/** Parse "provider/modelId"; undefined when malformed. */
export function parseWorkerRef(ref: string): { provider: string; modelId: string } | undefined {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) return undefined;
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** Validate a parsed shunt.json object; undefined when unusable. */
export function normalizeConfig(raw: unknown): ShuntConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const worker = typeof obj.worker === "string" && obj.worker.trim() !== "" ? obj.worker : DEFAULT_CONFIG.worker;
	if (!parseWorkerRef(worker)) return undefined;
	const minLines =
		typeof obj.minLines === "number" && Number.isFinite(obj.minLines) && obj.minLines >= 0
			? Math.max(1, Math.floor(obj.minLines))
			: DEFAULT_CONFIG.minLines;
	const languages =
		Array.isArray(obj.languages) && obj.languages.every((x) => typeof x === "string")
			? [...new Set(obj.languages.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0))]
			: DEFAULT_CONFIG.languages;
	const nonCode: "worker" | "passthrough" = obj.nonCode === "passthrough" ? "passthrough" : "worker";
	return { worker, minLines, languages, nonCode };
}

/**
 * Selector grammar — mirrors the pi-read-selector extension
 * (github.com/novis10813/pi-read-selector, ported from oh-my-pi). Only a
 * grammar-valid trailing `:<chunk>` counts as a selector; anything else is
 * part of the path. Windows drive letters ("C:") never count.
 */
// Capture groups (start, op, end) exist for parseRangeChunk; the list/tail
// regexes below only .test(), so they ignore them. This is the ONLY range
// grammar — diagnostic-render.ts maps lines through parseRangeChunk, so it can
// never accept a selector shape that the gate here would not have stripped.
const RANGE_CHUNK_SRC = String.raw`L?(\d+)(?:(?:([-+]|\.\.)L?(\d+))|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const SELECTOR_TAIL_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const RANGE_LIST_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
const RANGE_CHUNK_RE = new RegExp(`^${RANGE_CHUNK_SRC}$`, "i");
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** Parse ONE range chunk (`5`, `L5-L9`, `5+3`, `5-`, `5..`); null when it is not selector grammar. */
export function parseRangeChunk(chunk: string): { start: number; op?: string; end?: number } | null {
	const m = RANGE_CHUNK_RE.exec(chunk);
	if (!m) return null;
	return { start: Number(m[1]), op: m[2], end: m[3] === undefined ? undefined : Number(m[3]) };
}

/** Guard against Windows drive prefixes ("C:\\x"); POSIX files may contain colons. */
function isWindowsDrivePath(rawPath: string): boolean {
	return WINDOWS_DRIVE_RE.test(rawPath);
}

/**
 * Shared selector-tail probe: the last colon (skipping Windows drive
 * prefixes) whose tail is selector-shaped. null when the tail is not a
 * selector.
 */
function parsePathSelector(rawPath: string): { basePath: string; candidate: string } | null {
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return null;
	if (colon === 1 && isWindowsDrivePath(rawPath)) return null;
	const candidate = rawPath.slice(colon + 1);
	if (!SELECTOR_TAIL_RE.test(candidate)) return null;
	return { basePath: rawPath.slice(0, colon), candidate };
}

/** Strip a selector tail (without the literal-file probe); otherwise preserve the path. */
export function stripPathSelector(rawPath: string): string {
	const sel = parsePathSelector(rawPath);
	if (!sel) return rawPath;
	const { basePath, candidate } = sel;
	// Compound tail: `path:1-50:raw` or `path:raw:1-50` — peel both parts.
	const innerColon = basePath.lastIndexOf(":");
	if (innerColon >= 2) {
		const inner = basePath.slice(innerColon + 1);
		const innerIsRaw = /^raw$/i.test(inner);
		const outerIsRaw = /^raw$/i.test(candidate);
		const innerIsRange = RANGE_LIST_RE.test(inner);
		const outerIsRange = RANGE_LIST_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			return basePath.slice(0, innerColon);
		}
	}
	return basePath;
}

/**
 * True when the path carries a line-range selector (a targeted read).
 * `:raw` alone is NOT targeted — it is a full raw read.
 */
export function isTargetedPathSelector(rawPath: string): boolean {
	const sel = parsePathSelector(rawPath);
	if (!sel) return false;
	const { basePath, candidate } = sel;
	if (RANGE_LIST_RE.test(candidate)) return true;
	if (/^raw$/i.test(candidate)) {
		// Possibly a `range:raw` compound — check one level up.
		const innerColon = basePath.lastIndexOf(":");
		if (innerColon >= 2 && RANGE_LIST_RE.test(basePath.slice(innerColon + 1))) return true;
	}
	return false;
}

export interface ReadInput {
	path: string;
	offset?: number;
	limit?: number;
}

/** A read is "targeted" when it explicitly asks for a subset of lines. */
export function isTargetedRead(input: ReadInput): boolean {
	if (typeof input.offset === "number" || typeof input.limit === "number") return true;
	return isTargetedPathSelector(input.path);
}

/** Count lines in a buffer (a trailing line without newline still counts). */
export function countLines(buf: Buffer): number {
	let lines = 0;
	let idx = -1;
	while ((idx = buf.indexOf(0x0a, idx + 1)) !== -1) lines++;
	if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++;
	return lines;
}

/** First-N-bytes window for the text heuristic (shared with index.ts probe). */
export const TEXT_PROBE_BYTES = 8192;

/** Heuristic text check: no NUL byte in the first TEXT_PROBE_BYTES. */
export function looksLikeText(buf: Buffer): boolean {
	const n = Math.min(buf.length, TEXT_PROBE_BYTES);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
	return true;
}

export interface InterceptDecision {
	intercept: boolean;
	lines?: number;
}

/**
 * Decide whether a full-file read should be intercepted for worker
 * summarization. `buf` is the file content. Only non-targeted, text,
 * large-enough, small-enough-for-the-worker files qualify.
 */
export function decideIntercept(
	input: ReadInput,
	buf: Buffer,
	minLines: number,
	sizeCap: number = MAX_WORKER_CHARS,
): InterceptDecision {
	if (isTargetedRead(input)) return { intercept: false };
	if (!looksLikeText(buf)) return { intercept: false };
	const lines = countLines(buf);
	if (lines <= minLines) return { intercept: false, lines };
	if (buf.length > sizeCap) return { intercept: false, lines };
	return { intercept: true, lines };
}

// ---------------- bash detection ----------------

const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more"]);

export interface BashReadHit {
	/** The read command ("cat", "head", ...) */
	command: string;
	/** A file argument that may be an oversized direct read (unresolved) */
	file: string;
}

/**
 * Detect `cat|head|tail|less|more <file>` usage in a bash command.
 * Heuristic (string-based, not a shell parser) — same class as guard's bash rules.
 *
 * Commands are split on `;`, `&&`, `||`, and newlines; within each compound
 * command, only the LAST part of the pipeline is whitelisted for direct reads;
 * earlier readers pass through unless the
 * last part is itself an unbounded stdin reader (`cat`/`less`/`more`, or
 * `head`/`tail` over their bound): then the file arguments of the EARLIER
 * parts are candidates too (`cat big.txt | cat`). This is a heuristic scope
 * choice: `cat big.txt | sort` can still output the whole file. Command substitution
 * (`$(...)` / backticks, one level) is scanned the same way, since its output
 * enters context through the parent command. Also passes through:
 *  - segments with a stdout redirect to a file (`> f`, `>> f`); stderr
 *    redirections (`2>…`, `2>&1`) and `>&n` dups do NOT count — output is
 *    still captured; `< f` is a stdin source, not a pass-through
 *  - subshell-wrapped and xargs/sudo-prefixed read commands are still detected
 *  - head/tail without an explicit large line or byte count (default is 10 lines)
 *  - non-read commands, and bounded readers on stdin; an unbounded trailing
 *    reader re-opens the earlier parts of the pipeline
 *  - quoted arguments are tokenized as one token (`cat "big file.txt"`)
 *
 * For head/tail, an explicit line count (`-n N`, `--lines[=]N`, `-N`) at or
 * below `minLines`, or an explicit byte count (`-c N`, `-cN`, `--bytes[=]N`)
 * at or below `minLines * BYTES_PER_LINE_ESTIMATE`, is treated as targeted and
 * passes through. Returns candidate (command, file) pairs; the caller checks
 * actual line counts.
 */
const BYTES_PER_LINE_ESTIMATE = 80; // conservative chars/line for head -c / tail -c bounds

/**
 * Split on unquoted whitespace; single- and double-quoted spans each become
 * one token with the quotes removed, so `cat "big file.txt"` and
 * `"cat" big.txt` resolve. Not a shell parser: backslash escapes outside
 * double quotes are kept verbatim.
 */
function tokenizeShell(segment: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (const ch of segment) {
		if (quote) {
			if (ch === quote) quote = null;
			else if (!(quote === '"' && ch === "\\")) cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (cur) { tokens.push(cur); cur = ""; }
		} else cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

/** Command-substitution spans whose output flows into the parent command. */
function substitutionSpans(text: string): string[] {
	const spans: string[] = [];
	for (const m of text.matchAll(/\$\(([^)]*)\)/g)) spans.push(m[1]);
	for (const m of text.matchAll(/`([^`]*)`/g)) spans.push(m[1]);
	return spans;
}

interface SegmentScan { hits: BashReadHit[]; unboundedStdinReader: boolean; }

/**
 * Analyze one pipeline segment: file arguments of a read command are
 * candidates. head/tail with an explicit bound pass. `unboundedStdinReader`
 * marks a reader with no file argument whose output is not otherwise bounded
 * (cat/less/more, or head/tail over their bound) — it would print whatever an
 * earlier segment read from a file.
 */
function analyzeSegment(segmentRaw: string, minLines: number): SegmentScan | null {
	// Strip stderr redirections before the redirect test: `2>`, `2>>`, `2>&1`
	// don't keep stdout out of context, so they must not trigger pass-through.
	const segment = segmentRaw.replace(/2>{1,2}(?:&\d+|\s*(?!["'])\S+)?/g, "").trim();
	if (segment === "") return null;
	// Only a stdout redirect to a file keeps content out of context. `>&n`
	// dups are still captured by the tool; `< f` is a stdin source, so the
	// file argument is still probed below.
	if (/>[^&]/.test(segment)) return null;
	// `cat<file` / `cat <file`: pad attached redirect operators so the
	// command name stays recognizable (the file argument is still probed).
	const padded = segment.replace(/([<>])(?=\S)/g, "$1 ").replace(/(?<=\S)([<>])/g, " $1");
	let tokens = tokenizeShell(padded);
	// Subshell wrapping: `(cat file)` carries parens on the first/last tokens.
	if (tokens.length > 0) {
		tokens[0] = tokens[0].replace(/^\(+/, "");
		tokens[tokens.length - 1] = tokens[tokens.length - 1].replace(/\)+$/, "");
		tokens = tokens.filter(Boolean);
	}
	let i = 0;
	// Skip env prefixes and wrappers whose next token is the real command.
	while (
		i < tokens.length &&
		(/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === "xargs" || tokens[i] === "sudo")
	)
		i++;
	const cmd = tokens[i];
	if (!cmd || !READ_COMMANDS.has(cmd)) return null;
	const rest = tokens.slice(i + 1);
	// head/tail count/byte values are consumed here and must not be
	// mistaken for file arguments by the scan below.
	const consumed = new Set<number>();

	if (cmd === "head" || cmd === "tail") {
		// `+N` is a tail "from position N to EOF" marker, so the sign must survive
		// parsing (parseInt would swallow it).
		const parseCount = (raw: string): { n: number; plus: boolean } | undefined => {
			const n = parseInt(raw, 10);
			return Number.isFinite(n) ? { n, plus: raw.startsWith("+") } : undefined;
		};
		let lineCount: { n: number; plus: boolean } | undefined;
		let byteCount: { n: number; plus: boolean } | undefined;
		for (let j = 0; j < rest.length; j++) {
			const t = rest[j];
			let m: RegExpExecArray | null;
			if (t === "-n" || t === "--lines") {
				lineCount = parseCount(rest[j + 1] ?? "");
				consumed.add(j + 1);
				j++;
			} else if (t.startsWith("--lines=")) {
				lineCount = parseCount(t.slice(8));
			} else if ((m = /^-n([+-]?\d+)$/.exec(t))) {
				lineCount = parseCount(m[1]);
			} else if (/^-\d+$/.test(t)) {
				lineCount = parseCount(t.slice(1));
			} else if (t === "-c" || t === "--bytes") {
				byteCount = parseCount(rest[j + 1] ?? "");
				consumed.add(j + 1);
				j++;
			} else if (t.startsWith("--bytes=")) {
				byteCount = parseCount(t.slice(8));
			} else if ((m = /^-c([+-]?\d+)$/.exec(t))) {
				byteCount = parseCount(m[1]);
			}
		}
		// Bounded-output semantics, empirically verified against GNU coreutils
		// 9.11 on this system (10,000-line / 2,000-byte fixtures):
		//   head -n N and head -n +N → first N lines (+N ≡ N)     : bounded iff N ≤ minLines
		//   head -n -N              → all but last N lines        : unbounded
		//   tail -n N               → last N lines                : bounded iff N ≤ minLines
		//   tail -n +N              → from line N to EOF          : unbounded (+400 → 9,601 lines)
		//   tail -n -N              → last N lines (≡ N)          : bounded iff |N| ≤ minLines
		// Bytes: head -c -N → all but last N bytes (unbounded); tail -c +N → from
		// byte N to EOF (unbounded; +500 → 1,501 bytes); tail -c -N → last N bytes
		// (bounded by magnitude); other positive → bounded iff ≤ minLines*80.
		const cap = minLines * BYTES_PER_LINE_ESTIMATE;
		let linesBounded = true; // default 10 lines
		if (lineCount) {
			if (cmd === "tail" && lineCount.plus) linesBounded = false;
			else if (cmd === "head" && lineCount.n < 0) linesBounded = false;
			else linesBounded = Math.abs(lineCount.n) <= minLines;
		}
		let bytesBounded = true;
		if (byteCount) {
			if (cmd === "tail" && byteCount.plus) bytesBounded = false;
			else if (cmd === "head" && byteCount.n < 0) bytesBounded = false;
			else bytesBounded = Math.abs(byteCount.n) <= cap;
		}
		if (linesBounded && bytesBounded) return null;
	}

	const hits: BashReadHit[] = [];
	for (let k = 0; k < rest.length; k++) {
		const t = rest[k];
		if (t.startsWith("-")) continue;
		if (consumed.has(k)) continue; // count/byte value, not a file argument
		if (t.startsWith("<") || t === "(" || t === ")") continue; // redirect / subshell tokens
		if (/^\d*>/.test(t)) continue; // redirect target, not a file argument
		hits.push({ command: cmd, file: t });
	}
	return { hits, unboundedStdinReader: hits.length === 0 };
}

function scanCompound(compound: string, minLines: number, hits: BashReadHit[], depth: number): void {
	const segments = compound.split("|");
	const last = (segments.pop() ?? "").trim();
	if (last === "") return;
	const info = analyzeSegment(last, minLines);
	if (info) {
		hits.push(...info.hits);
		// An unbounded trailing reader prints whatever the earlier parts read.
		if (info.unboundedStdinReader) {
			for (const earlier of segments) {
				const earlierInfo = analyzeSegment(earlier.trim(), minLines);
				if (earlierInfo) hits.push(...earlierInfo.hits);
			}
		}
	}
	// `$(cat file)` / backtick spans execute inside the parent and their
	// output enters context through it. One level of nesting is scanned
	// (heuristic); deeper nesting degrades to the documented pass-through.
	if (depth === 0) {
		for (const span of substitutionSpans(compound)) {
			for (const inner of span.split(/;|&&|\|\||\r?\n/)) {
				scanCompound(inner, minLines, hits, depth + 1);
			}
		}
	}
}

export function detectBashReads(command: string, minLines: number): BashReadHit[] {
	// Join backslash-continuation lines first: `cmd \\<newline> arg` is one command.
	const normalized = command.replace(/\\\r?\n/g, " ");
	const hits: BashReadHit[] = [];
	for (const compound of normalized.split(/;|&&|\|\||\r?\n/)) {
		scanCompound(compound, minLines, hits, 0);
	}
	return hits;
}

/** True when absPath resolves to cwd itself or below it (egress boundary). */
export function isWithinCwd(cwd: string, absPath: string): boolean {
	let base = resolve(cwd);
	let target = resolve(absPath);
	try {
		base = realpathSync(base);
		target = realpathSync(target);
	} catch {
		// Missing paths retain the lexical fallback.
		base = resolve(cwd);
		target = resolve(absPath);
	}
	return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}
