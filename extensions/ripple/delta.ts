// Pure before/after diagnostic comparison. No pi imports.
import type { Diag } from "../../shared/diagnostics/linters.ts";
export function diagnosticKey(d: Diag): string { return `${d.file}\0${d.line}\0${d.rule}`; }
export function newDiagnostics(before: Diag[], after: Diag[], max = 20): Diag[] {
	const old = new Set(before.map(diagnosticKey));
	const seen = new Set<string>();
	const fresh: Diag[] = [];
	for (const diag of after) {
		const key = diagnosticKey(diag);
		if (!old.has(key) && !seen.has(key)) { fresh.push(diag); seen.add(key); }
		if (fresh.length >= max) break;
	}
	return fresh;
}
export function renderDelta(diags: Diag[]): string {
	return `[ripple] POST-TURN LINT: ${diags.length} new diagnostic${diags.length === 1 ? "" : "s"}\n` +
		diags.map(d => `  ${d.file}:${d.line} ${d.severity} [${d.rule}] ${d.message}`).join("\n");
}
