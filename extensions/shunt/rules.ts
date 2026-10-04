/**
 * shunt/rules.ts — pure decision logic for the shunt extension.
 *
 * No pi imports; runnable directly under Node (see test-shunt.mjs).
 * Decides when a full-file read of a large text file should be intercepted
 * and replaced by a structure index.
 */

import { DEFAULT_LANGUAGES } from "./structure.ts";

export interface ShuntConfig {
	/** Files with more than this many lines are intercepted on full reads */
	minLines: number;
	/** Extensions treated as code (case-insensitive). Unknown extensions stay "other". */
	languages: string[];
}

export const DEFAULT_CONFIG: ShuntConfig = {
	minLines: 350,
	languages: DEFAULT_LANGUAGES,
};

/** Validate a parsed shunt.json object; undefined when unusable. */
export function normalizeConfig(raw: unknown): ShuntConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const minLines =
		typeof obj.minLines === "number" && Number.isFinite(obj.minLines) && obj.minLines >= 0
			? Math.max(1, Math.floor(obj.minLines))
			: DEFAULT_CONFIG.minLines;
	const languages =
		Array.isArray(obj.languages) && obj.languages.every((x) => typeof x === "string")
			? [...new Set(obj.languages.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0))]
			: DEFAULT_CONFIG.languages;
	return { minLines, languages };
}

/**
 * Selector grammar — mirrors the pi-read-selector extension
 * (github.com/novis10813/pi-read-selector, ported from oh-my-pi). Only a
 * grammar-valid trailing `:<chunk>` counts as a selector; anything else is
 * part of the path. Windows drive letters ("C:") never count.
 */
const RANGE_CHUNK_SRC = String.raw`L?(\d+)(?:(?:([-+]|\.\.)L?(\d+))|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const SELECTOR_TAIL_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const RANGE_LIST_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

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

/** First-N-bytes window for the text heuristic. */
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
 * Decide whether a full-file read should be intercepted. `buf` is the file
 * content. Only non-targeted, text, large-enough, under-the-cap files qualify.
 */
export function decideIntercept(
	input: ReadInput,
	buf: Buffer,
	minLines: number,
	sizeCap: number,
): InterceptDecision {
	if (isTargetedRead(input)) return { intercept: false };
	if (!looksLikeText(buf)) return { intercept: false };
	const lines = countLines(buf);
	if (lines <= minLines) return { intercept: false, lines };
	if (buf.length > sizeCap) return { intercept: false, lines };
	return { intercept: true, lines };
}
