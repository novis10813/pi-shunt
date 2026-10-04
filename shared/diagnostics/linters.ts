// Shared single-file CLI linter runner. No pi imports and no persistent result cache:
// project-level linter config changes need not change the source file's mtime.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { DEFAULT_COMMANDS, parseCommand, type DiagnosticsConfig } from "./config.ts";

export interface Diag {
	file: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info";
	rule: string;
	message: string;
}
export type LintResult = { kind: "ok"; diagnostics: Diag[] } | { kind: "unavailable" };
export type Linter = "ruff" | "shellcheck" | "biome";
export type ExecResult = { stdout: string; exitCode: number; failed?: boolean };
export type Executor = (binary: string, args: string[], options: { timeout: number; maxBuffer: number; cwd: string }) => Promise<ExecResult>;
const UNAVAILABLE: LintResult = { kind: "unavailable" };
const MAX_FILE_BYTES = 2_000_000;
const MAX_OUTPUT_BYTES = 2_000_000;

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function pos(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}
function zeroBased(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value + 1 : null;
}
function severity(value: unknown): Diag["severity"] {
	return value === "error" || value === "fatal" ? "error" : value === "info" || value === "style" || value === "hint" ? "info" : "warning";
}
function message(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	return value.replace(/\s*\r?\n\s*/g, " ").trim();
}
/** Returns null for invalid/unknown schema, never [] for malformed output. */
export function parseDiagnostics(linter: Linter, stdout: string, file: string): Diag[] | null {
	let raw: unknown;
	try { raw = JSON.parse(stdout); } catch { return null; }
	const data = linter === "biome" ? object(raw)?.diagnostics : raw;
	if (!Array.isArray(data)) return null;
	const diagnostics: Diag[] = [];
	let recognized = 0;
	for (const entry of data) {
		const d = object(entry);
		if (!d) continue;
		let line: number | null = null;
		let col: number | null = null;
		let rule: string | null = null;
		let msg: string | null = null;
		if (linter === "ruff") {
			const location = object(d.location);
			line = pos(location?.row);
			col = pos(location?.column) ?? 0;
			rule = typeof d.code === "string" ? d.code : null;
			msg = message(d.message);
		} else if (linter === "shellcheck") {
			line = pos(d.line);
			col = pos(d.column) ?? 0;
			rule = typeof d.code === "number" && Number.isSafeInteger(d.code) ? `SC${d.code}` : typeof d.code === "string" ? d.code.startsWith("SC") ? d.code : `SC${d.code}` : null;
			msg = message(d.message);
		} else {
			// Biome v2: location.start{line, column} — both 1-based, line 0 marks a
			// file-level diagnostic; category / message.
			// Biome v1: range.start{line, character} — both 0-based; rule.name / description.
			const v2start = object(object(d.location)?.start);
			const start = v2start ?? object(object(d.range)?.start);
			const v2line = v2start?.line;
			line = v2start
				? typeof v2line === "number" && Number.isSafeInteger(v2line) && v2line >= 0 ? v2line : null
				: zeroBased(start?.line);
			const column = start?.column;
			col = typeof column === "number" ? pos(column) ?? 0 : start?.character === undefined ? 0 : zeroBased(start.character);
			const category = typeof d.category === "string" && d.category !== "" ? d.category : null;
			rule = category ?? (typeof (object(d.rule)?.name) === "string" ? (object(d.rule)?.name as string) : null);
			msg = message(d.description) ?? message(d.message);
		}
		if (line !== null && col !== null && rule && msg) {
			recognized++;
			diagnostics.push({ file, line, col, severity: severity(linter === "shellcheck" ? d.level : d.severity), rule, message: msg });
		}
	}
	// A nonempty response entirely outside the expected schema is not a clean file.
	if (data.length > 0 && recognized === 0) return null;
	return diagnostics;
}

const defaultExecutor: Executor = (binary, args, options) => new Promise((resolve, reject) => {
	execFile(binary, args, { ...options, encoding: "utf8", shell: false, windowsHide: true }, (error, stdout) => {
		if (error && (error.killed || error.signal || typeof error.code !== "number")) return reject(error);
		resolve({ stdout: typeof stdout === "string" ? stdout : "", exitCode: error ? error.code as number : 0 });
	});
});

export async function lintFile(file: string, cfg: DiagnosticsConfig, executor: Executor = defaultExecutor): Promise<LintResult> {
	if (!isAbsolute(file) || !cfg || typeof cfg !== "object") return UNAVAILABLE;
	const ext = extname(file).slice(1).toLowerCase();
	if (!cfg.languages.includes(ext)) return UNAVAILABLE;
	const template = cfg.commands[ext] ?? DEFAULT_COMMANDS[ext];
	const parts = template && parseCommand(template);
	if (!parts) return UNAVAILABLE;
	const binary = parts[0];
	// A custom command still uses the output grammar associated with this extension.
	const linter: Linter | null = ext === "py" ? "ruff" : ext === "sh" || ext === "bash" ? "shellcheck" : ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext) ? "biome" : null;
	if (!linter) return UNAVAILABLE; // No known JSON schema for custom languages.
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) return UNAVAILABLE;
		const args = parts.slice(1).map((part) => part === "{files}" ? file : part);
		const result = await executor(binary, args, { timeout: cfg.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, cwd: dirname(file) });
		if (result.failed || !Number.isSafeInteger(result.exitCode) || result.exitCode < 0) return UNAVAILABLE;
		const diagnostics = parseDiagnostics(linter, result.stdout, file);
		return diagnostics === null ? UNAVAILABLE : { kind: "ok", diagnostics };
	} catch { return UNAVAILABLE; }
}
