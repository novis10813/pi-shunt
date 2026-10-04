import { existsSync, readFileSync } from "node:fs";
import { stat, mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	isToolCallEventType, isEditToolResult, isWriteToolResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadDiagnosticsConfig } from "../../shared/diagnostics/config.ts";
import { lintFile, type Diag, type LintResult } from "../../shared/diagnostics/linters.ts";
import { diagnosticKey, newDiagnostics, renderDelta } from "./delta.ts";
import { detectRenames, renderRenames } from "./rename.ts";

function loadRippleConfig(cwd: string): { rename: boolean; measure: boolean } | null {
	// Synchronous read keeps the event hook contract uncomplicated.
	try {
		const path = join(cwd, ".pi", "ripple.json");
		if (!existsSync(path)) return { rename: true, measure: false };
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		if (["enabled", "rename", "measure"].some(k => raw[k] !== undefined && typeof raw[k] !== "boolean")) return null;
		return raw.enabled === false ? null : { rename: raw.rename !== false, measure: raw.measure === true };
	} catch { return null; }
}

/** ripple owns post-turn feedback only. No handler returns tool content. */
export default function ripple(pi: ExtensionAPI): void {
	type Baseline = { kind: "ok"; diagnostics: Diag[] } | { kind: "unavailable" };
	const baseline = new Map<string, Baseline>();
	const pendingCalls = new Map<string, { file: string; before: Baseline }>();
	const touched = new Set<string>();
	// Bash-originated renames (e.g. `git mv`) never populate `touched`; the
	// rename gate needs this separate signal or it would silently skip them.
	let hadBashCall = false;
	let lastReported: { file: string; keys: Set<string> }[] = [];
	const nudgedRenames = new Set<string>();
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) { hadBashCall = true; return; }
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const raw = event.input.path;
		if (typeof raw !== "string" || !raw || pendingCalls.has(event.toolCallId)) return;
		const cfg = loadDiagnosticsConfig(ctx.cwd);
		if (!cfg || !loadRippleConfig(ctx.cwd)) return;
		const file = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
		if (baseline.size + new Set([...pendingCalls.values()].map(v => v.file).filter(f => !baseline.has(f))).size >= 20 && !baseline.has(file) && ![...pendingCalls.values()].some(v => v.file === file)) return;
		let before = baseline.get(file);
		if (!before) {
			try {
				await stat(file);
				before = await lintFile(file, cfg);
			} catch (error) {
				before = event.toolName === "write" && (error as NodeJS.ErrnoException)?.code === "ENOENT"
					? { kind: "ok", diagnostics: [] } : { kind: "unavailable" };
			}
		}
		pendingCalls.set(event.toolCallId, { file, before });
	});
	pi.on("tool_result", (event) => {
		if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
		const record = pendingCalls.get(event.toolCallId);
		pendingCalls.delete(event.toolCallId);
		if (event.isError || !record) return;
		if (!baseline.has(record.file)) baseline.set(record.file, record.before);
		touched.add(record.file);
	});
	pi.on("turn_end", async (_event, ctx) => {
		try {
		const cfg = loadDiagnosticsConfig(ctx.cwd);
		const rippleCfg = loadRippleConfig(ctx.cwd);
		const fresh: Diag[] = []; 
		let survived = 0;
		let examined = 0;
		const reported: {file:string;keys:Set<string>}[] = [];
		if (cfg && rippleCfg) {
			// Limit concurrent linter processes, then apply results in target order.
			const targets = [...touched].filter(file => baseline.get(file)?.kind === "ok");
			const afterMap = new Map<string, LintResult>();
			let next = 0;
			await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
				while (next < targets.length) {
					const file = targets[next++];
					// lintFile is total (returns UNAVAILABLE), but the pool must not
					// let any throw take down the whole turn_end handler.
					try { afterMap.set(file, await lintFile(file, cfg)); }
					catch { afterMap.set(file, { kind: "unavailable" }); }
				}
			}));
			for (const file of targets) {
				const before = baseline.get(file);
				if (before?.kind !== "ok") continue;
				const after = afterMap.get(file);
				if (after?.kind !== "ok") continue;
				const oldReport = lastReported.find(item => item.file === file);
				if (oldReport) { examined++; survived += after.diagnostics.filter(d => oldReport.keys.has(diagnosticKey(d))).length; }
				const next = newDiagnostics(before.diagnostics, after.diagnostics, Math.max(1, Math.min(cfg.maxFindings, 20) - fresh.length));
				if (next.length) reported.push({file,keys:new Set(next.map(diagnosticKey))});
				fresh.push(...next);
				if (fresh.length >= Math.min(cfg.maxFindings, 20)) break;
			}
		}
		lastReported = reported;
		let renames = [];
		if (rippleCfg?.rename && (touched.size > 0 || hadBashCall)) {
			renames = await detectRenames(ctx.cwd, undefined, rename => nudgedRenames.has(JSON.stringify([rename.old, rename.new])));
			for (const rename of renames) nudgedRenames.add(JSON.stringify([rename.old, rename.new]));
		}
		if (rippleCfg?.measure) {
			try {
				const path = join(homedir(), ".local", "state", "ripple");
				await mkdir(path, { recursive: true });
				await appendFile(join(path, "measure.log"), JSON.stringify({ts:new Date().toISOString(),touched:touched.size,delta_new:fresh.length,delta_survived:examined ? survived : null,renames:renames.length}) + "\n");
			} catch { /* measurement must not alter model context */ }
		}
		// Boundary entries are journaled and survive reopening the session in a
		// separate pi process. A context-only pending variable is lost on restart.
		const entries: Array<{type:"custom_message";customType:string;content:string;display:false}> = [];
		if (fresh.length) entries.push({type:"custom_message",customType:"ripple-delta",content:renderDelta(fresh),display:false});
		if (renames.length) entries.push({type:"custom_message",customType:"ripple-rename",content:renderRenames(renames),display:false});
		if (entries.length) return { entries };
		} finally {
			baseline.clear(); touched.clear(); pendingCalls.clear(); hadBashCall = false;
		}
	});
	// Journaled messages survive process restarts; retire them from request
	// context once another user turn has begun. Do not edit the session itself.
	pi.on("context", (event) => {
		let previousUser = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if (event.messages[i].role === "user") {
				if (previousUser !== -1) { previousUser = i; break; }
				previousUser = i;
			}
		}
		// Need two user messages to know that a persisted nudge is old.
		const users = event.messages.filter(m => m.role === "user").length;
		if (users < 2) return;
		const messages = event.messages.filter((m, i) =>
			!(i < previousUser && m.role === "custom" && (m.customType === "ripple-delta" || m.customType === "ripple-rename")),
		);
		if (messages.length !== event.messages.length) return { messages };
	});
}
