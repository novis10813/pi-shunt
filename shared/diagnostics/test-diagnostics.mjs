// Standalone fixture-first tests: node shared/diagnostics/test-diagnostics.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { loadDiagnosticsConfig, normalizeDiagnosticsConfig, parseCommand } from "./config.ts";
import { lintFile, parseDiagnostics } from "./linters.ts";
import { annotateSource } from "../../extensions/shunt/diagnostic-render.ts";

let passed = 0;
function check(name, fn) {
	try { fn(); passed++; } catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
	try { await fn(); passed++; } catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
}
const dir = mkdtempSync(join(tmpdir(), "diagnostics-fixture-"));
const py = join(dir, "bad.py"), sh = join(dir, "bad.sh"), ts = join(dir, "bad.ts");
try {
	mkdirSync(join(dir, ".pi"));
	for (const file of [py, sh, ts]) writeFileSync(file, "x\n");
	check("byte-cap read banner is reattached byte-exact after annotation", () => {
		const banner = "[Showing lines 1-2 of 4 (50.0KB limit). Use offset=3 to continue.]";
		const result = annotateSource(`a\nb\n${banner}`, "a\nb\nc\nd\n", 1, [{ file: py, line: 2, col: 1, severity: "warning", rule: "F401", message: "unused" }], 20);
		assert.ok(result !== undefined);
		assert.equal(result, `a\nb\n  ⚠ line 2 [F401] unused\n${banner}`);
	});
	check("defaults & disabled/invalid config", () => {
		const cfg = loadDiagnosticsConfig(dir);
		assert.equal(cfg.timeoutMs, 10000);
		assert.equal(cfg.maxFindings, 20);
		assert.ok(cfg.languages.includes("py"));
		assert.equal(normalizeDiagnosticsConfig({ enabled: false }), null);
		assert.equal(normalizeDiagnosticsConfig({ timeoutMs: -1 }), null);
		assert.equal(normalizeDiagnosticsConfig({ commands: { py: "echo {files}; rm -rf /" } }), null);
		assert.equal(normalizeDiagnosticsConfig({ commands: { py: "ruff check" } }), null);
		// linter binary allowlist: only biome / ruff / shellcheck may be executed
		assert.equal(parseCommand("biome check --reporter=json {files}")[0], "biome");
		assert.equal(parseCommand("node x.js {files}"), null);
		assert.equal(parseCommand("bash -c x {files}"), null);
		assert.equal(normalizeDiagnosticsConfig({ commands: { py: "node x.js {files}" } }), null);
		// auto-run linters must stay read-only: write/fix flags are rejected, --no-fix is not
		for (const bad of [
			"biome check --write {files}", "biome check --fix {files}", "biome check --apply {files}",
			"biome check --apply-unsafe {files}", "biome check --unsafe {files}", "biome check --write=true {files}",
			"ruff check --fix {files}", "ruff check --fix-only {files}", "ruff check --unsafe-fixes {files}",
			"ruff check --add-noqa {files}", "biome check --fix-all {files}",
		]) assert.equal(parseCommand(bad), null, bad);
		assert.deepEqual(parseCommand("ruff check --no-fix {files}"), ["ruff", "check", "--no-fix", "{files}"]);
		assert.ok(parseCommand("ruff check --fixable=E {files}"), "--fixable only selects rules");
		assert.equal(normalizeDiagnosticsConfig({ commands: { ts: "biome check --write {files}" } }), null);
	});
	check("config reread, overrides, broken config fails open", () => {
		const path = join(dir, ".pi", "diagnostics.json");
		writeFileSync(path, JSON.stringify({ timeoutMs: 250, languages: ["PY"], commands: { py: "ruff check {files}" } }));
		const cfg = loadDiagnosticsConfig(dir);
		assert.equal(cfg.timeoutMs, 250);
		assert.deepEqual(cfg.languages, ["py"]);
		assert.equal(cfg.commands.py, "ruff check {files}");
		writeFileSync(path, "{broken");
		assert.equal(loadDiagnosticsConfig(dir), null);
		writeFileSync(path, "{}");
	});
	check("Ruff fixture: missing severity is warning; invalid entries dropped", () => {
		const json = JSON.stringify([{ code: "F401", filename: py, location: { row: 1, column: 8 }, message: "unused\nimport" }, { code: "F401" }]);
		assert.deepEqual(parseDiagnostics("ruff", json, py), [{ file: py, line: 1, col: 8, severity: "warning", rule: "F401", message: "unused import" }]);
	});
	check("ShellCheck fixture: numeric SC code and style level", () => {
		const json = JSON.stringify([{ code: 2046, line: 2, column: 3, level: "style", message: "Quote this", file: sh }]);
		assert.deepEqual(parseDiagnostics("shellcheck", json, sh), [{ file: sh, line: 2, col: 3, severity: "info", rule: "SC2046", message: "Quote this" }]);
	});
	check("Biome fixture: 0-based coordinates and severity", () => {
		const json = JSON.stringify({ diagnostics: [{ range: { start: { line: 0, character: 5 } }, severity: "error", description: "Unused value", rule: { name: "noUnusedVariables" } }] });
		assert.deepEqual(parseDiagnostics("biome", json, ts), [{ file: ts, line: 1, col: 6, severity: "error", rule: "noUnusedVariables", message: "Unused value" }]);
		assert.equal(parseDiagnostics("biome", JSON.stringify({ diagnostics: [{ range: [0, 8], description: "wrong schema" }] }), ts), null);
	});
	check("Biome v2 fixture: location 1-based line/column (0 = file level), category, message", () => {
		const json = JSON.stringify({ diagnostics: [
			{ severity: "warning", message: "This variable unusedValue is unused.", category: "lint/correctness/noUnusedVariables", location: { path: "x.js", start: { line: 1, column: 7 }, end: { line: 1, column: 18 } } },
			{ severity: "error", message: "Undefined variable undeclaredThing.", category: "lint/correctness/noUndeclaredVariables", location: { path: "x.js", start: { line: 5, column: 11 } } },
			{ severity: "error", message: "Formatter would have printed the following content.", category: "format", location: { path: "x.js", start: { line: 0, column: 0 } } },
		] });
		assert.deepEqual(parseDiagnostics("biome", json, ts), [
			{ file: ts, line: 1, col: 7, severity: "warning", rule: "lint/correctness/noUnusedVariables", message: "This variable unusedValue is unused." },
			{ file: ts, line: 5, col: 11, severity: "error", rule: "lint/correctness/noUndeclaredVariables", message: "Undefined variable undeclaredThing." },
			{ file: ts, line: 0, col: 0, severity: "error", rule: "format", message: "Formatter would have printed the following content." },
		]);
	});
	check("empty valid JSON vs unusable JSON", () => {
		assert.deepEqual(parseDiagnostics("ruff", "[]", py), []);
		assert.equal(parseDiagnostics("ruff", "not json", py), null);
		assert.equal(parseDiagnostics("ruff", "{}", py), null);
	});
	await checkAsync("exit 1 JSON findings, no cross-call cache, command override", async () => {
		let count = 0;
		const cfg = normalizeDiagnosticsConfig({ commands: { py: "ruff check --output-format json {files}" } });
		const executor = async (bin, args, opts) => {
			count++;
			assert.equal(bin, "ruff");
			assert.deepEqual(args, ["check", "--output-format", "json", py]);
			assert.equal(opts.timeout, 10000);
			return { stdout: JSON.stringify([{ code: "F401", location: { row: 1, column: 1 }, message: String(count) }]), exitCode: 1 };
		};
		assert.equal((await lintFile(py, cfg, executor)).diagnostics[0].message, "1");
		assert.equal((await lintFile(py, cfg, executor)).diagnostics[0].message, "2");
		assert.equal(count, 2);
	});
	await checkAsync("empty success distinct from unavailable", async () => {
		const cfg = loadDiagnosticsConfig(dir);
		assert.deepEqual(await lintFile(py, cfg, async () => ({ stdout: "[]", exitCode: 0 })), { kind: "ok", diagnostics: [] });
		for (const failure of [new Error("ENOENT"), new Error("timeout")]) {
			assert.deepEqual(await lintFile(py, cfg, async () => { throw failure; }), { kind: "unavailable" });
		}
		assert.deepEqual(await lintFile(py, cfg, async () => ({ stdout: "bad", exitCode: 0 })), { kind: "unavailable" });
		assert.deepEqual(await lintFile(join(dir, "missing.py"), cfg, async () => { throw Error("called"); }), { kind: "unavailable" });
		assert.deepEqual(await lintFile(join(dir, "no.xyz"), cfg, async () => { throw Error("called"); }), { kind: "unavailable" });
	});
	await checkAsync("real execFile: JSON with exit 1, timeout and maxBuffer fail-open", async () => {
		// The allowlist restricts lint to known linter binaries, so the fake
		// linter is a PATH shadow of `ruff`; the mode comes from a state file.
		const state = join(dir, "fake-ruff-state");
		const fakeRuff = join(dir, "ruff");
		writeFileSync(fakeRuff, `#!/bin/sh
if [ "$(cat ${JSON.stringify(state)} 2>/dev/null)" = "hang" ]; then sleep 5; exit 0; fi
if [ "$(cat ${JSON.stringify(state)} 2>/dev/null)" = "overflow" ]; then yes x | head -c 2000100; exit 0; fi
printf '%s' '[{"code":"F401","location":{"row":1,"column":1},"message":"unused"}]'
exit 1
`);
		chmodSync(fakeRuff, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = dir + delimiter + process.env.PATH;
		try {
			writeFileSync(state, "ok");
			assert.equal((await lintFile(py, normalizeDiagnosticsConfig({}))).kind, "ok");
			writeFileSync(state, "hang");
			assert.deepEqual(await lintFile(py, normalizeDiagnosticsConfig({ timeoutMs: 80 })), { kind: "unavailable" });
			writeFileSync(state, "overflow");
			assert.deepEqual(await lintFile(py, normalizeDiagnosticsConfig({ timeoutMs: 1000 })), { kind: "unavailable" });
		} finally { process.env.PATH = savedPath; }
	});
	await checkAsync("oversized files skip without executor", async () => {
		const huge = join(dir, "huge.py");
		writeFileSync(huge, "x".repeat(2_000_001));
		assert.deepEqual(await lintFile(huge, loadDiagnosticsConfig(dir), async () => { throw Error("called"); }), { kind: "unavailable" });
	});
	console.log(`${passed} checks passed (live biome/ruff/shellcheck: SKIP when not installed)`);
} finally { rmSync(dir, { recursive: true, force: true }); }
