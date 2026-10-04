import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { diagnosticKey, newDiagnostics, renderDelta } from "./delta.ts";
import { detectRenames, parseRenameStatus, renderRenames } from "./rename.ts";
import { execFileSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
async function check(name, fn) { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}`, e); process.exitCode = 1; } }
const diag = (file, line, rule = "F401") => ({ file, line, col: 1, severity: "warning", rule, message: "unused" });
await check("pure delta identity/limit/render", () => {
	const a = diag("/x/a.py", 1), b = diag("/x/a.py", 2), c = diag("/x/a.py", 3);
	assert.equal(diagnosticKey(a), "/x/a.py\0" + "1\0F401");
	assert.deepEqual(newDiagnostics([a], [a, b, b, c], 1), [b]);
	assert.deepEqual(newDiagnostics([a], [], 20), []);
	assert.ok(renderDelta([b]).includes("/x/a.py:2 warning [F401]"));
});
await check("rename status parser, fake runner dedup + extensionless references", async () => {
	assert.deepEqual(parseRenameStatus("R100\ta.py\tb.py\nM\tother.py\nR085\tx.ts\ty.ts\n"), [
		{old:"a.py",new:"b.py"},{old:"x.ts",new:"y.ts"},
	]);
	// Git C-quotes paths with special characters (spaces → quoted in output).
	assert.deepEqual(parseRenameStatus('R100\t"old name.txt"\t"new name.txt"\n'), [{ old: "old name.txt", new: "new name.txt" }]);
	assert.deepEqual(parseRenameStatus('R100\t"tab\\\\here"\t"x"\n'), [{ old: "tab\\here", new: "x" }]);
	const commands = [];
	const run = async (args) => {
		commands.push(args);
		if (args.includes("diff")) return "R100\tsrc/a.ts\tsrc/b.ts\n";
		if (args.includes("grep")) return args.at(-1) === "a" ? "main.ts\x003\x00import x from './a'\n" : "";
		return "";
	};
	const found = await detectRenames("/tmp", run);
	assert.equal(found.length, 1);
	assert.deepEqual(found[0].references, ["main.ts:3"]);
	assert.equal(commands.filter(x => x.at(-1) === "a").length, 1);
	assert.ok(renderRenames(found).includes("src/a.ts → src/b.ts"));
	// egress surface (F4-sec): match-line CONTENT of the non-touched file must
	// not leak into the hint — only path:line is emitted.
	assert.ok(!renderRenames(found).includes("import x from"), "snippet content must not appear in hint output");
});
await check("rename fake git: C-quoted non-ASCII self-reference excluded, ASCII reference retained", async () => {
	const run = async (args) => {
		if (args.includes("diff")) return "R100\told.ts\t新.ts\n";
		if (args.includes("grep")) return "新.ts\x001\x00old\nold.ts\x002\x00old\nmain.ts\x003\x00old\n";
		return "";
	};
	const found = await detectRenames("/tmp", run);
	assert.equal(found.length, 1);
	assert.deepEqual(found[0].references, ["main.ts:3"]);
});
await check("rename real git: staged rename detected; pure mv untracked destination is outside scope", async () => {
	const root = mkdtempSync(join(tmpdir(), "ripple-git-"));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	try {
		git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "a.ts"), "export const value = 1;\n");
		writeFileSync(join(root, "main.ts"), "import x from './a';\n");
		git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "files");
		git("mv", "src/a.ts", "src/b.ts");
		const found = await detectRenames(root);
		assert.equal(found.length, 1);
		assert.equal(found[0].old, "src/a.ts");
		assert.ok(found[0].references.some(line => line === "main.ts:1"));
	} finally { rmSync(root, {recursive:true,force:true}); }
});
await check("rename real git: C-quoted paths (spaces) unquoted before git grep", async () => {
	const root = mkdtempSync(join(tmpdir(), "ripple-git-"));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	try {
		git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "old name.ts"), "export const value = 1;\n");
		writeFileSync(join(root, "main.ts"), "import './old name';\n");
		git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "files");
		git("mv", "src/old name.ts", "src/new name.ts");
		const found = await detectRenames(root);
		assert.equal(found.length, 1);
		assert.equal(found[0].old, "src/old name.ts");
		assert.equal(found[0].new, "src/new name.ts");
		assert.ok(found[0].references.some(line => line === "main.ts:1"));
	} finally { rmSync(root, {recursive:true,force:true}); }
});
await check("rename real git: colon in referencing path and `:N:` in content parse unambiguously (git grep -z)", async () => {
	const root = mkdtempSync(join(tmpdir(), "ripple-git-"));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	try {
		git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init");
		writeFileSync(join(root, "old.js"), "export {};\n");
		writeFileSync(join(root, "config:test.js"), "a\nimport './old.js'\n");
		writeFileSync(join(root, "notes.txt"), "see a:34:x old.js\n");
		git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "files");
		git("mv", "old.js", "new.js");
		const found = await detectRenames(root);
		assert.equal(found.length, 1);
		assert.deepEqual([...found[0].references].sort(), ["config:test.js:2", "notes.txt:1"]);
	} finally { rmSync(root, {recursive:true,force:true}); }
});
await check("rename skip filter: nudged renames cost no git grep and free the 5-slot cap", async () => {
	const greps = [];
	const run = async (args) => {
		if (args.includes("diff")) return Array.from({ length: 7 }, (_, i) => `R100\tf${i}.ts\tg${i}.ts\n`).join("");
		if (args.includes("grep")) { greps.push(args.at(-1)); return "main.ts\x001\x00x\n"; }
		return "";
	};
	const nudged = new Set(["f0.ts", "f1.ts", "f2.ts"]);
	const found = await detectRenames("/tmp", run, r => nudged.has(r.old));
	assert.deepEqual(found.map(r => r.old), ["f3.ts", "f4.ts", "f5.ts", "f6.ts"]);
	assert.ok(!greps.some(p => /^(f[012])(\.ts)?$/.test(p) || p === "f0.ts" || p === "f1.ts" || p === "f2.ts"), greps.join());
});
const { findPiDist } = await import("./pi-alias.mjs");
const piDist = findPiDist();
if (!piDist) console.log("SKIP integration: pi package not found");
else {
	register(pathToFileURL(join(here, "pi-alias.mjs")).href, { data: { piDist: pathToFileURL(piDist).href }, parentURL: import.meta.url });
	const { default: ripple } = await import("./index.ts");
	const dir = mkdtempSync(join(tmpdir(), "ripple-test-"));
	const savedPath = process.env.PATH;
	try {
		mkdirSync(join(dir, ".pi"));
		const file = join(dir, "a.py"), newFile = join(dir, "new.py"), state = join(dir, "state.json"), fakeRuff = join(dir, "ruff");
		// The allowlist restricts lint to known linter binaries, so the fake
		// linter is a PATH shadow of `ruff`; it cats the state verbatim.
		writeFileSync(file, "x=1\n"); writeFileSync(state, "[]");
		writeFileSync(fakeRuff, `#!/bin/sh\ncat ${JSON.stringify(state)}\n`);
		chmodSync(fakeRuff, 0o755);
		process.env.PATH = dir + delimiter + process.env.PATH;
		const registered = {};
		ripple({ on: (name, fn) => { registered[name] = fn; }, registerTool: () => { throw Error("no tools"); } });
		const ctx = { cwd: dir };
		const call = (id, path, toolName = "edit") => ({ type: "tool_call", toolName, toolCallId: id, input: { path } });
		const result = (id, path, toolName = "edit", isError = false) => ({ type: "tool_result", toolName, toolCallId: id, input: { path }, isError, content: [] });
		const turn = async () => await registered.turn_end({}, ctx);
		await check("no-op turn skips git diff; repeated rename is nudged once", async () => {
			const git = join(dir, "git");
			const log = join(dir, "git-calls");
			writeFileSync(git, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$*" in *diff*) printf 'R100\\told.py\\tnew.py\\n';; *grep*) printf 'ref.py\\0001\\0new.py\\n';; esac\n`);
			chmodSync(git, 0o755);
			assert.equal(await turn(), undefined);
			assert.equal(existsSync(log), false, "no-op must not invoke git");
			writeFileSync(state, "[]");
			for (let i = 0; i < 2; i++) {
				await registered.tool_call(call(`rename${i}`, "a.py"), ctx);
				registered.tool_result(result(`rename${i}`, "a.py"));
				const out = await turn();
				assert.equal(out?.entries.filter(e => e.customType === "ripple-rename").length ?? 0, i === 0 ? 1 : 0);
			}
			assert.equal(readFileSync(log, "utf8").split("\n").filter(line => line.includes(" diff ")).length, 4, "two diff variants each turn");
			rmSync(git);
		});
		await check("bash-only turn (git mv) still triggers rename detection", async () => {
			const git = join(dir, "git");
			const log = join(dir, "git-calls-bash");
			// distinct rename pair: the dedup set from the previous check is still live
			writeFileSync(git, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$*" in *diff*) printf 'R100\\told2.py\\tnew2.py\\n';; *grep*) printf 'ref2.py\\0001\\0new2.py\\n';; esac\n`);
			chmodSync(git, 0o755);
			await registered.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "bash-rename-1", input: { command: "git mv old2.py new2.py" } }, ctx);
			const out = await turn();
			const renames = out?.entries.filter(e => e.customType === "ripple-rename") ?? [];
			assert.equal(renames.length, 1, "bash-originated rename must still be nudged");
			rmSync(git);
		});
		await check("twenty lint targets run at most four concurrent linter processes", async () => {
			const counter = join(dir, "lint-counter");
			const peak = join(dir, "lint-peak");
			const script = `#!/bin/sh\nlock=${JSON.stringify(join(dir, "lint-lock"))}\nwhile ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done\nn=$(cat ${JSON.stringify(counter)}); n=$((n+1)); echo "$n" > ${JSON.stringify(counter)}\np=$(cat ${JSON.stringify(peak)}); if [ "$n" -gt "$p" ]; then echo "$n" > ${JSON.stringify(peak)}; fi\nrmdir "$lock"\nsleep 0.1\nwhile ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done\nn=$(cat ${JSON.stringify(counter)}); echo $((n-1)) > ${JSON.stringify(counter)}\nrmdir "$lock"\necho '[]'\n`;
			writeFileSync(fakeRuff, script); chmodSync(fakeRuff, 0o755);
			writeFileSync(counter, "0"); writeFileSync(peak, "0");
			for (let i = 0; i < 20; i++) {
				const path = `pool-${i}.py`;
				writeFileSync(join(dir, path), "x=1\n");
				await registered.tool_call(call(`pool-${i}`, path), ctx);
				registered.tool_result(result(`pool-${i}`, path));
			}
			await turn();
			assert.ok(Number(readFileSync(peak, "utf8")) <= 4);
			assert.ok(Number(readFileSync(peak, "utf8")) > 1);
			writeFileSync(fakeRuff, `#!/bin/sh\ncat ${JSON.stringify(state)}\n`); chmodSync(fakeRuff, 0o755);
		});
		await check("context retains the latest journaled hint for next user turn, retires older ones", () => {
			const u = () => ({role:"user",content:[]});
			const hint = () => ({role:"custom",customType:"ripple-delta",content:"hint"});
			assert.equal(registered.context({messages:[u(),hint(),u()]}), undefined);
			const trimmed = registered.context({messages:[u(),hint(),u(),hint(),u()]});
			assert.equal(trimmed.messages.filter(m => m.role === "custom").length, 1);
		});
		await check("successful edit takes pre-image before edit and reports only new findings", async () => {
			await registered.tool_call(call("a", "a.py"), ctx);
			writeFileSync(state, JSON.stringify([{code:"F401",location:{row:1,column:1},message:"unused"}]));
			assert.equal(registered.tool_result(result("a", "a.py")), undefined);
			const output = await turn();
			assert.equal(output.entries[0].customType, "ripple-delta");
			assert.ok(output.entries[0].content.includes("1 new diagnostic"));
			assert.equal(output.continue, undefined);
		});
		await check("preexisting diagnostics are not newly reported", async () => {
			await registered.tool_call(call("b", "a.py"), ctx);
			assert.equal(registered.tool_result(result("b", "a.py")), undefined);
			assert.equal(await turn(), undefined);
		});
		await check("failed edit never reports, next new-file write has empty baseline", async () => {
			writeFileSync(state, "[]");
			await registered.tool_call(call("c", "a.py"), ctx);
			writeFileSync(state, JSON.stringify([{code:"F401",location:{row:1,column:1},message:"unused"}]));
			registered.tool_result(result("c", "a.py", "edit", true));
			assert.equal(await turn(), undefined);
			await registered.tool_call(call("d", "new.py", "write"), ctx);
			writeFileSync(newFile, "x\n");
			registered.tool_result(result("d", "new.py", "write"));
			assert.ok((await turn()).entries[0].content.includes("new.py:1"));
		});
		await check("unavailable baseline skips delta and repeated edits retain earliest successful baseline", async () => {
			writeFileSync(state, "invalid json");
			await registered.tool_call(call("bad", "a.py"), ctx);
			writeFileSync(state, JSON.stringify([{code:"F841",location:{row:1,column:1},message:"unused"}]));
			registered.tool_result(result("bad", "a.py"));
			assert.equal(await turn(), undefined, "unavailable preimage must not become empty baseline");
			writeFileSync(state, "[]");
			await registered.tool_call(call("first", "a.py"), ctx);
			writeFileSync(state, JSON.stringify([{code:"F841",location:{row:1,column:1},message:"unused"}]));
			registered.tool_result(result("first", "a.py"));
			await registered.tool_call(call("second", "a.py"), ctx);
			registered.tool_result(result("second", "a.py"));
			assert.ok((await turn()).entries[0].content.includes("F841"));
		});
		await check("ripple config: disabled blocks delta; malformed config suppresses rename and lint", async () => {
			writeFileSync(join(dir, ".pi", "ripple.json"), JSON.stringify({enabled:false}));
			writeFileSync(state, "[]");
			await registered.tool_call(call("disabled", "a.py"), ctx);
			writeFileSync(state, JSON.stringify([{code:"F401",location:{row:1,column:1},message:"unused"}]));
			registered.tool_result(result("disabled", "a.py"));
			assert.equal(await turn(), undefined);
			rmSync(join(dir, ".pi", "ripple.json"));
		});
		await check("turn-end journal entry contains delta without forcing continuation", async () => {
			writeFileSync(state, "[]"); await registered.tool_call(call("e", "a.py"), ctx);
			writeFileSync(state, JSON.stringify([{code:"F841",location:{row:1,column:1},message:"new"}]));
			registered.tool_result(result("e", "a.py"));
			const out = await turn();
			assert.equal(out.entries.length, 1);
			assert.equal(out.entries[0].type, "custom_message");
			assert.ok(out.entries[0].content.includes("F841"));
			assert.equal(out.continue, undefined);
		});
	} finally { process.env.PATH = savedPath; rmSync(dir, { recursive: true, force: true }); }
}
console.log(`${passed} checks passed`);
