#!/usr/bin/env node
/**
 * spike-structure.mjs — S1 spike for shunt v2 (spec: docs/dev/shunt_v2_spec.md §5-S1).
 *
 * Verifies under plain Node 24:
 *  (a) dynamic-import interop shape of @vscode/tree-sitter-wasm (bundled runtime + grammars)
 *  (b) wasm path resolution from the package
 *  (c) typescript + python parses of synthetic ≥300-line fixtures (top-level symbols + 1-indexed lines)
 *  (d) tsx standalone load + parse (base language inlined by CLI 0.25 build)
 *  (e) .jsx parsed with the tsx grammar — error-node ratio
 *
 * Dev script only — not loaded by the extension. Run: node spike-structure.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

let failed = 0;
function ok(cond, label, extra = "") {
	const mark = cond ? "PASS" : "FAIL";
	if (!cond) failed++;
	console.log(`[${mark}] ${label}${extra ? ` — ${extra}` : ""}`);
}
function assert(cond, label, extra = "") {
	if (!cond) {
		console.log(`[FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
		failed++;
	} else {
		console.log(`[PASS] ${label}${extra ? ` — ${extra}` : ""}`);
	}
}

// ── (a) import interop shape ─────────────────────────────────────────
const tImport = performance.now();
const mod = await import("@vscode/tree-sitter-wasm");
const interop = {
	namedParser: typeof mod.Parser,
	defaultParser: mod.default ? typeof mod.default.Parser : "n/a",
	defaultLanguage: mod.default ? typeof mod.default.Language : "n/a",
};
console.log("== (a) import shape ==");
console.log(JSON.stringify(interop));
const { Parser, Language } = interop.namedParser === "function" ? mod : mod.default;
console.log(`import took ${Math.round(performance.now() - tImport)}ms`);
assert(interop.namedParser === "function" || interop.defaultParser === "function", "Parser accessible (named or .default)");

const require_ = createRequire(import.meta.url);
const wasmDir = join(dirname(require_.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
const wasm = (lang) => join(wasmDir, `tree-sitter-${lang}.wasm`);

const tInit = performance.now();
await Parser.init();
console.log(`\nParser.init() done (${Math.round(performance.now() - tInit)}ms)`);

for (const lang of ["typescript", "tsx", "javascript", "python", "rust", "go", "bash"]) {
	try {
		await Language.load(wasm(lang));
		console.log(`[PASS] wasm loads: ${lang}`);
	} catch (e) {
		assert(false, `wasm loads: ${lang}`, e.message);
	}
}

// ── fixture generation ───────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "shunt-spike-"));
const pad = (n, text = "// filler") => Array.from({ length: n }, () => text).join("\n");

const tsFixture = [
	`import { alpha, beta } from "./lib";`,
	`import type { Foo } from "./types";`,
	``,
	`export function firstFunction(a: number): number {`,
	`\treturn a + 1;`,
	`\t${pad(8)}`,
	`}`,
	``,
	`export class Widget {`,
	`\tcount = 0;`,
	``,
	`\tconstructor(public label: string) {`,
	`\t\tthis.count = 1;`,
	`\t}`,
	``,
	`\tincrement(): number {`,
	`\t\tthis.count += 1;`,
	`\t\treturn this.count;`,
	`\t\t${pad(6)}`,
	`\t}`,
	``,
	`\tdescribe(): string {`,
	`\t\treturn \`\${this.label}:\${this.count}\`;`,
	`\t\t${pad(6)}`,
	`\t}`,
	`}`,
	``,
	`function secondFunction(): void {`,
	`\t${pad(12)}`,
	`}`,
	``,
	`const thirdFunction = (): string => {`,
	`\t${pad(8)}`,
	`\treturn "third";`,
	`};`,
	``,
	pad(240),
].join("\n") + "\n";
writeFileSync(join(dir, "fixture.ts"), tsFixture);

const pyFixture = [
	`import os`,
	`from collections import defaultdict`,
	``,
	`def first_function(x: int) -> int:`,
	`\treturn x + 1`,
	``,
	`class Processor:`,
	`\tdef __init__(self):`,
	`\t\tself.count = 0`,
	``,
	`\tdef step(self):`,
	`\t\tself.count += 1`,
	`\t\treturn self.count`,
	``,
	`\tdef reset(self):`,
	`\t\tself.count = 0`,
	``,
	`def second_function():`,
	`\tpass`,
	``,
	pad(282, "# filler"),
].join("\n") + "\n";
writeFileSync(join(dir, "fixture.py"), pyFixture);

// ── helpers ──────────────────────────────────────────────────────────
const TOP_TS = new Set(["function_declaration", "class_declaration", "lexical_declaration", "variable_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"]);
const TOP_PY = new Set(["function_definition", "class_definition"]);

function topLevelNames(root, types) {
	const out = [];
	for (const child of root.children) {
		// TS/TSX grammar wraps `export ...` declarations in export_statement — unwrap.
		let node = child;
		if (node.type === "export_statement") {
			const inner = node.namedChildren[0];
			if (!inner || !types.has(inner.type)) continue;
			node = inner;
		}
		if (!types.has(node.type)) continue;
		let name = node.childForFieldName("name")?.text ?? "";
		if (!name && (node.type === "lexical_declaration" || node.type === "variable_declaration")) {
			const decl = node.children.find((c) => c.type === "variable_declarator");
			name = decl?.childForFieldName("name")?.text ?? decl?.firstChild?.text ?? "";
		}
		out.push({ name, kind: node.type, start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
	}
	return out;
}

function errorLineRatio(root, totalLines) {
	let lines = 0;
	const walk = (node) => {
		const isBad = node.type === "ERROR" || node.isMissing;
		if (isBad && !(node.parent && (node.parent.type === "ERROR" || node.parent.isMissing))) {
			lines += node.endPosition.row - node.startPosition.row + 1;
		}
		for (const c of node.children) walk(c);
	};
	walk(root);
	return lines / Math.max(totalLines, 1);
}

// ── (c) typescript + python parses ───────────────────────────────────
console.log("\n== (c) fixture parses ==");
{
	const t0 = performance.now();
	const lang = await Language.load(wasm("typescript"));
	const parser = new Parser();
	parser.setLanguage(lang);
	const tree = parser.parse(tsFixture);
	const ms = Math.round(performance.now() - t0);
	const total = tsFixture.split("\n").length - 1;
	const tops = topLevelNames(tree.rootNode, TOP_TS);
	const fns = tops.filter((t) => t.kind === "function_declaration");
	const cls = tops.filter((t) => t.kind === "class_declaration");
	const methods = cls[0] ? parseTsFixtureClassMethods(tree) : 0;
	const imports = countNodes(tree.rootNode, "import_statement");
	console.log(`typescript: ${total} lines, ${tops.length} top-level named, ${ms}ms`);
	for (const t of tops.slice(0, 5)) console.log(`  ${t.kind} ${t.name || "(anon)"} [${t.start}-${t.end}]`);
	ok(total >= 300, "ts fixture ≥300 lines", String(total));
	ok(fns.length >= 2 && tops.some((t) => t.kind === "lexical_declaration" && t.name === "thirdFunction"), "ts ≥2 function_declarations + const-arrow top-level", `fns=${fns.length} arrow=${tops.some((t) => t.name === "thirdFunction") ? 1 : 0}`);
	ok(cls.length === 1 && methods >= 2, "ts 1 class with ≥2 methods", `methods=${methods}`);
	ok(imports >= 2, "ts ≥2 import statements", String(imports));
}

function parseTsFixtureClassMethods(tree) {
	let n = 0;
	const walk = (node) => {
		if (node.type === "class_declaration") {
			const body = node.children.find((c) => c.type === "class_body");
			if (body) n = body.children.filter((c) => c.type === "method_definition" || c.type === "public_field_definition").length;
			return;
		}
		for (const c of node.children) walk(c);
	};
	walk(tree.rootNode);
	return n;
}
function countNodes(root, type) {
	let n = 0;
	const walk = (node) => {
		if (node.type === type) n++;
		for (const c of node.children) walk(c);
	};
	walk(root);
	return n;
}
{
	const t0 = performance.now();
	const lang = await Language.load(wasm("python"));
	const parser = new Parser();
	parser.setLanguage(lang);
	const tree = parser.parse(pyFixture);
	const ms = Math.round(performance.now() - t0);
	const total = pyFixture.split("\n").length - 1;
	const tops = topLevelNames(tree.rootNode, TOP_PY);
	const fns = tops.filter((t) => t.kind === "function_definition");
	const cls = tops.filter((t) => t.kind === "class_definition");
	console.log(`python: ${total} lines, ${tops.length} top-level named, ${ms}ms`);
	for (const t of tops.slice(0, 5)) console.log(`  ${t.kind} ${t.name || "(anon)"} [${t.start}-${t.end}]`);
	ok(total >= 300, "py fixture ≥300 lines", String(total));
	ok(fns.length >= 2, "py ≥2 top-level defs", String(fns.length));
	ok(cls.length === 1, "py 1 class", String(cls.length));
	ok(errorLineRatio(tree.rootNode, total) === 0, "py clean parse (0 error lines)");
}

// ── (d) tsx dual-grammar injection ───────────────────────────────────
console.log("\n== (d) tsx standalone load + parse ==");
const tsxSnippet = [
	`import { useState } from "react";`,
	``,
	`interface Props {`,
	`\titems: string[];`,
	`}`,
	``,
	`export function App({ items }: Props) {`,
	`\tconst [count, setCount] = useState(0);`,
	`\treturn (`,
	`\t\t<div className="app" data-x={count}>`,
	`\t\t\t{items.map((i) => (`,
	`\t\t\t\t<span key={i}>{i}</span>`,
	`\t\t\t))}`,
	`\t\t</div>`,
	`\t);`,
	`}`,
].join("\n");
let tsxDual = null;
try {
	const t0 = performance.now();
	tsxDual = await Language.load(wasm("tsx"));
	const parser = new Parser();
	parser.setLanguage(tsxDual);
	const tree = parser.parse(tsxSnippet);
	const ms = Math.round(performance.now() - t0);
	const ratio = errorLineRatio(tree.rootNode, tsxSnippet.split("\n").length - 1);
	const jsx = countNodes(tree.rootNode, "jsx_element");
	console.log(`tsx standalone: OK, ${ms}ms, jsx_elements=${jsx}, error_ratio=${ratio.toFixed(4)}`);
	ok(ratio === 0 && jsx >= 2, "tsx standalone parses cleanly (TS annotations + JSX)", `jsx=${jsx}`);
} catch (e) {
	console.log(`tsx standalone: THREW — ${e.message}`);
	ok(false, "tsx standalone load supported", e.message);
}

// ── (e) jsx via tsx grammar ──────────────────────────────────────────
console.log("\n== (e) jsx via tsx grammar ==");
const jsxSnippet = [
	`import React from "react";`,
	``,
	`export default function App() {`,
	`\tconst items = [1, 2, 3];`,
	`\treturn (`,
	`\t\t<ul>`,
	`\t\t\t{items.map((i) => (`,
	`\t\t\t\t<li key={i}>{i * 2}</li>`,
	`\t\t\t))}`,
	`\t\t</ul>`,
	`\t);`,
	`}`,
].join("\n");
if (tsxDual) {
	const parser = new Parser();
	parser.setLanguage(tsxDual);
	const tree = parser.parse(jsxSnippet);
	const total = jsxSnippet.split("\n").length - 1;
	const ratio = errorLineRatio(tree.rootNode, total);
	console.log(`jsx via tsx grammar: error_ratio=${ratio.toFixed(4)}`);
	ok(ratio < 0.1, "jsx via tsx grammar: error ratio < 10%", ratio.toFixed(4));
} else {
	console.log("SKIP jsx test (tsx load failed)");
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
