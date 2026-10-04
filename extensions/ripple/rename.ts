// Pure-ish git evidence scan; execFile argv only, no shell or pi imports.
import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
export interface RenameEvidence { old: string; new: string; references: string[]; }
export type RunGit = (args: string[], cwd: string) => Promise<string>;
const defaultRunGit: RunGit = (args, cwd) => new Promise((done, fail) => {
	execFile("git", args, { cwd, timeout: 5000, maxBuffer: 2_000_000, encoding: "utf8" }, (error, stdout) => error ? fail(error) : done(stdout));
});
/** Git C-quotes paths with special characters: `"old name.txt"` with backslash escapes. */
function unquotePath(p: string): string {
	if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
	return p.slice(1, -1)
		.replace(/(?:\\[0-7]{3})+/g, (bytes) => Buffer.from([...bytes.matchAll(/\\([0-7]{3})/g)].map((m) => parseInt(m[1], 8))).toString("utf8"))
		.replace(/\\(n|r|t|"|\\|([0-7]{1,3}))/g, (_, e: string, oct: string) =>
			oct ? String.fromCharCode(parseInt(oct, 8)) : e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e
		);
}
export function parseRenameStatus(text: string): Array<{ old: string; new: string }> {
	return text.split("\n").flatMap(line => {
		const m = /^R\d{1,3}\t([^\t\r\n]+)\t([^\t\r\n]+)\r?$/.exec(line);
		if (!m || m[1] === m[2]) return [];
		return [{ old: unquotePath(m[1]), new: unquotePath(m[2]) }];
	});
}
/**
 * `skip` filters renames before the (up to 3 per rename) `git grep` calls, so
 * already-nudged renames cost no grep and don't take one of the 5 slots.
 */
export async function detectRenames(
	cwd: string,
	run: RunGit = defaultRunGit,
	skip?: (rename: { old: string; new: string }) => boolean,
): Promise<RenameEvidence[]> {
	try {
		const statuses = await Promise.all([
			run(["-c", "core.fsmonitor=", "diff", "--no-ext-diff", "--find-renames", "--name-status", "--diff-filter=R"], cwd),
			run(["-c", "core.fsmonitor=", "diff", "--cached", "--no-ext-diff", "--find-renames", "--name-status", "--diff-filter=R"], cwd),
		]);
		const all = new Map<string, {old:string;new:string}>();
		for (const text of statuses) for (const item of parseRenameStatus(text)) all.set(`${item.old}\0${item.new}`, item);
		const found: RenameEvidence[] = [];
		for (const rename of [...all.values()].filter(rename => !skip?.(rename)).slice(0, 5)) {
			const patterns = [...new Set([rename.old, basename(rename.old), basename(rename.old, extname(rename.old))].filter(Boolean))];
			const references = new Set<string>();
			for (const pattern of patterns) {
				let grep: string;
				try { grep = await run(["-c", "core.fsmonitor=", "grep", "-n", "-z", "-F", "--", pattern], cwd); }
				catch { continue; } // git grep 1 means no matches
				// `-z`: `path\0line\0content\n` with the path verbatim (no C-quoting),
				// so a path containing `:` parses unambiguously.
				for (const m of grep.matchAll(/([^\0]+)\0(\d+)\0[^\n]*(?:\n|$)/g)) {
					if (m[1] === rename.old || m[1] === rename.new) continue;
					references.add(`${m[1]}:${m[2]}`);
					if (references.size >= 20) break;
				}
				if (references.size >= 20) break;
			}
			if (references.size) found.push({ ...rename, references: [...references] });
		}
		return found;
	} catch { return []; }
}
export function renderRenames(items: RenameEvidence[]): string {
	return `[ripple] RENAME: ${items.length} file${items.length === 1 ? "" : "s"} with old-name references\n` +
		items.map(item => `  ${item.old} → ${item.new}\n` + item.references.map(ref => `    ${ref}`).join("\n")).join("\n") +
		"\nReview these references; ask the user before a global rename if intent is unclear.";
}
