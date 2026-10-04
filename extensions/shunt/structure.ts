// structure.ts — shunt v2: deterministic structure-summary builders (pure module).
//
// Zero pi imports (repo rule: core logic stays a pure module testable from plain
// Node; index.ts owns all pi/session integration). Run tests: node test-shunt.mjs
//
// Engines (see docs/dev/shunt_v2_spec.md §3):
//   code     — tree-sitter index via @vscode/tree-sitter-wasm (lazy dynamic import)
//   markdown — heading outline (fence-aware)
//   csv      — rows/columns/fields/sample profile
//   jsonl    — rows/keys/sample profile
//
// All builders fail-open: unparseable / unsupported input → undefined, and the
// caller keeps the original tool result untouched.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants (spec §3.3–§3.5)
// ---------------------------------------------------------------------------

/** Size gate for markdown/csv/jsonl engines (chars). */
export const MAX_DETERMINISTIC_CHARS = 20_000_000;
/**
 * Code files larger than this pass through unread: tree-sitter's WASM parse
 * runs synchronously on the main thread, and a large parse would stall the
 * whole session. Markdown/csv/jsonl profiles stay on MAX_DETERMINISTIC_CHARS
 * (line-based, no parse stall).
 */
export const MAX_CODE_PARSE_CHARS = 1_000_000;

const RENDER_CHAR_CAP = 40_000; // backstop on rendered output (signatures are never truncated)
const MAX_CODE_ENTRIES = 400; // backstop: top-level entries + member lines
const MAX_MD_ENTRIES = 100;
const MAX_IMPORTS = 20;
const MAX_LIST_ITEMS = 20; // fields / keys
const CSV_SAMPLE_ROWS = 3;
const CSV_SAMPLE_CHARS = 80;
const JSONL_SAMPLE_ROWS = 2;
const JSONL_SAMPLE_CHARS = 120;
const MAX_ERROR_LINE_RATIO = 0.1; // >10% error lines → not code

// ---------------------------------------------------------------------------
// Kind detection (spec §3.2)
// ---------------------------------------------------------------------------

export type FileKind = "code" | "markdown" | "csv" | "jsonl" | "other";
export type CodeLangId =
	| "typescript"
	| "tsx"
	| "javascript"
	| "python"
	| "rust"
	| "go"
	| "bash";
export type EngineName = "tree-sitter" | "markdown" | "csv" | "jsonl";

export const DEFAULT_LANGUAGES = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "sh"];

const EXT_GRAMMAR: Record<string, CodeLangId> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "tsx",
	py: "python",
	rs: "rust",
	go: "go",
	sh: "bash",
};
const MARKDOWN_EXTS = new Set(["md", "markdown"]);
const CSV_EXTS = new Set(["csv", "tsv"]);
const JSONL_EXTS = new Set(["jsonl", "ndjson"]);

/** Last extension of the final path segment, lowercased; "" when absent. */
export function extensionOf(path: string): string {
	const seg = path.split(/[\\/]/).pop() ?? path;
	const dot = seg.lastIndexOf(".");
	if (dot <= 0) return ""; // no dot, or a leading dotfile dot
	return seg.slice(dot + 1).toLowerCase();
}

export function detectKind(
	path: string,
	languages: readonly string[] = DEFAULT_LANGUAGES,
): FileKind {
	if (grammarForPath(path, languages)) return "code";
	const ext = extensionOf(path);
	if (MARKDOWN_EXTS.has(ext)) return "markdown";
	if (CSV_EXTS.has(ext)) return "csv";
	if (JSONL_EXTS.has(ext)) return "jsonl";
	return "other";
}

/** Grammar for a code path, or undefined (not code / ext not in `languages`). */
export function grammarForPath(
	path: string,
	languages: readonly string[] = DEFAULT_LANGUAGES,
): CodeLangId | undefined {
	const ext = extensionOf(path);
	if (!ext) return undefined;
	const g = EXT_GRAMMAR[ext];
	return g && languages.includes(ext) ? g : undefined;
}

// ---------------------------------------------------------------------------
// tree-sitter engine (lazy; spec §3.6)
// ---------------------------------------------------------------------------

interface TPoint {
	row: number;
	column: number;
}
interface TNode {
	type: string;
	isMissing: boolean;
	startPosition: TPoint;
	endPosition: TPoint;
	children: TNode[];
	namedChildren: TNode[];
	text: string;
	childForFieldName(name: string): TNode | null;
}
interface TTree {
	rootNode: TNode;
	delete(): void;
}

export interface StructureEngine {
	/** Parse with the given grammar; null when that grammar failed to load. */
	parse(grammar: CodeLangId, source: string): TTree | null;
	/** Grammars that loaded successfully. */
	loaded: ReadonlySet<CodeLangId>;
}

const ALL_GRAMMARS: CodeLangId[] = [
	"typescript",
	"tsx",
	"javascript",
	"python",
	"rust",
	"go",
	"bash",
];

let enginePromise: Promise<StructureEngine | undefined> | undefined;

/**
 * Initialize the tree-sitter engine once (import + Parser.init + load every
 * available grammar). Resolves undefined when the dependency is missing or
 * the runtime is broken — callers must fail-open (spec R6/R7).
 */
export function initStructureEngine(): Promise<StructureEngine | undefined> {
	if (!enginePromise) enginePromise = doInitEngine();
	return enginePromise;
}

async function doInitEngine(): Promise<StructureEngine | undefined> {
	try {
		const mod = (await import("@vscode/tree-sitter-wasm")) as any;
		// S1-verified: named exports are not detected by cjs-module-lexer —
		// the API lives on mod.default.
		const ns = mod?.default ?? mod;
		const Parser = ns?.Parser;
		const Language = ns?.Language;
		if (typeof Parser?.init !== "function" || typeof Language?.load !== "function") {
			return undefined;
		}
		const req = createRequire(import.meta.url);
		const wasmDir = join(dirname(req.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
		await Parser.init();
		const langs = new Map<CodeLangId, unknown>();
		for (const g of ALL_GRAMMARS) {
			try {
				langs.set(g, await Language.load(join(wasmDir, `tree-sitter-${g}.wasm`)));
			} catch {
				// one grammar missing/corrupt → degrade that grammar only
			}
		}
		if (langs.size === 0) return undefined;
		const parser = new Parser();
		return {
			loaded: new Set(langs.keys()),
			parse(grammar, source) {
				try {
					const lang = langs.get(grammar);
					if (!lang) return null;
					parser.setLanguage(lang);
					const tree = parser.parse(source) as TTree | null;
					return tree?.rootNode ? tree : null;
				} catch { return null; }
			},
		};
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Code index (spec §3.3)
// ---------------------------------------------------------------------------

export interface CodeMember {
	name: string;
	kind: string;
	start: number;
	end: number;
	/** Full signature text, e.g. `(a: number): void` — only when the language has one. */
	signature?: string;
}
export interface CodeEntry {
	name: string;
	kind: string;
	start: number;
	end: number;
	/** Full signature text, e.g. `(a: number): void` — only when the language has one. */
	signature?: string;
	members: CodeMember[];
}
export interface CodeIndex {
	grammar: CodeLangId;
	imports: { names: string[]; more: number; first: number; last: number } | null;
	entries: CodeEntry[]; // backstop already applied (top-level + member lines ≤ 400)
	omitted: number; // top-level entries dropped by the budget
	totalEntries: number; // before budget
	errorLines: number;
	totalLines: number;
}

interface GrammarSpec {
	topTypes: string[];
	importNodeTypes: string[];
}

const GRAMMAR_SPECS: Record<CodeLangId, GrammarSpec> = {
	typescript: {
		topTypes: [
			"function_declaration",
			"class_declaration",
			"abstract_class_declaration",
			"interface_declaration",
			"type_alias_declaration",
			"enum_declaration",
			"lexical_declaration",
			"variable_declaration",
		],
		importNodeTypes: ["import_statement"],
	},
	tsx: {
		topTypes: [
			"function_declaration",
			"class_declaration",
			"abstract_class_declaration",
			"interface_declaration",
			"type_alias_declaration",
			"enum_declaration",
			"lexical_declaration",
			"variable_declaration",
		],
		importNodeTypes: ["import_statement"],
	},
	javascript: {
		topTypes: [
			"function_declaration",
			"class_declaration",
			"lexical_declaration",
			"variable_declaration",
		],
		importNodeTypes: ["import_statement"],
	},
	python: {
		topTypes: ["function_definition", "class_definition"],
		importNodeTypes: ["import_statement", "import_from_statement"],
	},
	rust: {
		topTypes: [
			"struct_item",
			"enum_item",
			"union_item",
			"impl_item",
			"function_item",
			"trait_item",
			"mod_item",
		],
		importNodeTypes: ["use_declaration"],
	},
	go: {
		topTypes: ["function_declaration", "method_declaration", "type_declaration"],
		importNodeTypes: ["import_declaration"],
	},
	bash: {
		topTypes: ["function_definition"],
		importNodeTypes: [],
	},
};

const TOP_KIND_LABELS: Record<string, string> = {
	function_declaration: "function",
	class_declaration: "class",
	abstract_class_declaration: "class",
	interface_declaration: "interface",
	type_alias_declaration: "type",
	enum_declaration: "enum",
	lexical_declaration: "const",
	variable_declaration: "var",
	function_definition: "function",
	class_definition: "class",
	struct_item: "struct",
	enum_item: "enum",
	union_item: "union",
	impl_item: "impl",
	function_item: "function",
	trait_item: "trait",
	mod_item: "mod",
	type_declaration: "type",
	method_declaration: "method",
};
const MEMBER_KIND_LABELS: Record<string, string> = {
	method_definition: "method",
	public_field_definition: "field",
	field_definition: "field",
	method_signature: "method",
	property_signature: "field",
};

/** Parse source with the tree-sitter engine and build a bounded index. */
export async function buildCodeIndex(
	source: string,
	grammar: CodeLangId,
): Promise<CodeIndex | undefined> {
	const engine = await initStructureEngine();
	if (!engine) return undefined;
	const tree = engine.parse(grammar, source);
	if (!tree) return undefined;

	try {
	const totalLines = Math.max(1, countSourceLines(source));
	const errRows = errorLineSet(tree.rootNode);
	if (errRows.size / totalLines > MAX_ERROR_LINE_RATIO) return undefined;

	const spec = GRAMMAR_SPECS[grammar];
	const allEntries: CodeEntry[] = [];
	for (const child of tree.rootNode.children) {
		// TS/TSX wrap `export …` declarations in an export_statement node;
		// Python wraps decorated defs in a decorated_definition node.
		let node = child;
		if (node.type === "export_statement") {
			const inner = node.namedChildren[0];
			if (!inner || !spec.topTypes.includes(inner.type)) continue;
			node = inner;
		}
		if (node.type === "decorated_definition") {
			const inner = node.namedChildren.find(
				(c) => c.type === "function_definition" || c.type === "class_definition",
			);
			if (!inner) continue;
			node = inner;
		}
		if (!spec.topTypes.includes(node.type)) continue;
		const name = nameOf(node);
		if (!name) continue; // unnamed top-level blocks are not indexed (spec §3.3)
		const entry: CodeEntry = {
			name,
			kind: TOP_KIND_LABELS[node.type] ?? node.type,
			// Wrapper start row so decorators are included in the range.
			start: child.startPosition.row + 1,
			end: node.endPosition.row + 1,
			members: extractMembers(node, grammar),
		};
		const sig = signatureOf(node, grammar);
		if (sig) entry.signature = sig;
		allEntries.push(entry);
	}

	// Budget: rendered lines (top-level + member lines) ≤ MAX_CODE_ENTRIES.
	const kept: CodeEntry[] = [];
	let rendered = 0;
	for (const e of allEntries) {
		const cost = 1 + e.members.length;
		if (rendered + cost > MAX_CODE_ENTRIES) {
			if (kept.length === 0) {
				const members = e.members.slice(0, 40);
				members.push({ name: `… +${e.members.length - members.length} more members`, kind: "", start: e.end, end: e.end });
				kept.push({ ...e, members });
			}
			break;
		}
		kept.push(e);
		rendered += cost;
	}

	const imports = extractImports(tree.rootNode, spec, grammar);

	return {
		grammar,
		imports,
		entries: kept,
		omitted: allEntries.length - kept.length,
		totalEntries: allEntries.length,
		errorLines: errRows.size,
		totalLines,
	};
	} finally {
		try { tree.delete(); } catch { /* preserve the index result if cleanup fails */ }
	}
}

/** Render a code index as body lines (budget marker included). */
export function renderCodeIndex(ci: CodeIndex): string[] {
	const out: string[] = [];
	if (ci.imports && ci.imports.names.length > 0) {
		const { names, more, first, last } = ci.imports;
		out.push(
			`Imports: ${names.join(", ")}${more > 0 ? ` (+${more})` : ""} [lines ${first}-${last}]`,
		);
	}
	for (const e of ci.entries) {
		out.push(`- ${e.name}${e.signature ?? ""} (${e.kind}) [${e.start}-${e.end}]`);
		for (const m of e.members)
			out.push(`  - ${m.name}${m.signature ?? ""} (${m.kind}) [${m.start}-${m.end}]`);
	}
	if (ci.omitted > 0) {
		out.push(`… +${ci.omitted} more entries（total ${ci.totalEntries}；用 targeted read 取精確內容）`);
	}
	return out;
}

/** Rows (0-indexed) covered by ERROR / MISSING nodes. */
function errorLineSet(root: TNode): Set<number> {
	const rows = new Set<number>();
	const visit = (n: TNode): void => {
		if (n.type === "ERROR" || n.isMissing) {
			for (let r = n.startPosition.row; r <= n.endPosition.row; r++) rows.add(r);
			return; // don't descend: children of ERROR are error/missing too
		}
		for (const c of n.children) visit(c);
	};
	visit(root);
	return rows;
}

function nameOf(node: TNode): string {
	const direct = node.childForFieldName("name");
	if (direct) return direct.text;
	switch (node.type) {
		case "lexical_declaration":
		case "variable_declaration": {
			const decl = node.namedChildren.find((c) => c.type === "variable_declarator");
			if (!decl) return "";
			const name = decl.childForFieldName("name");
			if (name) return name.text;
			return "";
		}
		case "method_declaration": {
			const m = node.childForFieldName("method_name");
			return m ? m.text : "";
		}
		case "method_elem": {
			// go interface member: `Serve(w string, n int)`
			const m =
				node.childForFieldName("name") ??
				node.namedChildren.find((c) => c.type === "field_identifier");
			return m ? m.text : "";
		}
		case "function_definition": {
			// bash: `name() { ... }` — first word child (python uses the name field above)
			const w = node.namedChildren.find((c) => c.type === "word");
			return w ? w.text : "";
		}
		case "impl_item": {
			const t = node.childForFieldName("type");
			if (!t) return "";
			const tr = node.childForFieldName("trait");
			return tr ? `impl ${tr.text} for ${t.text}` : `impl ${t.text}`;
		}
		case "type_declaration": {
			const specNode = node.namedChildren.find((c) => c.type === "type_spec");
			const n = specNode?.childForFieldName("name");
			return n ? n.text : "";
		}
		default:
			return "";
	}
}

interface SigSpec {
	fnTypes: string[]; // node types that carry a parameter list
	paramsTypes: string[]; // direct child holding the parameter list (parens included)
	retTypes: string[] | null; // return-type child types; null = positional (first named child after params)
	retPrefix: string; // separator when the annotation text lacks one (":", "->", …)
}
/** Node types that mark the end of a signature (function body / where clause). */
const BODY_TYPES = new Set(["function_body", "block", "where_clause"]);
const TS_FN_TYPES = [
	"function_declaration",
	"method_definition",
	"method_signature",
	"arrow_function",
	"function_expression",
	"generator_function_declaration",
	"generator_method_definition",
];
const SIG_SPECS: Partial<Record<CodeLangId, SigSpec>> = {
	typescript: { fnTypes: TS_FN_TYPES, paramsTypes: ["formal_parameters"], retTypes: ["type_annotation"], retPrefix: "" },
	tsx: { fnTypes: TS_FN_TYPES, paramsTypes: ["formal_parameters"], retTypes: ["type_annotation"], retPrefix: "" },
	javascript: { fnTypes: ["function_declaration", "arrow_function", "function_expression"], paramsTypes: ["formal_parameters"], retTypes: [], retPrefix: "" },
	python: { fnTypes: ["function_definition"], paramsTypes: ["parameters"], retTypes: ["type"], retPrefix: " -> " },
	// rust/go: return type is positional — the first named child after the
	// parameter list, since type nodes have many names (primitive_type, …)
	rust: { fnTypes: ["function_item", "function_signature_item"], paramsTypes: ["parameters"], retTypes: null, retPrefix: " -> " },
	go: { fnTypes: ["function_declaration", "method_declaration", "method_elem"], paramsTypes: ["parameter_list"], retTypes: null, retPrefix: " " },
};

/** Collapse whitespace in a signature fragment so it renders on one line. */
const cleanSig = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Full signature text (parameters + return annotation), never truncated. */
function signatureOf(node: TNode, grammar: CodeLangId): string | undefined {
	const spec = SIG_SPECS[grammar];
	if (!spec) return undefined;
	let fnNode: TNode | undefined;
	if (spec.fnTypes.includes(node.type)) {
		fnNode = node;
	} else if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
		// `const f = (a: T) => …` — the arrow function sits in the declarator's value
		const decl = node.namedChildren.find((c) => c.type === "variable_declarator");
		const value = decl?.childForFieldName("value");
		if (value && spec.fnTypes.includes(value.type)) fnNode = value;
	}
	if (!fnNode) return undefined;
	// Go: a method's receiver `(s *S)` is itself a `parameter_list` preceding the
	// real parameter list — take the last as params, the first as the receiver.
	const paramLists = fnNode.namedChildren.filter((c) => c.type === "parameter_list");
	// A receiver only exists when a non-interface method carries two lists
	// (recv + params); method_elem never has one — its optional second
	// list is the multi-value result.
	const hasRecv = fnNode.type !== "method_elem" && paramLists.length > 1;
	const recv = hasRecv ? paramLists[0] : undefined;
	const params =
		paramLists[hasRecv ? 1 : 0] ?? fnNode.namedChildren.find((c) => spec.paramsTypes.includes(c.type));
	if (!params) return undefined;
	const pIdx = fnNode.namedChildren.indexOf(params);
	// The return type must come after the params but before where_clause / body.
	const whereIdx = fnNode.namedChildren.findIndex((c) => c.type === "where_clause");
	const after = (i: number) => i > pIdx && (whereIdx === -1 || i < whereIdx);
	const ret =
		spec.retTypes === null
			? fnNode.namedChildren.find((c, i) => after(i) && !BODY_TYPES.has(c.type))
			: fnNode.namedChildren.find((c, i) => after(i) && spec.retTypes!.includes(c.type));
	const prefix = recv ? recv.text + " " : "";
	const sig = cleanSig(prefix + params.text + (ret ? spec.retPrefix + ret.text : ""));
	return sig || undefined;
}

/** Signature for a class/interface member: methods get params+return, fields their type. */
function memberSig(m: TNode, grammar: CodeLangId): string | undefined {
	if (SIG_SPECS[grammar]?.fnTypes.includes(m.type)) return signatureOf(m, grammar);
	if (grammar === "typescript" || grammar === "tsx" || grammar === "javascript") {
		const ann = m.namedChildren.find((c) => c.type === "type_annotation");
		return ann ? cleanSig(ann.text) : undefined;
	}
	const t = m.namedChildren.find(
		(c) => c.type === "type" || c.type === "type_identifier" || c.type.endsWith("_type"),
	);
	return t ? ": " + cleanSig(t.text) : undefined;
}

function extractMembers(node: TNode, grammar: CodeLangId): CodeMember[] {
	const out: CodeMember[] = [];
	const push = (m: TNode, kind: string) => {
		const name = nameOf(m) || firstIdentifierText(m);
		if (!name) return;
		const member: CodeMember = {
			name,
			kind,
			start: m.startPosition.row + 1,
			end: m.endPosition.row + 1,
		};
		const sig = memberSig(m, grammar);
		if (sig) member.signature = sig;
		out.push(member);
	};

	if (grammar === "typescript" || grammar === "tsx" || grammar === "javascript") {
		const body =
			node.namedChildren.find((c) => c.type === "class_body") ??
			node.namedChildren.find((c) => c.type === "type_member_list");
		if (body) {
			for (const c of body.namedChildren) {
				if (MEMBER_KIND_LABELS[c.type]) push(c, MEMBER_KIND_LABELS[c.type]);
			}
		}
		return out;
	}
	if (grammar === "python") {
		// classes only — functions also have a block child, but their local
		// variables are not members (spec §3.3: class/struct/interface only)
		if (node.type !== "class_definition") return out;
		const body = node.namedChildren.find((c) => c.type === "block");
		if (!body) return out;
		for (const c of body.namedChildren) {
			if (c.type === "function_definition") push(c, "method");
			else if (c.type === "decorated_definition") {
				// @decorated methods are wrapped — index the inner definition
				const inner = c.namedChildren.find((x) => x.type === "function_definition");
				if (inner) push(inner, "method");
			} else if (c.type === "expression_statement") {
				const assign = c.namedChildren.find((x) => x.type === "assignment");
				// this build exposes no "left" field — first named child is the target
				const left = assign?.namedChildren[0];
				if (assign && left?.type === "identifier") {
					const field: CodeMember = {
						name: left.text,
						kind: "field",
						start: left.startPosition.row + 1,
						end: left.endPosition.row + 1,
					};
					// `x: int = 2` — the annotation is a direct child of the assignment
					const ann = assign.namedChildren.find((x) => x.type === "type");
					if (ann) field.signature = ": " + cleanSig(ann.text);
					out.push(field);
				}
			}
		}
		return out;
	}
	if (grammar === "rust") {
		const fields = findDescendant(node, "field_declaration_list");
		if (fields) {
			for (const c of fields.namedChildren) {
				if (c.type === "field_declaration") push(c, "field");
			}
		}
		// impl / trait blocks: list their methods (the contract of a Rust type).
		// Methods nest inside the block's declaration_list.
		if (node.type === "impl_item" || node.type === "trait_item") {
			const list = node.namedChildren.find((c) => c.type === "declaration_list");
			for (const c of list?.namedChildren ?? []) {
				if (c.type === "function_item" || c.type === "function_signature_item") push(c, "method");
			}
		}
		return out;
	}
	if (grammar === "go") {
		const fieldList = findDescendant(node, "field_declaration_list");
		if (fieldList) {
			for (const c of fieldList.namedChildren) {
				if (c.type === "field_declaration") push(c, "field");
			}
		}
		// Interfaces: method elements form the contract.
		const iface = findDescendant(node, "interface_type");
		for (const c of iface?.namedChildren ?? []) {
			if (c.type === "method_elem") push(c, "method");
		}
		return out;
	}
	return out; // bash: no member level
}

function findDescendant(node: TNode, type: string): TNode | null {
	if (node.type === type) return node;
	for (const c of node.namedChildren) {
		const r = findDescendant(c, type);
		if (r) return r;
	}
	return null;
}

function firstIdentifierText(node: TNode): string {
	const id = node.namedChildren.find((c) => c.type === "identifier");
	return id ? id.text : "";
}

/** Leftmost segment of a (possibly nested) scoped_identifier, e.g. `a::b::c` → `a`. */
function leftmostPathSegment(node: TNode): string {
	let n: TNode = node;
	while (n.type === "scoped_identifier") {
		const first = n.namedChildren[0];
		if (!first) return "";
		n = first;
	}
	return n.text;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(
	root: TNode,
	spec: GrammarSpec,
	grammar: CodeLangId,
): { names: string[]; more: number; first: number; last: number } | null {
	if (spec.importNodeTypes.length === 0) return null;
	const found: { name: string; line: number }[] = [];
	const visit = (n: TNode): void => {
		if (spec.importNodeTypes.includes(n.type)) {
			const names = importSpecifiers(n, grammar);
			for (const name of names) found.push({ name, line: n.startPosition.row + 1 });
			return; // import nodes have no nested imports
		}
		for (const c of n.children) visit(c);
	};
	visit(root);
	if (found.length === 0) return null;
	const kept = found.slice(0, MAX_IMPORTS);
	return {
		names: kept.map((f) => f.name),
		more: Math.max(0, found.length - MAX_IMPORTS),
		first: kept[0].line,
		last: kept[kept.length - 1].line,
	};
}

function importSpecifiers(n: TNode, grammar: CodeLangId): string[] {
	switch (n.type) {
		case "import_statement": {
			if (grammar === "python") {
				// python: `import os` / `import os.path as p` — dotted_name / aliased_import children
				const out: string[] = [];
				for (const c of n.namedChildren) {
					if (c.type === "dotted_name") out.push(c.text);
					else if (c.type === "aliased_import") {
						const dn = c.namedChildren.find((x) => x.type === "dotted_name");
						if (dn) out.push(dn.text);
					}
				}
				return out;
			}
			// TS/JS/TSX: `import { x } from "mod"` / `import "mod"`
			const src = n.childForFieldName("source");
			return src ? [unquote(src.text)] : [];
		}
		case "import_from_statement": {
			// python: `from .mod import x`
			const mod = n.childForFieldName("module_name");
			if (!mod) return [];
			const dots = n.text.match(/^\.+/)?.[0] ?? "";
			return [dots + mod.text];
		}
		case "use_declaration": {
			// rust: `use std::collections::HashMap;` → leftmost path segment
			const scope =
				n.childForFieldName("scope") ??
				n.namedChildren.find((c) => c.type === "scoped_identifier");
			if (!scope) return [];
			const seg = leftmostPathSegment(scope);
			return seg ? [seg] : [];
		}
		case "import_declaration": {
			// go: `import "x"` or `import ( "a" \n "b" )`
			const out: string[] = [];
			const walk = (x: TNode): void => {
				if (x.type === "import_spec") {
					const s = x.namedChildren.find(
						(c) => c.type === "interpreted_string_literal" || c.type === "raw_string_literal",
					);
					if (s) out.push(unquote(s.text));
					return;
				}
				for (const c of x.children) walk(c);
			};
			walk(n);
			return out;
		}
		default:
			return [];
	}
}

function unquote(s: string): string {
	const m = s.match(/^(['"`])(.*)\1$/);
	return m ? m[2] : s;
}

// ---------------------------------------------------------------------------
// Markdown outline (spec §3.4)
// ---------------------------------------------------------------------------

/**
 * ATX heading outline (`## Heading [line]`, depth ≤ 6), fence-aware.
 * Undefined when the document has no headings.
 */
export function buildMarkdownOutline(source: string): string[] | undefined {
	const lines = source.split("\n");
	const out: string[] = [];
	let fence: string | null = null; // opening fence run, including length
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const f = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (f) {
			if (fence === null) fence = f[1];
			// CommonMark: closing fence = same char, at least as long, no info string.
			else if (f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === "") fence = null;
			continue;
		}
		if (fence !== null) continue;
		const h = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (h && h[2].trim().length > 0) {
			out.push(`${h[1]} ${h[2].trim()} [${i + 1}]`);
		}
	}
	if (out.length === 0) return undefined;
	const total = out.length;
	if (total > MAX_MD_ENTRIES) {
		out.length = MAX_MD_ENTRIES;
		out.push(`… +${total - MAX_MD_ENTRIES} more entries（total ${total}；用 targeted read 取精確內容）`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// CSV / TSV profile (spec §3.4)
// ---------------------------------------------------------------------------

/**
 * `CSV — N rows, K columns:` + field names + up to 3 sample rows.
 * Empty file → still produced with 0 rows.
 */
export function buildCsvProfile(source: string, delimiter: "," | "\t"): string[] | undefined {
	// One pass, no per-character string building: only the header and the sample
	// rows are ever sliced out; every other record is just counted (~20MB input).
	const lines: string[] = []; // header + up to CSV_SAMPLE_ROWS sample records
	let records = 0;
	let rowStart = 0;
	let quoted = false;
	let blank = true;
	const endRow = (end: number) => {
		if (!blank) {
			records++;
			if (lines.length <= CSV_SAMPLE_ROWS) lines.push(source.slice(rowStart, end));
		}
		blank = true;
	};
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '"') {
			blank = false;
			if (quoted && source[i + 1] === '"') { i++; continue; }
			quoted = !quoted;
		} else if (c === "\n" && !quoted) {
			endRow(i);
			rowStart = i + 1;
		} else if (blank && !/\s/.test(c)) blank = false;
	}
	endRow(source.length);
	if (lines.length === 0) return ["CSV — 0 rows, 0 columns:"];
	const fields = splitCsvLine(lines[0], delimiter);
	const dataRows = lines.slice(1);
	const out: string[] = [`CSV — ${records - 1} rows, ${fields.length} columns:`];
	if (fields.length > 0) {
		const shown = fields.slice(0, MAX_LIST_ITEMS);
		out.push(
			`Fields: ${shown.join(", ")}${fields.length > MAX_LIST_ITEMS ? ` (+${fields.length - MAX_LIST_ITEMS})` : ""}`,
		);
	}
	const samples = dataRows.slice(0, CSV_SAMPLE_ROWS);
	if (samples.length > 0) {
		out.push("Sample:");
		for (const s of samples) {
			out.push(`  ${s.slice(0, CSV_SAMPLE_CHARS)}${s.length > CSV_SAMPLE_CHARS ? "…" : ""}`);
		}
	}
	return out;
}

/** Quote-aware single-line CSV split. */
function splitCsvLine(line: string, d: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQ = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else inQ = false;
			} else cur += c;
		} else if (c === '"') {
			inQ = true;
		} else if (c === d) {
			out.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	out.push(cur.trim());
	return out;
}

// ---------------------------------------------------------------------------
// JSONL profile (spec §3.4)
// ---------------------------------------------------------------------------

/**
 * `JSONL — N rows; keys in first 100 rows: …` + up to 2 sample rows.
 * Undefined when empty or >10% of lines fail to parse.
 */
export function buildJsonlProfile(source: string): string[] | undefined {
	const lines = source.split("\n").filter((l) => l.trim() !== "");
	if (lines.length === 0) return undefined;
	let ok = 0;
	let failed = 0;
	const keys: string[] = [];
	const keySet = new Set<string>();
	const samples: string[] = [];
	for (const line of lines) {
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			failed++;
			continue;
		}
		ok++;
		if (samples.length < JSONL_SAMPLE_ROWS) samples.push(line.slice(0, JSONL_SAMPLE_CHARS));
		if (ok <= 100 && obj && typeof obj === "object" && !Array.isArray(obj)) {
			for (const k of Object.keys(obj as Record<string, unknown>)) {
				if (!keySet.has(k)) {
					keySet.add(k);
					if (keys.length < MAX_LIST_ITEMS) keys.push(k);
				}
			}
		}
	}
	if (failed / lines.length > MAX_ERROR_LINE_RATIO) return undefined;
	const moreKeys = Math.max(0, keySet.size - MAX_LIST_ITEMS);
	const keyPart =
		keySet.size > 0 ? `${keys.join(", ")}${moreKeys > 0 ? ` (+${moreKeys})` : ""}` : "(none)";
	const out: string[] = [`JSONL — ${ok} rows; keys in first 100 rows: ${keyPart}:`];
	if (samples.length > 0) {
		out.push("Sample:");
		for (const s of samples) out.push(`  ${s}`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Shared renderer (spec §3.5)
// ---------------------------------------------------------------------------

/**
 * Wrap deterministic body lines in the shared STRUCTURE label and enforce the
 * 40,000-char backstop (truncation marker appended). Signatures are never
 * truncated per-entry — only this total-output backstop applies.
 */
export function renderStructure(
	path: string,
	lineCount: number,
	engine: EngineName,
	bodyLines: string[],
): string {
	const label =
		`[shunt] STRUCTURE — not file content. "${path}" (${lineCount} lines). ` +
		`Deterministic index (engine: ${engine}).\n` +
		`For exact content, use a targeted read (offset/limit or a :range selector).`;
	let out = `${label}\n\n${bodyLines.join("\n")}`;
	if (out.length > RENDER_CHAR_CAP) {
		out = out.slice(0, RENDER_CHAR_CAP);
		const nl = out.lastIndexOf("\n");
		if (nl > label.length) out = out.slice(0, nl);
		out += "\n… (truncated)";
	}
	return out;
}

/** Count source text lines (unlike rules.ts countLines, which scans raw bytes). */
export function countSourceLines(source: string): number {
	let lines = 0;
	let idx = source.indexOf("\n");
	while (idx !== -1) {
		lines++;
		idx = source.indexOf("\n", idx + 1);
	}
	if (source.length > 0 && source.charCodeAt(source.length - 1) !== 0x0a) lines++;
	return lines;
}
