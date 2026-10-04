// Pure, conservative read-result decoration. No pi imports.
import { existsSync } from "node:fs";
import type { Diag } from "../../shared/diagnostics/linters.ts";
import { parseRangeChunk, stripPathSelector, type ReadInput } from "./rules.ts";

/** Result starts at this 1-based source line, or undefined if mapping is unsafe. */
export function readStartLine(input: ReadInput, literalPath = input.path): number | undefined {
	const raw = input.path;
	// A real file containing ':' is a literal file in the global read override.
	if (existsSync(literalPath)) return typeof input.offset === "number" ? Math.max(1, input.offset) : 1;
	const base = stripPathSelector(raw);
	if (base === raw) return typeof input.offset === "number" ? Math.max(1, input.offset) : 1;
	const tail = raw.slice(base.length + 1);
	if (/^raw$/i.test(tail)) return typeof input.offset === "number" ? Math.max(1, input.offset) : 1;
	const sel = tail.replace(/(^raw:|:raw$)/i, "");
	if (sel.includes(",") || /:/.test(sel)) return undefined;
	// Single source of truth for the grammar: rules.ts (never a second regex here).
	const range = parseRangeChunk(sel);
	if (!range) return undefined;
	const { start } = range;
	if (!Number.isSafeInteger(start) || start < 1) return undefined;
	if (range.op === "-" && range.end !== undefined && range.end < start) return undefined;
	// Global read-selector delegates the bounded/one-sided range with one
	// leading context line. Offset/limit inputs are ignored when selector wins.
	return Math.max(1, start - 1);
}

function limited(diags: Diag[], max: number): { shown: Diag[]; extra: number } {
	return { shown: diags.slice(0, max), extra: Math.max(0, diags.length - max) };
}
const glyphFor = (d: Diag) => (d.severity === "error" ? "✖" : d.severity === "warning" ? "⚠" : "ℹ");
export function appendIndexDiagnostics(index: string, diags: Diag[], max: number): string {
	if (!diags.length) return index;
	const { shown, extra } = limited(diags, max);
	return `${index}\n[shunt] DIAGNOSTICS (${diags.length}):\n${shown.map(d => `  ${d.line}:${d.col} ${d.severity} [${d.rule}] ${d.message}`).join("\n")}${extra ? `\n  … +${extra} more` : ""}`;
}

/**
 * The read tool's continuation banners (not source content): the "more lines"
 * form for a bounded range, and the "showing lines" form when the range is
 * clamped by the read tool's line/byte limits.
 */
const READ_BANNER = /^\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+(?: \([^)]*\))?)\. Use offset=\d+ to continue\.\]$/;

/**
 * Require an exact slice of the source: never guess around unknown trailing
 * lines. The read tool's continuation banner is recognized, set aside during
 * validation, and reattached after the annotations.
 */
export function annotateSource(text: string, source: string, start: number, diags: Diag[], max: number): string | undefined {
	if (!diags.length || !Number.isSafeInteger(start) || start < 1) return undefined;
	const sourceLines = source.split("\n");
	const lines = text.split("\n");
	// Trailing newline is not an additional source line.
	const raw = text.endsWith("\n") ? lines.slice(0, -1) : lines;
	// Split off the tool's continuation banner (with its blank separator) so
	// the exact-slice check only covers source lines.
	let actual = raw;
	let tail: string[] = [];
	if (READ_BANNER.test(raw[raw.length - 1] ?? "")) {
		tail = [raw[raw.length - 1]];
		actual = raw.slice(0, -1);
		if (actual.length && actual[actual.length - 1] === "") {
			actual = actual.slice(0, -1);
			tail.unshift("");
		}
	}
	if (!actual.length || actual.some((line, idx) => sourceLines[start - 1 + idx] !== line)) return undefined;
	// File-level diagnostics (line 0, e.g. biome format findings) apply to the
	// whole file, so they are shown for targeted reads too (prepended).
	const eligible = diags.filter(d => d.line === 0 || (d.line >= start && d.line < start + actual.length));
	if (!eligible.length) return undefined;
	const { shown, extra } = limited(eligible, max);
	const fileLevel = shown.filter(d => d.line === 0);
	const grouped = new Map<number, Diag[]>();
	for (const diag of shown) if (diag.line > 0) grouped.set(diag.line, [...(grouped.get(diag.line) ?? []), diag]);
	const out: string[] = [];
	for (const d of fileLevel) out.push(`  ${glyphFor(d)} line ${d.line} [${d.rule}] ${d.message}`);
	for (let i = 0; i < actual.length; i++) {
		out.push(actual[i]);
		for (const d of grouped.get(start + i) ?? []) {
			out.push(`  ${glyphFor(d)} line ${d.line} [${d.rule}] ${d.message}`);
		}
	}
	if (extra) out.push(`  … +${extra} more`);
	return out.join("\n") + (tail.length ? `\n${tail.join("\n")}` : "") + (text.endsWith("\n") ? "\n" : "");
}
