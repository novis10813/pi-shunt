// Node test runner alias for the globally installed pi package (no npm deps).
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
let piDistUrl;
export function initialize(data) { piDistUrl = data?.piDist; }
export function findPiDist() {
	const candidate = resolvePath(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	return existsSync(candidate) ? candidate : undefined;
}
export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent" && piDistUrl && context.parentURL?.includes("/extensions/ripple/")) {
		return { url: piDistUrl, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
