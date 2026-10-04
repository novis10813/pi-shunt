// Shared, pi-independent diagnostics configuration. Missing file enables defaults;
// malformed configuration disables diagnostics only (not either extension).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DiagnosticsConfig {
	languages: string[];
	commands: Record<string, string>;
	timeoutMs: number;
	maxFindings: number;
}

export const DEFAULT_LANGUAGES = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh", "bash"];
export const DEFAULT_COMMANDS: Record<string, string> = {
	ts: "biome check --reporter=json {files}",
	tsx: "biome check --reporter=json {files}",
	js: "biome check --reporter=json {files}",
	jsx: "biome check --reporter=json {files}",
	mjs: "biome check --reporter=json {files}",
	cjs: "biome check --reporter=json {files}",
	py: "ruff check --output-format json --no-fix {files}",
	sh: "shellcheck -f json {files}",
	bash: "shellcheck -f json {files}",
};

// Only known linter binaries may be executed: a hostile or sloppy per-project
// `commands` override must not become arbitrary code execution.
export const ALLOWED_LINTER_BINARIES = new Set(["biome", "ruff", "shellcheck"]);

// Diagnostics run automatically after a read/edit, with no agent decision in
// between, so a per-project template must never turn that into a file write.
// Flags that make biome/ruff/shellcheck modify files are rejected (`--no-fix` is fine).
const WRITE_FLAG = /^--(?:write|fix(?:-only|-all|-unsafe)?|apply(?:-unsafe)?|unsafe(?:-[a-z-]+)?|add-noqa)(?:=|$)/i;

// No shell expansion or quoting: template is intentionally a simple argv list.
export function parseCommand(template: string): string[] | null {
	if (typeof template !== "string" || !template.trim()) return null;
	const parts = template.trim().split(/\s+/);
	if (parts[0] === "{files}" || parts.filter((part) => part === "{files}").length !== 1) return null;
	if (!ALLOWED_LINTER_BINARIES.has(parts[0])) return null;
	if (parts.some((part) => part !== "{files}" && (!/^[\w./:@+=,-]+$/.test(part) || part.includes("{files}")))) return null;
	if (parts.some((part) => WRITE_FLAG.test(part))) return null;
	return parts;
}

export function normalizeDiagnosticsConfig(raw: unknown): DiagnosticsConfig | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") return null;
	if (obj.enabled === false) return null;
	const languages = obj.languages ?? DEFAULT_LANGUAGES;
	if (!Array.isArray(languages) || !languages.every((v) => typeof v === "string" && /^[a-z0-9]+$/i.test(v))) return null;
	const commands = obj.commands ?? {};
	if (!commands || typeof commands !== "object" || Array.isArray(commands)) return null;
	const overridden = commands as Record<string, unknown>;
	if (Object.entries(overridden).some(([ext, template]) => !/^[a-z0-9]+$/i.test(ext) || typeof template !== "string" || !parseCommand(template))) return null;
	const timeoutMs = obj.timeoutMs ?? 10000;
	const maxFindings = obj.maxFindings ?? 20;
	if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 60000) return null;
	if (!Number.isSafeInteger(maxFindings) || (maxFindings as number) < 1 || (maxFindings as number) > 200) return null;
	return {
		languages: [...new Set(languages.map((s: string) => s.toLowerCase()))],
		commands: Object.fromEntries(Object.entries(overridden).map(([key, template]) => [key.toLowerCase(), template as string])),
		timeoutMs: timeoutMs as number,
		maxFindings: maxFindings as number,
	};
}

export function loadDiagnosticsConfig(cwd: string): DiagnosticsConfig | null {
	try { return normalizeDiagnosticsConfig(JSON.parse(readFileSync(join(cwd, ".pi", "diagnostics.json"), "utf8"))); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeDiagnosticsConfig({});
		return null;
	}
}
