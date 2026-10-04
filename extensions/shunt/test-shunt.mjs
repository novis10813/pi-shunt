// Shunt tests — run with: node test-shunt.mjs
//
// Sections:
//   A. pure module tests (rules.ts, structure.ts, diagnostic-render.ts) — always run
//   B. integration tests (read hook + bash rule) —
//      needs the global pi package, resolved via pi-alias.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));

import {
	countLines,
	decideIntercept,
	detectBashReads,
	isTargetedPathSelector,
	isTargetedRead,
	looksLikeText,
	normalizeConfig,
	stripPathSelector,
} from "./rules.ts";
import { readStartLine, annotateSource, appendIndexDiagnostics } from "./diagnostic-render.ts";
import {
	buildCodeIndex,
	initStructureEngine,
	buildCsvProfile,
	buildJsonlProfile,
	buildMarkdownOutline,
	countSourceLines,
	detectKind,
	extensionOf,
	grammarForPath,
	renderCodeIndex,
	renderStructure,
} from "./structure.ts";

let passed = 0;
function report(name, err) {
	console.error(`FAIL: ${name}`);
	console.error(err.message);
	process.exitCode = 1;
}
function check(name, fn) {
	try {
		fn();
		passed++;
	} catch (err) {
		report(name, err);
	}
}
async function checkAsync(name, fn) {
	try {
		await fn();
		passed++;
	} catch (err) {
		report(name, err);
	}
}

// ---------------- A. rules.ts ----------------

check("normalizeConfig defaults and validation", () => {
	const baseLangs = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "sh"];
	assert.deepEqual(normalizeConfig({}), { minLines: 350, languages: baseLangs });
	assert.deepEqual(normalizeConfig({ minLines: 500 }), { minLines: 500, languages: baseLangs });
	assert.deepEqual(normalizeConfig({ minLines: -5 }), { minLines: 350, languages: baseLangs });
	assert.equal(normalizeConfig(null), undefined);
});

check("minLines fractional and invalid values never become zero", () => {
 // Clamp semantics: any finite non-negative value floors to >= 1 (0 and 0.5 both → 1);
 // negative / non-number / non-finite are invalid → default (fail-open).
 assert.equal(normalizeConfig({ minLines: 0.5 }).minLines, 1);
 assert.equal(normalizeConfig({ minLines: 0 }).minLines, 1);
 assert.ok(normalizeConfig({ minLines: -3 }).minLines >= 1);
 assert.ok(normalizeConfig({ minLines: 'abc' }).minLines >= 1);
 assert.ok(normalizeConfig({ minLines: NaN }).minLines >= 1);
});

check("isTargetedPathSelector mirrors the read-selector grammar", () => {
	for (const p of [
		"f.ts:50",
		"f.ts:50-100",
		"f.ts:50+100",
		"f.ts:5-16,960-973",
		"f.ts:50-", // open-ended
		"f.ts:5..10", // .. alias
		"f.ts:L5-10", // L prefix
		"f.ts:5-16:raw",
		"f.ts:raw:5-16",
	]) {
		assert.equal(isTargetedPathSelector(p), true, p);
	}
	for (const p of ["f.ts", "f.ts:raw", "f.ts:conflicts", "f.ts:abc", "f.ts:", "C:\\x\\y.txt"]) {
		assert.equal(isTargetedPathSelector(p), false, p);
	}
});

check("selector grammar has one source: readStartLine never accepts what stripPathSelector would not strip", () => {
	const tails = ["5", "L5", "5-9", "L5-L9", "5+3", "5-", "5..", "5..9", "9-5", "5+", "+5", "L", "5-9-", "5.9", "5,9", "0", "abc", "5:", "raw", "5:raw", "raw:5", "5:6"];
	for (const tail of tails) {
		const raw = `no-such-file.ts:${tail}`;
		const stripped = stripPathSelector(raw) !== raw;
		const start = readStartLine({ path: raw }, "/nonexistent/literal");
		// A tail the gate does not strip is part of the path (whole-file mapping, line 1),
		// never a selector-derived start line.
		if (!stripped) assert.equal(start, 1, `${raw}: not a selector, so it must map as a plain path`);
	}
	assert.equal(readStartLine({ path: "no-such-file.ts:5+" }, "/nonexistent/literal"), 1);
	assert.equal(readStartLine({ path: "no-such-file.ts:L5-L9" }, "/nonexistent/literal"), 4);
});
check("stripPathSelector peels selector tails", () => {
	assert.equal(stripPathSelector("f.ts:5-16:raw"), "f.ts");
	assert.equal(stripPathSelector("f.ts:raw:5-16"), "f.ts");
	assert.equal(stripPathSelector("f.ts:raw"), "f.ts");
	assert.equal(stripPathSelector("f.ts:5-16"), "f.ts");
	assert.equal(stripPathSelector("f.ts"), "f.ts");
	assert.equal(stripPathSelector("C:\\x\\y.txt"), "C:\\x\\y.txt");
	assert.equal(stripPathSelector("file with:colon.txt"), "file with:colon.txt");
});

check("isTargetedRead", () => {
	assert.equal(isTargetedRead({ path: "f" }), false);
	assert.equal(isTargetedRead({ path: "f:raw" }), false); // raw alone is a full read
	assert.equal(isTargetedRead({ path: "f", offset: 10 }), true);
	assert.equal(isTargetedRead({ path: "f", limit: 5 }), true);
	assert.equal(isTargetedRead({ path: "f:10-20" }), true);
});

check("countLines", () => {
	assert.equal(countLines(Buffer.alloc(0)), 0);
	assert.equal(countLines(Buffer.from("a")), 1);
	assert.equal(countLines(Buffer.from("a\n")), 1);
	assert.equal(countLines(Buffer.from("a\nb")), 2);
	assert.equal(countLines(Buffer.from("a\nb\n")), 2);
});

check("looksLikeText", () => {
	assert.equal(looksLikeText(Buffer.from("hello\nworld")), true);
	assert.equal(looksLikeText(Buffer.from("ab\x00cd")), false);
});

check("decideIntercept", () => {
	const small = Buffer.from(`${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")}\n`);
	const big = Buffer.from(`${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}\n`);
	const binary = Buffer.concat([Buffer.from([0, 1, 2]), big]);
	assert.equal(decideIntercept({ path: "f" }, small, 350).intercept, false);
	assert.equal(decideIntercept({ path: "f" }, big, 350).intercept, true);
	assert.equal(decideIntercept({ path: "f:10-20" }, big, 350).intercept, false);
	assert.equal(decideIntercept({ path: "f", offset: 1 }, big, 350).intercept, false);
	assert.equal(decideIntercept({ path: "f" }, binary, 350).intercept, false);
	// above sizeCap → not intercepted
	const huge = Buffer.concat([big, Buffer.alloc(2_000_001 - big.length + 100, 0x61)]);
	assert.equal(decideIntercept({ path: "f" }, huge, 350, 2_000_000).intercept, false);
});

check("detectBashReads: blocking cases", () => {
	const minLines = 350;
	const expectHit = (command) => {
		const hits = detectBashReads(command, minLines);
		assert.ok(hits.length >= 1, `expected hit for: ${command}`);
		assert.ok(hits.some((h) => h.file === "big.txt"), `expected big.txt in hits for: ${command}`);
	};
	expectHit("cat big.txt");
	expectHit("cat small.txt big.txt");
	expectHit("less big.txt");
	expectHit("more big.txt");
	expectHit("FOO=bar cat big.txt");
	expectHit("head -n 500 big.txt");
	expectHit("head -500 big.txt");
	expectHit("tail -n 400 big.txt");
	expectHit("cat big.txt && echo done");
	// stderr redirections must not pass through (stdout still dumps)
	expectHit("cat big.txt 2>/dev/null");
	expectHit("cat big.txt 2>&1");
	expectHit("cat big.txt 2>>/tmp/log");
	// multi-line commands: a read on a later line is still caught
	expectHit("echo hi\ncat big.txt");
	expectHit("cat big.txt && echo done\nhead -n 5 other.txt");
	// head/tail with a large explicit BYTE count
	expectHit("head -c 1000000 big.txt");
	expectHit("head -c1000000 big.txt");
	expectHit("head --bytes=2000000 big.txt");
	expectHit("tail -c 5000000 big.txt");
	// wrappers: xargs / sudo / subshell are still detected
	expectHit("xargs cat big.txt");
	expectHit("sudo cat big.txt");
	expectHit("(cat big.txt)");
	// backslash-continuation lines are one command
	expectHit("cat big.txt \\\n 2>/dev/null");
	// stdin redirect: the file argument is still probed
	expectHit("cat < big.txt");
	expectHit("cat<big.txt");
	expectHit("cat file<big.txt");
	// head -n -N means "all but the last N lines" → unbounded (GNU-verified).
	// tail -n -N means "last N lines" (bounded) — covered in the sign-aware cases.
	expectHit("head -n -5 big.txt");
	expectHit("head --lines=-300 big.txt");
	// quoted arguments are tokenized as one token
	expectHit('cat "big.txt"');
	expectHit('"cat" big.txt');
	// an unbounded trailing reader dumps whatever the earlier parts read
	expectHit("cat big.txt | cat");
	expectHit("cat big.txt | more");
	expectHit("cat big.txt | head -n 500");
	// command substitution: output enters context through the parent command
	expectHit('echo "$(cat big.txt)"');
	expectHit("echo `cat big.txt`");
});

await checkAsync("buildCodeIndex deletes parsed trees on success and early rejection", async () => {
	const engine = await initStructureEngine();
	assert.ok(engine);
	const parse = engine.parse;
	let deleted = 0;
	engine.parse = (grammar, source) => {
		const tree = parse(grammar, source);
		if (!tree) return tree;
		const originalDelete = tree.delete.bind(tree);
		tree.delete = () => { deleted++; originalDelete(); };
		return tree;
	};
	try {
		assert.ok(await buildCodeIndex("function good() { return 1; }\n", "typescript"));
		assert.equal(await buildCodeIndex("@!\n".repeat(100), "typescript"), undefined);
		assert.equal(deleted, 2);
	} finally { engine.parse = parse; }
});
check("detectBashReads: stderr redirect targets are not input files", () => {
	for (const command of ["less small.txt 2>err.log", "less small.txt 2>>err.log", "less small.txt 2> err.log", "less small.txt 2>&1", "less small.txt 2>&2"]) {
		assert.deepEqual(detectBashReads(command, 350), [{ command: "less", file: "small.txt" }], command);
	}
});
check("detectBashReads: quoted path arguments", () => {
	const minLines = 350;
	// candidate with the quote removed (the size decision happens in index.ts)
	assert.deepEqual(detectBashReads('cat "small file.txt"', minLines), [{ command: "cat", file: "small file.txt" }]);
	assert.ok(detectBashReads('head -n 500 "big file.txt"', minLines).some((h) => h.file === "big file.txt"));
});

check("detectBashReads: pass-through cases (v2 additions)", () => {
	const minLines = 350; // byte cap = 28_000
	const expectNone = (command) => {
		assert.deepEqual(detectBashReads(command, minLines), [], command);
	};
	// stdout redirection still passes through (with or without stderr dup)
	expectNone("cat big.txt > out.txt");
	expectNone("cat big.txt > out.txt 2>&1");
	// small explicit byte counts are targeted
	expectNone("head -c 10000 big.txt");
	expectNone("head --bytes=28000 big.txt");
	expectNone("tail -c 100 big.txt");
	// mixed: bounded lines + bounded bytes
	expectNone("head -n 10 -c 10000 big.txt");
	// xargs with no literal file argument (input comes from the pipe)
	expectNone("find . | xargs cat");
	// negative byte counts are "last N bytes" (valid for tail) → bounded by magnitude
	expectNone("tail -c -100 big.txt");
	expectNone("head -c 100 big.txt");
	// tail -n/-c +N reads from position N to EOF (GNU-verified: `tail -n +400`
	// on 10,000 lines → 9,601 lines; `tail -c +500` on 2,000 bytes → 1,501 bytes)
	// → unbounded regardless of N, on either side of minLines.
	// head -n +N ≡ head -n N (GNU-verified): budget-checked like plain N
	expectNone("head -n +10 big.txt");
	// tail -n -N = last N lines (GNU-verified) → bounded by magnitude
	expectNone("tail -n -100 big.txt");
	expectNone("tail --lines=-100 big.txt");
	assert.ok(detectBashReads("head -c -100 big.txt", minLines).length);
	assert.ok(detectBashReads("tail -n +100 big.txt", minLines).length);
	assert.ok(detectBashReads("tail --lines=+100 big.txt", minLines).length);
	for (const cmd of [
		"tail -n +400 big.txt", "tail -n +100 big.txt", "tail -n +1 big.txt", "tail --lines=+400 big.txt",
		"tail -n+400 big.txt", "tail -c +500 big.txt", "tail -c +5 big.txt", "tail --bytes=+500 big.txt", "tail -c+500 big.txt",
	]) assert.equal(detectBashReads(cmd, minLines).length, 1, cmd);
	// attached forms are parsed like the spaced ones (no bypass via `-nN` / `-cN`)
	assert.equal(detectBashReads("head -n900 big.txt", minLines).length, 1);
	assert.equal(detectBashReads("tail -n-400 big.txt", minLines).length, 1);
	assert.equal(detectBashReads("head -c-100 big.txt", minLines).length, 1);
	expectNone("head -n10 big.txt");
	expectNone("tail -n-100 big.txt");
	expectNone("head -c+100 big.txt");
	// same 900-line output as blocked `head -n 900` — no surface-form bypass
	assert.ok(detectBashReads("head -n +900 big.txt", minLines).length);
	assert.ok(detectBashReads("head -n -100 big.txt", minLines).length);
	assert.ok(detectBashReads("tail -n -400 big.txt", minLines).length);
	// bounded head on stdin stays bounded; substitution with a bounded reader
	expectNone("cat big.txt | head");
	expectNone("echo $(head -n 10 big.txt)");
});

check("detectBashReads: pass-through cases", () => {
	const minLines = 350;
	// NOTE: small files are still candidates here — the size decision happens in
	// index.ts after stat. Pass-through for small files is covered by the
	// integration bash-rule tests below.
	const expectNoHit = (command) => {
		const hits = detectBashReads(command, minLines);
		assert.deepEqual(hits, [], `expected no hit for: ${command} — got ${JSON.stringify(hits)}`);
	};
	expectNoHit("cat big.txt | grep x"); // piped: not the last pipeline part
	expectNoHit("grep x small.txt | cat"); // cat on stdin
	expectNoHit("cat big.txt > out.txt"); // redirected: output does not enter context
	expectNoHit("cat big.txt >> out.txt");
	expectNoHit("cat big.txt 2>&1 | x");
	expectNoHit("head big.txt"); // default 10 lines
	expectNoHit("head -n 10 big.txt");
	expectNoHit("head -10 big.txt");
	expectNoHit("tail -n 20 big.txt");
	expectNoHit("tail -20 big.txt");
	expectNoHit("head --lines=5 big.txt");
	expectNoHit("echo hi");
	expectNoHit("git status");
	expectNoHit("git cat-file -p HEAD");
});

check("detectBashReads: nonexistent file is still a candidate (caller stats it)", () => {
	const hits = detectBashReads("cat missing-file.txt", 350);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].file, "missing-file.txt");
});

check("detectBashReads: plain cat is a candidate regardless of size (caller stats it)", () => {
	assert.deepEqual(detectBashReads("cat small.txt", 350), [{ command: "cat", file: "small.txt" }]);
});

// ---------------- A2. structure.ts (v2 deterministic engines) ----------------

check("detectKind matrix", () => {
	const cases = [
		["a.ts", "code"], ["a.TS", "code"], ["a.tsx", "code"], ["a.jsx", "code"],
		["a.mjs", "code"], ["a.cjs", "code"], ["a.py", "code"], ["a.rs", "code"],
		["a.go", "code"], ["a.sh", "code"],
		["a.md", "markdown"], ["a.markdown", "markdown"],
		["a.csv", "csv"], ["a.tsv", "csv"],
		["a.jsonl", "jsonl"], ["a.ndjson", "jsonl"],
		["a.json", "other"], ["a.txt", "other"], ["Makefile", "other"], [".gitignore", "other"],
		["dir/foo.bar.ts", "code"], ["/x/y.Foo", "other"],
		// `languages` shrinks the code set
		["a.py", "other", ["ts"]], ["a.js", "other", ["ts"]], ["a.ts", "code", ["ts"]],
	];
	for (const [p, want, langs] of cases) {
		assert.equal(detectKind(p, langs), want, `detectKind(${p})`);
	}
});

check("extensionOf / grammarForPath", () => {
	assert.equal(extensionOf("/x/y.Foo.Bar"), "bar");
	assert.equal(extensionOf("x/y"), "");
	assert.equal(extensionOf(".env"), "");
	assert.equal(grammarForPath("a.TS"), "typescript");
	assert.equal(grammarForPath("a.jsx"), "tsx");
	assert.equal(grammarForPath("a.sh"), "bash");
	assert.equal(grammarForPath("a.json"), undefined);
	assert.equal(grammarForPath("a.py", ["ts"]), undefined);
});

check("normalizeConfig: languages", () => {
	const def = normalizeConfig({});
	assert.deepEqual(def?.languages, ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "sh"]);
	assert.deepEqual(normalizeConfig({ languages: ["TS", " ts ", "py", "py"] })?.languages, ["ts", "py"]);
	assert.deepEqual(normalizeConfig({ languages: "ts" })?.languages, def?.languages);
	assert.deepEqual(normalizeConfig({ languages: [1, 2] })?.languages, def?.languages);
	assert.deepEqual(normalizeConfig({ languages: [] })?.languages, []);
});

await checkAsync("code index: oversized first class retains forty members and omission marker", async () => {
	const source = `class Giant {\n${Array.from({ length: 450 }, (_, i) => `  method${i}() {}`).join("\n")}\n}`;
	const ci = await buildCodeIndex(source, "typescript");
	assert.ok(ci);
	assert.equal(ci.entries.length, 1);
	assert.equal(ci.entries[0].name, "Giant");
	assert.equal(ci.entries[0].members.length, 41);
	assert.match(renderCodeIndex(ci).at(-1), /\+410 more members/);
});

await checkAsync("code index: typescript (imports, lines, members)", async () => {
	const ts = [
		'import { alpha, beta } from "./lib";',
		'import type { Foo } from "./types";',
		"",
		"export function firstFunction(a: number): number {",
		"\treturn a + 1;",
		"}",
		"",
		"export class Widget {",
		"\tcount = 0;",
		"",
		"\tconstructor(public label: string) {",
		"\t\tthis.count = 1;",
		"\t}",
		"",
		"\tincrement(): number {",
		"\t\tthis.count += 1;",
		"\t\treturn this.count;",
		"\t}",
		"}",
		"",
		"const thirdFunction = (): number => 42;",
	].join("\n");
	const ci = await buildCodeIndex(ts, "typescript");
	assert.ok(ci);
	assert.deepEqual(ci.imports?.names, ["./lib", "./types"]);
	assert.equal(ci.imports?.first, 1);
	assert.equal(ci.imports?.last, 2);
	assert.deepEqual(
		ci.entries.map((e) => [e.name, e.kind, e.start, e.end]),
		[
			["firstFunction", "function", 4, 6],
			["Widget", "class", 8, 19],
			["thirdFunction", "const", 21, 21],
		],
	);
	// full signatures: params + return type, never truncated
	assert.equal(ci.entries[0].signature, "(a: number): number");
	assert.equal(ci.entries[1].signature, undefined); // classes have no signature
	assert.equal(ci.entries[2].signature, "(): number"); // arrow in const
	assert.deepEqual(ci.entries[1].members, [
		{ name: "count", kind: "field", start: 9, end: 9 }, // untyped field: no signature
		{ name: "constructor", kind: "method", start: 11, end: 13, signature: "(public label: string)" },
		{ name: "increment", kind: "method", start: 15, end: 18, signature: "(): number" },
	]);
	assert.equal(ci.omitted, 0);
});

await checkAsync("code index: python (imports, class members, signatures)", async () => {
	const py = [
		"import os",
		"from collections import deque",
		"",
		"def alpha():",
		"\treturn 1",
		"",
		"class Beta:",
		"\tx = 1",
		"\ty: int = 2",
		"",
		"\tdef method_a(self):",
		"\t\treturn self.x",
		"",
		"def annotated(a: int, b: str = \"x\") -> list[int]:",
		"\treturn []",
	].join("\n");
	const ci = await buildCodeIndex(py, "python");
	assert.ok(ci);
	assert.deepEqual(ci.imports?.names, ["os", "collections"]);
	assert.equal(ci.imports?.first, 1);
	assert.equal(ci.imports?.last, 2);
	assert.deepEqual(ci.entries.map((e) => [e.name, e.kind, e.start, e.end]), [
		["alpha", "function", 4, 5],
		["Beta", "class", 7, 12],
		["annotated", "function", 14, 15],
	]);
	assert.equal(ci.entries[0].signature, "()");
	assert.equal(ci.entries[2].signature, "(a: int, b: str = \"x\") -> list[int]");
	assert.deepEqual(ci.entries[1].members, [
		{ name: "x", kind: "field", start: 8, end: 8 },
		{ name: "y", kind: "field", start: 9, end: 9, signature: ": int" },
		{ name: "method_a", kind: "method", start: 11, end: 12, signature: "(self)" },
	]);
	// local variables inside a function are NOT members (spec: classes only)
	assert.deepEqual(ci.entries[0].members, []);
});

await checkAsync("code index: python decorated defs (top-level + member) + bare import", async () => {
	const py = [
		"import os.path as osp",
		"",
		"@dataclass",
		"class Point:",
		"    x: int",
		"",
		"    @property",
		"    def norm(self):",
		"        return 1",
		"",
		"@app.route('/p')",
		"def handler():",
		"    return 'ok'",
	].join("\n");
	const ci = await buildCodeIndex(py, "python");
	assert.ok(ci);
	assert.deepEqual(ci.imports?.names, ["os.path"]);
	// range starts at the decorator line (wrapper row)
	assert.deepEqual(ci.entries.map((e) => [e.name, e.kind, e.start, e.end]), [
		["Point", "class", 3, 9],
		["handler", "function", 11, 13],
	]);
	assert.deepEqual(
		ci.entries[0].members.map((m) => [m.name, m.kind]),
		[
			["x", "field"],
			["norm", "method"], // @property-decorated method inside the class
		],
	);
});

await checkAsync("code index: go interface members + raw string import", async () => {
	const go = [
		"package main",
		"",
		"import (`fmt`)",
		"",
		"type Handler interface {",
		"\tServe(w string, n int)",
		"\tName() string",
		"}",
	].join("\n");
	const cgo = await buildCodeIndex(go, "go");
	assert.ok(cgo);
	assert.deepEqual(cgo.imports?.names, ["fmt"]);
	const h = cgo.entries.find((e) => e.name === "Handler");
	assert.ok(h);
	assert.equal(h.kind, "type");
	assert.deepEqual(
		h.members.map((m) => [m.name, m.kind, m.signature]),
		[
			["Serve", "method", "(w string, n int)"],
			["Name", "method", "() string"],
		],
	);
});

await checkAsync("code index: rust + go + bash", async () => {
	const rs = [
		"use std::collections::HashMap;",
		"use self::foo;",
		"pub struct Point { pub x: i32, pub y: i32 }",
		"pub fn main() {}",
	].join("\n");
	const crs = await buildCodeIndex(rs, "rust");
	assert.ok(crs);
	assert.deepEqual(crs.imports?.names, ["std", "self"]);
	assert.deepEqual(crs.entries.map((e) => [e.name, e.kind]), [
		["Point", "struct"],
		["main", "function"],
	]);
	assert.equal(crs.entries[1].signature, "()");
	assert.deepEqual(crs.entries[0].members, [
		{ name: "x", kind: "field", start: 3, end: 3, signature: ": i32" },
		{ name: "y", kind: "field", start: 3, end: 3, signature: ": i32" },
	]);

	const go = [
		"package main",
		"",
		'import ("fmt"; "os")',
		"",
		"func Add(a int, b int) int { return a + b }",
		"",
		"type Server struct { Name string; Port int }",
	].join("\n");
	const cgo = await buildCodeIndex(go, "go");
	assert.ok(cgo);
	assert.deepEqual(cgo.imports?.names, ["fmt", "os"]);
	assert.deepEqual(cgo.entries.map((e) => [e.name, e.kind]), [
		["Add", "function"],
		["Server", "type"],
	]);
	assert.equal(cgo.entries[0].signature, "(a int, b int) int"); // native Go syntax, no colon
	assert.deepEqual(cgo.entries[1].members, [
		{ name: "Name", kind: "field", start: 7, end: 7, signature: ": string" },
		{ name: "Port", kind: "field", start: 7, end: 7, signature: ": int" },
	]);

	const sh = ["#!/bin/bash", "", "deploy() { echo hi; }", "echo done", ""].join("\n");
	const csh = await buildCodeIndex(sh, "bash");
	assert.ok(csh);
	assert.deepEqual(csh.entries.map((e) => [e.name, e.kind, e.start, e.end]), [
		["deploy", "function", 3, 3],
	]);
	assert.equal(csh.entries[0].signature, undefined); // bash: no type system
});

await checkAsync("code index: rust impl/trait methods + go receiver", async () => {
	const rs = [
		"trait Tr {",
		"    fn m(&self) -> bool;",
		"}",
		"",
		"impl Widget {",
		"    fn a(&self) -> i32 { 1 }",
		"    fn b(&mut self) {}",
		"}",
	].join("\n");
	const c = await buildCodeIndex(rs, "rust");
	assert.ok(c);
	assert.deepEqual(c.entries.map((e) => [e.name, e.kind]), [
		["Tr", "trait"],
		["impl Widget", "impl"],
	]);
	assert.deepEqual(c.entries[0].members, [
		{ name: "m", kind: "method", start: 2, end: 2, signature: "(&self) -> bool" },
	]);
	assert.deepEqual(c.entries[1].members.map((m) => [m.name, m.signature]), [
		["a", "(&self) -> i32"],
		["b", "(&mut self)"],
	]);
	// trait impl blocks keep the trait in the name
	const rs2 = "trait T { fn f(&self); }\nstruct W;\nimpl T for W { fn f(&self) {} }";
	const c2 = await buildCodeIndex(rs2, "rust");
	assert.ok(c2);
	assert.deepEqual(c2.entries.map((e) => e.name), ["T", "W", "impl T for W"]);
	// go: method receiver is a leading parameter_list, not dropped or duplicated
	const go2 = "type S struct{}\nfunc (s *S) Start(ctx context.Context) error { return nil }";
	const cg = await buildCodeIndex(go2, "go");
	assert.ok(cg);
	assert.equal(cg.entries[1].name, "Start");
	assert.equal(cg.entries[1].signature, "(s *S) (ctx context.Context) error");
});

await checkAsync("code index: error-ratio threshold + budget", async () => {
	// 40/40 garbage lines → >10% → undefined
	const garbage = Array.from({ length: 40 }, (_, i) => `@@@ ### line ${i} ???`).join("\n");
	assert.equal(await buildCodeIndex(garbage, "typescript"), undefined);
	// 3 bad of 33 lines (9.1%) → still indexed
	const mostlyOk = [
		"function ok() { return 1; }",
		...Array.from({ length: 29 }, (_, i) => `const c${i} = ${i};`),
		"###",
		"###",
		"###",
	].join("\n");
	const mo = await buildCodeIndex(mostlyOk, "typescript");
	assert.ok(mo, "9.1% error lines must still index");
	assert.ok(mo.errorLines <= 3);
	// backstop: 410 top-level consts → 400 kept + marker
	const big = Array.from({ length: 410 }, (_, i) => `const c${i} = ${i};`).join("\n");
	const cbig = await buildCodeIndex(big, "typescript");
	assert.ok(cbig);
	assert.equal(cbig.entries.length, 400);
	assert.equal(cbig.omitted, 10);
	assert.equal(cbig.totalEntries, 410);
	const body = renderCodeIndex(cbig);
	assert.equal(body.at(-1), "… +10 more entries（total 410；用 targeted read 取精確內容）");
});

check("markdown outline (fence-aware, budget, no-heading)", () => {
	const md = [
		"# Title", "", "## A", "```", "# not a heading", "```", "", "#### Deep", "", "### B",
		"no trailing newline",
	].join("\n");
	assert.deepEqual(buildMarkdownOutline(md), [
		"# Title [1]",
		"## A [3]",
		"#### Deep [8]",
		"### B [10]",
	]);
	assert.equal(buildMarkdownOutline("plain\n\nno headings"), undefined);
	assert.equal(buildMarkdownOutline(""), undefined);
	const bigMd = Array.from({ length: 110 }, (_, i) => `## H${i}`).join("\n");
	const out = buildMarkdownOutline(bigMd);
	assert.ok(out);
	assert.equal(out.length, 101);
	assert.equal(out.at(-1), "… +10 more entries（total 110；用 targeted read 取精確內容）");
});

check("markdown fences: close on same-char fence at least as long, no closing info string", () => {
 assert.deepEqual(buildMarkdownOutline("````js\n```\n# hidden\n````js\n# still hidden\n````\n# shown"), ["# shown [7]"]);
 // CommonMark: a 4-tick line closes a 3-tick open fence (at least as long).
 assert.deepEqual(buildMarkdownOutline("```\ncode\n````\n# shown"), ["# shown [4]"]);
});
check("CSV quoted newlines remain within a single field and row", () => {
 assert.deepEqual(buildCsvProfile('a,"b\n c",d\n1,2,3\n', ","), ["CSV — 1 rows, 3 columns:", "Fields: a, b\n c, d", "Sample:", "  1,2,3"]);
});

check("csv/tsv profile (empty, header-only, fields, sample truncation)", () => {
	assert.deepEqual(buildCsvProfile("a,b,c\n1,2,3\n4,5,6\n7,8,9\n", ","), [
		"CSV — 3 rows, 3 columns:",
		"Fields: a, b, c",
		"Sample:",
		"  1,2,3",
		"  4,5,6",
		"  7,8,9",
	]);
	assert.deepEqual(buildCsvProfile("", ","), ["CSV — 0 rows, 0 columns:"]);
	assert.deepEqual(buildCsvProfile("a,b,c\n", ","), [
		"CSV — 0 rows, 3 columns:",
		"Fields: a, b, c",
	]);
	// >20 fields → capped with (+N)
	const wideCsv =
		Array.from({ length: 25 }, (_, i) => `f${i}`).join(",") +
		"\n" +
		Array.from({ length: 25 }, (_, i) => String(i)).join(",") +
		"\n";
	const wcsv = buildCsvProfile(wideCsv, ",");
	assert.equal(wcsv?.[1], `Fields: ${Array.from({ length: 20 }, (_, i) => `f${i}`).join(", ")} (+5)`);
	// tsv delimiter
	assert.equal(buildCsvProfile("x\ty\tz\n1\t2\t3\n", "\t")[1], "Fields: x, y, z");
	// quote-aware column counting
	assert.equal(buildCsvProfile('a,"b,c",d\n', ",")[1], "Fields: a, b,c, d");
	// sample row truncated at 80 chars (+ "…")
	const longCsv = `a,b\n1,${"x".repeat(120)}\n`;
	assert.equal(buildCsvProfile(longCsv, ",")[3].length, 2 + 80 + 1);
});

check("jsonl profile (keys, failure rate, truncation)", () => {
	const j = buildJsonlProfile('{"a":1,"b":2}\n{"b":3,"c":4}\n{"d":5}\n');
	assert.ok(j);
	assert.equal(j[0], "JSONL — 3 rows; keys in first 100 rows: a, b, c, d:");
	assert.equal(j[1], "Sample:");
	assert.equal(j[2], '  {"a":1,"b":2}');
	assert.equal(j[3], '  {"b":3,"c":4}');
	// >20 keys → capped with (+N)
	const jk = buildJsonlProfile(Array.from({ length: 25 }, (_, i) => `{"k${i}":1}`).join("\n"));
	assert.ok(jk);
	assert.equal(
		jk[0],
		"JSONL — 25 rows; keys in first 100 rows: " +
			Array.from({ length: 20 }, (_, i) => `k${i}`).join(", ") +
			" (+5):",
	);
	// >10% failing lines → undefined; exactly 10% (1/10) → kept
	assert.equal(buildJsonlProfile('{"a":1}\nx\ny\nz\n'), undefined);
	assert.ok(buildJsonlProfile(Array.from({ length: 9 }, (_, i) => `{"a":${i}}`).concat("bad").join("\n")));
	assert.equal(buildJsonlProfile(""), undefined);
	assert.equal(buildJsonlProfile("   \n\n  \n"), undefined);
	// sample row truncated at 120 chars
	const longJsonl = `{"a":"${"y".repeat(200)}"}\n{"b":1}\n`;
	assert.equal(buildJsonlProfile(longJsonl)[2].length, 2 + 120);
});

check("renderStructure: exact label + 40k char backstop", () => {
	const out = renderStructure("/x/big.ts", 1234, "tree-sitter", ["- a (function) [1-2]"]);
	assert.equal(
		out,
		'[shunt] STRUCTURE — not file content. "/x/big.ts" (1234 lines). Deterministic index (engine: tree-sitter).\n' +
			"For exact content, use a targeted read (offset/limit or a :range selector).\n\n" +
			"- a (function) [1-2]",
	);
	const mdOut = renderStructure("/x/notes.md", 50, "markdown", ["# T [1]"]);
	assert.ok(mdOut.includes("Deterministic index (engine: markdown)."));
	const huge = Array.from({ length: 6000 }, (_, i) => `- entry ${i} (function) [1-2] ${"x".repeat(40)}`);
	const capped = renderStructure("/x/huge.ts", 1, "tree-sitter", huge);
	assert.ok(capped.length <= 40_000 + 20, `len=${capped.length}`);
	assert.ok(capped.endsWith("… (truncated)"));
});

check("countSourceLines matches rules.ts countLines semantics", () => {
	assert.equal(countSourceLines("a\nb\n"), 2);
	assert.equal(countSourceLines("a\nb"), 2);
	assert.equal(countSourceLines(""), 0);
	assert.equal(countSourceLines("x"), 1);
});

check("diagnostic-render: selector context, offset priority and safe unsupported ranges", () => {
	assert.equal(readStartLine({ path: "/missing/a.py:50-100" }), 49);
	assert.equal(readStartLine({ path: "/missing/a.py:50+100", offset: 70 }), 49);
	assert.equal(readStartLine({ path: "/missing/a.py:50" }), 49);
	assert.equal(readStartLine({ path: "/missing/a.py:raw:50-100" }), 49);
	assert.equal(readStartLine({ path: "/missing/a.py:raw" }), 1);
	assert.equal(readStartLine({ path: "/missing/a.py", offset: 13 }), 13);
	assert.equal(readStartLine({ path: "/missing/a.py:1-5" }), 1);
	assert.equal(readStartLine({ path: "/missing/a.py:5-16,960-973" }), undefined);
	assert.equal(readStartLine({ path: "/missing/a.py:unrecognized" }), 1); // exact-source validation still required
});
check("diagnostic-render: precise source slice, caps and pass-through", () => {
	const d = { file: "/x/a.py", line: 2, col: 1, severity: "warning", rule: "F401", message: "unused" };
	assert.equal(annotateSource("a\nb\nc\n", "a\nb\nc\n", 1, [d], 20), "a\nb\n  ⚠ line 2 [F401] unused\nc\n");
	assert.equal(annotateSource("a\nb\n[truncated]", "a\nb\nc\n", 1, [d], 20), undefined);
	assert.equal(annotateSource("b\nc\n", "a\nb\nc\n", 1, [d], 20), undefined);
	assert.equal(annotateSource("a\nb\n", "a\nb\n", 1, [], 20), undefined);
	// The read tool's continuation banner is recognized and reattached, not treated as source.
	const banner = "[18 more lines in file. Use offset=384 to continue.]";
	assert.equal(annotateSource(`a\nb\n\n${banner}`, "a\nb\nc\nd\n", 1, [d], 20), `a\nb\n  ⚠ line 2 [F401] unused\n\n${banner}`);
	assert.equal(annotateSource(`a\nb\n${banner}\n`, "a\nb\nc\nd\n", 1, [d], 20), `a\nb\n  ⚠ line 2 [F401] unused\n${banner}\n`);
	assert.equal(annotateSource(`a\nb\n${banner}`, "a\nb\n", 1, [d], 20), `a\nb\n  ⚠ line 2 [F401] unused\n${banner}`);
	assert.equal(annotateSource(`a\nb\n\n${banner}`, "c\nd\ne\n", 1, [d], 20), undefined); // banner stripping must not mask a mismatch
	// The read tool's line/byte-limit banner form is recognized too.
	const banner2 = "[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]";
	assert.equal(annotateSource(`a\nb\n${banner2}\n`, "a\nb\nc\nd\n", 1, [d], 20), `a\nb\n  ⚠ line 2 [F401] unused\n${banner2}\n`);
	// File-level (line 0) diagnostics apply to the whole file: prepended.
	const d0 = { file: "/x/a.py", line: 0, col: 0, severity: "warning", rule: "format", message: "not formatted" };
	assert.equal(annotateSource("a\nb\n", "a\nb\nc\n", 1, [d0], 20), "  ⚠ line 0 [format] not formatted\na\nb\n");
	assert.equal(annotateSource("a\nb\n", "a\nb\nc\n", 1, [d0, d], 20), "  ⚠ line 0 [format] not formatted\na\nb\n  ⚠ line 2 [F401] unused\n");
	assert.equal(annotateSource("c\nd\n", "a\nb\nc\nd\n", 3, [d0], 20), "  ⚠ line 0 [format] not formatted\nc\nd\n");
	assert.equal(appendIndexDiagnostics("index", [d, d], 1), "index\n[shunt] DIAGNOSTICS (2):\n  2:1 warning [F401] unused\n  … +1 more");
});

// ---------------- B. integration (needs the global pi package) ----------------


const { findPiDist } = await import(pathToFileURL(join(here, "pi-alias.mjs")).href);
const piDist = findPiDist();

if (!piDist) {
	console.log(`\nSKIP integration: pi package not found (looked relative to ${process.execPath})`);
} else {
	register(pathToFileURL(join(here, "pi-alias.mjs")).href, {
		data: { piDist: pathToFileURL(piDist).href },
		parentURL: import.meta.url,
	});

	await import(pathToFileURL(piDist).href); // validates the alias target loads
	const { default: shuntExt } = await import(pathToFileURL(join(here, "index.ts")).href);

	// --- fixtures ---
	const fixtureDir = mkdtempSync(join(tmpdir(), "shunt-fixtures-"));
	mkdirSync(join(fixtureDir, ".pi"), { recursive: true });
	const lines = (n) => `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
	writeFileSync(join(fixtureDir, "small.txt"), lines(10));
	writeFileSync(join(fixtureDir, "x"), "export const x = 1;\n".repeat(400));
	writeFileSync(join(fixtureDir, "x:raw"), "literal small file\n");
	writeFileSync(join(fixtureDir, "big.txt"), lines(400));
	// 200k lines: exercises the bash probe's early exit (reports a lower bound, not the full count)
	writeFileSync(join(fixtureDir, "huge-lines.txt"), Array.from({ length: 200_000 }, (_, i) => `l${i + 1}`).join("\n"));
	writeFileSync(join(fixtureDir, "binary.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(lines(400))]));
	writeFileSync(
		join(fixtureDir, "img.png"),
		Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
	);
	writeFileSync(join(fixtureDir, ".pi", "shunt.json"), JSON.stringify({ minLines: 350 }));

	function makeFakePi() {
		const tools = {};
		const handlers = [];
		return {
			tools,
			handlers,
			pi: {
				registerTool: (t) => {
					tools[t.name] = t;
				},
				on: (name, fn) => handlers.push({ name, fn }),
				registerCommand: () => {},
			},
		};
	}

	const { tools, handlers, pi } = makeFakePi();
	shuntExt(pi);
	const ctx = { cwd: fixtureDir, hasUI: false, ui: { notify: () => {} } };

	const readHandler = handlers.find((h) => h.name === "tool_result");
	await checkAsync("literal colon path takes precedence over selector base", async () => {
  const r = await readHandler.fn({ toolName: "read", input: { path: "x:raw" }, content: [{ type: "text", text: "literal small file\n" }] }, ctx);
  assert.equal(r, undefined);
 });
	check("read: tool_result handler registered, and shunt registers no tools", () => {
		assert.ok(readHandler);
		assert.deepEqual(Object.keys(tools), []);
	});

	function readEvent(input, { isError = false } = {}) {
		return {
			type: "tool_result",
			toolCallId: "t",
			toolName: "read",
			input,
			content: [{ type: "text", text: "ORIGINAL-CONTENT" }],
			details: {},
			isError,
		};
	}

	// --- read rule: pass-through (hook returns undefined → original result kept) ---
	await checkAsync("read rule: pass-through cases are untouched", async () => {
		for (const input of [
			{ path: "small.txt" },
			{ path: "big.txt" }, // other file types are never intercepted
			{ path: "big.txt", offset: 10, limit: 5 },
			{ path: "big.txt:10-20" },
			{ path: "big.txt:raw:100-110" },
			{ path: "big.txt:50-" }, // open-ended range is targeted
			{ path: "binary.bin" },
			{ path: "img.png" },
			{ path: "missing.txt" },
			{ path: "subdir-does-not-exist" },
		]) {
			const r = await readHandler.fn(readEvent(input), ctx);
			assert.equal(r, undefined, JSON.stringify(input));
		}
	});
	await checkAsync("read rule: error results are untouched", async () => {
		const r = await readHandler.fn(readEvent({ path: "big.txt" }, { isError: true }), ctx);
		assert.equal(r, undefined);
	});

	// --- v2 deterministic engines (integration) ---
	{
		const tsLines = [
			'import { alpha } from "./lib";',
			'import type { Foo } from "./types";',
			"",
			"export function entry(): void {",
			"\treturn;",
			"}",
			"",
			"export class App {",
			"\trun(): void {",
			"\t\t// body",
			"\t}",
			"}",
			"",
			...Array.from({ length: 387 }, (_, i) => `// filler ${i + 1}`),
		];
		writeFileSync(join(fixtureDir, "big.ts"), `${tsLines.join("\n")}\n`);
		writeFileSync(
			join(fixtureDir, "big.md"),
			[
				"# Title",
				"",
				"## Intro",
				...Array.from({ length: 398 }, (_, i) => (i % 2 ? `line ${i + 1}` : `### Sub ${i}`)),
				"",
			].join("\n"),
		);
		writeFileSync(
			join(fixtureDir, "big.csv"),
			`a,b,c\n${Array.from({ length: 399 }, (_, i) => `${i},${i * 2},${i * 3}`).join("\n")}\n`,
		);
		writeFileSync(
			join(fixtureDir, "big.jsonl"),
			`${Array.from({ length: 400 }, (_, i) => JSON.stringify({ a: i, b: `s${i}`, c: i % 7 })).join("\n")}\n`,
		);
		writeFileSync(join(fixtureDir, "big1mb.ts"), `${Array.from({ length: 3000 }, (_, i) => `const pad${i} = "${"x".repeat(490)}";`).join("\n")}\n`);
		// ~3MB of valid TS: above the 1MB code parse gate -> passthrough (no parse)
		writeFileSync(
			join(fixtureDir, "big3mb.ts"),
			`${Array.from({ length: 6000 }, (_, i) => `const pad${i} = "${"x".repeat(490)}";`).join("\n")}\n`,
		);
		// ~2.7MB of markdown: above the 1MB code gate, but md stays on the 20MB gate
		writeFileSync(
			join(fixtureDir, "big3mb.md"),
			Array.from({ length: 15000 }, (_, i) => `# Heading ${i}\n${"pad ".repeat(40)}`).join("\n"),
		);
		writeFileSync(
			join(fixtureDir, "garbage.ts"),
			`${Array.from({ length: 400 }, (_, i) => `@@@ ### not code line ${i} ???`).join("\n")}\n`,
		);

		await checkAsync("read rule: large .ts full read -> STRUCTURE (tree-sitter)", async () => {
			const r = await readHandler.fn(readEvent({ path: "big.ts" }), ctx);
			assert.ok(r, "expected a result patch");
			assert.ok(
				r.content[0].text.startsWith(
					'[shunt] STRUCTURE — not file content. "big.ts" (400 lines). Deterministic index (engine: tree-sitter).',
				),
				r.content[0].text.slice(0, 200),
			);
			assert.ok(r.content[0].text.includes("Imports: ./lib, ./types [lines 1-2]"));
			assert.ok(r.content[0].text.includes("- entry(): void (function) [4-6]"));
			assert.ok(r.content[0].text.includes("- App (class) [8-12]"));
			assert.ok(r.content[0].text.includes("  - run(): void (method) [9-11]"));
			assert.equal(r.details.shunt, true);
			assert.equal(r.details.engine, "tree-sitter");
			assert.equal(r.details.lines, 400);
		});

		await checkAsync("read rule: image part passes through; text-only control intercepts", async () => {
			const withImage = readEvent({ path: "big.ts" });
			withImage.content = [{ type: "text", text: "x" }, { type: "image", data: "AAAA", mimeType: "image/gif" }];
			assert.equal(await readHandler.fn(withImage, ctx), undefined);
			assert.ok((await readHandler.fn(readEvent({ path: "big.ts" }), ctx))?.details?.shunt);
		});

		await checkAsync("read rule: large .md -> STRUCTURE (markdown)", async () => {
			const r = await readHandler.fn(readEvent({ path: "big.md" }), ctx);
			assert.ok(r);
			assert.ok(r.content[0].text.includes("Deterministic index (engine: markdown)"), r.content[0].text.slice(0, 200));
			assert.ok(r.content[0].text.includes("# Title [1]"));
			assert.ok(r.content[0].text.includes("## Intro [3]"));
			assert.equal(r.details.engine, "markdown");
		});

		await checkAsync("read rule: large .csv -> STRUCTURE (csv)", async () => {
			const r = await readHandler.fn(readEvent({ path: "big.csv" }), ctx);
			assert.ok(r);
			assert.ok(r.content[0].text.includes("Deterministic index (engine: csv)"), r.content[0].text.slice(0, 200));
			assert.ok(r.content[0].text.includes("CSV — 399 rows, 3 columns:"));
			assert.ok(r.content[0].text.includes("Fields: a, b, c"));
			assert.equal(r.details.engine, "csv");
		});

		await checkAsync("read rule: large .jsonl -> STRUCTURE (jsonl)", async () => {
			const r = await readHandler.fn(readEvent({ path: "big.jsonl" }), ctx);
			assert.ok(r);
			assert.ok(r.content[0].text.includes("Deterministic index (engine: jsonl)"), r.content[0].text.slice(0, 200));
			assert.ok(r.content[0].text.includes("JSONL — 400 rows; keys in first 100 rows: a, b, c:"));
			assert.equal(r.details.engine, "jsonl");
		});

		await checkAsync("read rule: failed deterministic engine preserves original result", async () => {
			assert.equal(await readHandler.fn(readEvent({ path: "garbage.ts" }), ctx), undefined);
		});

		await checkAsync("read rule: 1.5MB .ts passes through", async () => {
			const start = performance.now();
			const r = await readHandler.fn(readEvent({ path: "big1mb.ts" }), ctx);
			console.log(`1.5MB passthrough: ${(performance.now() - start).toFixed(1)} ms`);
			assert.equal(r, undefined);
		});
		await checkAsync("read rule: 3MB .ts exceeds the 1MB code parse gate -> passthrough (no parse)", async () => {
			const r = await readHandler.fn(readEvent({ path: "big3mb.ts" }), ctx);
			assert.equal(r, undefined, "over the code parse gate the file must pass through unread");
		});

		await checkAsync("read rule: ~2.7MB .md stays on the 20MB gate -> STRUCTURE (markdown)", async () => {
			const r = await readHandler.fn(readEvent({ path: "big3mb.md" }), ctx);
			assert.ok(r, "expected a result patch");
			assert.ok(r.content[0].text.includes("Deterministic index (engine: markdown)"), r.content[0].text.slice(0, 200));
			assert.ok(r.content[0].text.includes("# Heading 0 [1]"));
			assert.equal(r.details.engine, "markdown");
		});

		await checkAsync("read rule: LRU refresh keeps hot entry while evicting oldest", async () => {
			// Proves hit-vs-miss without a spy. The cache key is stat-only
			// (path + mtimeMs + size), so we pin the hot file's mtime to a fixed
			// millisecond-precision timestamp T (exactly restorable via utimes)
			// and size S. After the entry is cached, rewrite the content to a
			// same-size variant and restore mtime T: a HIT serves the stale first
			// render, a MISS re-parses the new content. LRU keeps the refreshed
			// hot entry through the overflow; clear-when-full would have wiped it.
			const hotPath = join(fixtureDir, "lru-hot.md");
			const body = `${Array.from({ length: 360 }, (_, i) => `body line ${i}`).join("\n")}\n`;
			const T = new Date(1_700_000_000_000); // integer ms → exactly restorable
			const get = (name) => readHandler.fn(readEvent({ path: name }), ctx);
			const writeHot = (marker) => {
				writeFileSync(hotPath, `# ${marker}\n${body}`);
				utimesSync(hotPath, T, T);
			};
			const filler = (n) => join(fixtureDir, `lru-f${n}.md`);
			const bigMd = readFileSync(join(fixtureDir, "big.md"));
			writeHot("HOT_A");
			const first = await get("lru-hot.md");
			assert.ok(first?.content[0].text.includes("HOT_A"), "hot file A indexed");
			// Fill to capacity (hot + 62 fillers = 64), refresh hot, then one more
			// filler overflows: LRU evicts the oldest filler, hot survives.
			for (let i = 0; i < 62; i++) { writeFileSync(filler(i), bigMd); assert.ok(await get(`lru-f${i}.md`)); }
			assert.ok(await get("lru-hot.md")); // refresh hot → newest; f0 is oldest
			writeFileSync(filler(62), bigMd);
			assert.ok(await get(`lru-f62.md`)); // 65th entry → overflow
			// Same size, mtime restored to T → identical cache key.
			writeHot("HOT_B");
			const second = await get("lru-hot.md");
			assert.ok(second?.content[0].text.includes("HOT_A") && !second.content[0].text.includes("HOT_B"),
				"hot entry must be served stale from cache (LRU kept it); clear-when-full would have re-parsed HOT_B");
			for (let i = 0; i < 63; i++) rmSync(filler(i), { force: true });
			rmSync(hotPath, { force: true });
		});
		await checkAsync("read rule: repeat full read of the same .ts hits the cache", async () => {
			const first = await readHandler.fn(readEvent({ path: "big.ts" }), ctx);
			const second = await readHandler.fn(readEvent({ path: "big.ts" }), ctx);
			assert.ok(first && second);
			assert.equal(second.content[0].text, first.content[0].text, "cached output must be identical");
			assert.equal(second.details.engine, "tree-sitter");
		});

	}

	// --- read diagnostics: same handler owns the final result (no extension order) ---
	await checkAsync("read diagnostics: index append on first and cached read; linter state changes", async () => {
		const state = join(fixtureDir, "lint-state.json");
		// The allowlist restricts lint to known linter binaries, so the fakes
		// shadow `ruff` / `biome` on PATH instead of using custom commands.
		const fakeRuff = join(fixtureDir, "ruff");
		const fakeBiome = join(fixtureDir, "biome");
		writeFileSync(fakeRuff, `#!/bin/sh
[ "$(cat ${JSON.stringify(state)})" = "true" ] || { printf '%s' '[]'; exit 0; }
printf '%s' '[{"code":"F401","location":{"row":2,"column":1},"message":"unused import"}]'
exit 1
`);
		writeFileSync(fakeBiome, `#!/bin/sh
[ "$(cat ${JSON.stringify(state)})" = "true" ] || { printf '%s' '{"diagnostics":[]}'; exit 0; }
printf '%s' '{"diagnostics":[{"range":{"start":{"line":3,"character":0}},"severity":"error","description":"unused symbol","rule":{"name":"noUnusedVariables"}}]}'
exit 1
`);
		chmodSync(fakeRuff, 0o755);
		chmodSync(fakeBiome, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = fixtureDir + delimiter + process.env.PATH;
		writeFileSync(join(fixtureDir, "small.py"), "import os\nimport sys\nprint(1)\n");
		writeFileSync(state, "true");
		try {
			const first = await readHandler.fn(readEvent({ path: "big.ts" }), ctx);
			const cached = await readHandler.fn(readEvent({ path: "big.ts" }), ctx);
			assert.ok(first.content[0].text.includes("[shunt] DIAGNOSTICS (1):"));
			assert.ok(cached.content[0].text.includes("4:1 error [noUnusedVariables] unused symbol"));
			assert.equal(first.details.engine, "tree-sitter");
			writeFileSync(state, "false");
			const updated = await readHandler.fn(readEvent({ path: "big.ts" }), ctx);
			assert.ok(!updated.content[0].text.includes("DIAGNOSTICS"), "index cache must never include stale findings");
			writeFileSync(state, "true");
			const plain = await readHandler.fn({ ...readEvent({ path: "small.py" }), content: [{ type: "text", text: "import os\nimport sys\nprint(1)\n" }] }, ctx);
			assert.ok(plain.content[0].text.includes("import sys\n  ⚠ line 2 [F401] unused import\nprint(1)"));
			const single = await readHandler.fn({ ...readEvent({ path: "small.py:2-2" }), content: [{ type: "text", text: "import os\nimport sys\nprint(1)\n" }] }, ctx);
			assert.ok(single.content[0].text.includes("  ⚠ line 2 [F401]"));
			assert.equal(await readHandler.fn({ ...readEvent({ path: "small.py:2-2,3-3" }), content: [{ type: "text", text: "import sys\n" }] }, ctx), undefined);
			assert.equal(await readHandler.fn({ ...readEvent({ path: "small.py" }), content: [{ type: "text", text: "import os\nimport sys\nprint(1)\n" }, { type: "image", data: "a", mimeType: "image/png" }] }, ctx), undefined);
			assert.equal(await readHandler.fn({ ...readEvent({ path: "garbage.ts" }), content: [{ type: "text", text: "garbage" }] }, ctx), undefined);
			assert.equal(await readHandler.fn({ ...readEvent({ path: "small.py" }), content: [{ type: "text", text: "[read truncated]" }] }, ctx), undefined);
			const shuntConfig = join(fixtureDir, ".pi", "shunt.json");
			const original = readFileSync(shuntConfig, "utf8");
			try {
				rmSync(shuntConfig);
				const noShunt = await readHandler.fn({ ...readEvent({ path: "small.py" }), content: [{ type: "text", text: "import os\nimport sys\nprint(1)\n" }] }, ctx);
				assert.ok(noShunt.content[0].text.includes("  ⚠ line 2 [F401]"));
			} finally { writeFileSync(shuntConfig, original); }
		} finally { process.env.PATH = savedPath; }
	});

	// --- bash rule ---
	const bashHandler = handlers.find((h) => h.name === "tool_call");
	check("bash: handler registered", () => assert.ok(bashHandler));
	const bashCtx = { cwd: fixtureDir, hasUI: false, ui: { notify: () => {} } };
	const bashEvent = (command) => ({ type: "tool_call", toolCallId: "t", toolName: "bash", input: { command } });
	const runBash = (command) => bashHandler.fn(bashEvent(command), bashCtx);

	await checkAsync("bash rule: blocks cat on large file", async () => {
		const r = await runBash("cat big.txt");
		assert.equal(r.block, true);
		assert.ok(r.reason.startsWith("shunt:"), r.reason);
		assert.ok(r.reason.includes("big.txt"));
	});
	await checkAsync("bash rule: blocks cat on very large file with lower-bound count", async () => {
		const r = await runBash("cat huge-lines.txt");
		assert.equal(r.block, true);
		assert.ok(r.reason.includes("over 1000000 bytes"), r.reason); // size gate precedes line probe
	});
	await checkAsync("bash rule: passes through piped/redirected/bounded usage", async () => {
		for (const command of [
			"cat small.txt",
			"cat big.txt | grep x",
			"cat big.txt > out.txt",
			"head big.txt",
			"head -n 10 big.txt",
			"tail -20 big.txt",
			"echo hi",
			"git status",
			"cat nonexistent.txt",
		]) {
			const r = await runBash(command);
			assert.equal(r, undefined, command);
		}
	});
	await checkAsync("bash rule: blocks an unbounded trailing reader after a file read", async () => {
		const r = await runBash("cat big.txt | cat");
		assert.equal(r.block, true);
		assert.ok(r.reason.includes("big.txt"), r.reason);
	});
	await checkAsync("bash rule: tail +N on a large file is blocked on both sides of minLines", async () => {
		for (const command of ["tail -n +400 big.txt", "tail -n +100 big.txt", "tail -c +500 big.txt"]) {
			assert.equal((await runBash(command))?.block, true, command);
		}
	});
	await checkAsync("bash rule: malformed (non-string) command fails open without throwing", async () => {
		for (const bad of [undefined, null, 42, {}, ["cat", "big.txt"]]) {
			const r = await bashHandler.fn({ ...bashEvent("x"), input: { command: bad } }, bashCtx);
			assert.equal(r, undefined, String(bad));
		}
		assert.equal(await bashHandler.fn({ ...bashEvent("x"), input: undefined }, bashCtx), undefined);
	});
	await checkAsync("bash rule: blocks head with large explicit count", async () => {
		const r = await runBash("head -n 500 big.txt");
		assert.equal(r.block, true);
	});

	await checkAsync("bash rule: FIFO without writer resolves within three seconds", async () => {
		const fifo = join(fixtureDir, "unwritten.fifo");
		execFileSync("mkfifo", [fifo]);
		const start = performance.now();
		const result = await Promise.race([runBash("cat unwritten.fifo"), new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO hook hung")), 2900))]);
		assert.equal(result, undefined);
		assert.ok(performance.now() - start < 3000);
		console.log(`FIFO hook: ${(performance.now() - start).toFixed(1)} ms`);
	});
	await checkAsync("bash rule: size fallback blocks large single- and multi-line files; small multiline passes", async () => {
		writeFileSync(join(fixtureDir, "wide.txt"), "a".repeat(5_000_000));
		writeFileSync(join(fixtureDir, "many.txt"), "a\n".repeat(2_500_000));
		writeFileSync(join(fixtureDir, "few.txt"), "a\n".repeat(10));
		assert.equal((await runBash("cat wide.txt"))?.block, true);
		assert.equal((await runBash("cat many.txt"))?.block, true);
		assert.equal(await runBash("cat few.txt"), undefined);
	});
	rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(process.exitCode ? `\n${passed} passed, with failures` : `\n${passed} checks passed`);
