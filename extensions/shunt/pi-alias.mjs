/**
 * test-shunt.mjs — resolve hook that maps the bare specifier
 * "@earendil-works/pi-coding-agent" to the globally installed pi package.
 *
 * This lets `node test-shunt.mjs` import index.ts (which imports pi) outside
 * of a pi process, without adding node_modules to the repo.
 */
import { dirname, join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

let piDistUrl;

export function initialize(data) {
	piDistUrl = data?.piDist;
}

export function findPiDist() {
	// node binary lives at <nvm>/lib/node_modules/..., so the global tree is two levels up
	const nodeDir = dirname(process.execPath);
	const candidate = resolvePath(nodeDir, "../lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	return existsSync(candidate) ? candidate : undefined;
}

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent" && piDistUrl && context.parentURL?.includes("/extensions/shunt/")) {
		return { url: piDistUrl, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
