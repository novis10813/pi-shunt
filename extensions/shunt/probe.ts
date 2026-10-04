// Pure (no pi imports) bounded file probe: Node can test it directly.
import { createReadStream } from "node:fs";
import { TEXT_PROBE_BYTES } from "./rules.ts";

export interface FileProbe { isText: boolean; lines: number; truncated: boolean; }

/**
 * Stream a file, counting lines and detecting binary, with early exit once
 * more than `minLines` lines are confirmed. Bounded memory — the file is never
 * loaded whole — so a multi-GB file cannot OOM or block the event loop.
 * Resolves undefined when the file cannot be opened or the probe times out.
 * `truncated` means the count stopped before EOF (the reported count is then a
 * lower bound).
 */
export function probeLargeFile(abs: string, minLines: number, timeoutMs = 2000): Promise<FileProbe | undefined> {
	return new Promise((resolvePromise) => {
		const stream = createReadStream(abs, { highWaterMark: 256 * 1024 });
		const timer = setTimeout(() => {
			stream.destroy();
			resolvePromise(undefined);
		}, timeoutMs);
		const settle = (value: FileProbe | undefined) => {
			clearTimeout(timer);
			resolvePromise(value);
		};
		let lines = 0;
		let isText = true;
		let firstProbe = Buffer.alloc(0);
		let firstProbeDone = false;
		let lastByte: number | null = null;
		const finish = (truncated: boolean) => {
			stream.destroy();
			if (!truncated && lastByte !== null && lastByte !== 0x0a) lines += 1; // final line w/o newline
			settle({ isText, lines, truncated });
		};
		stream.on("data", (chunk: Buffer) => {
			if (!firstProbeDone) {
				const take = Math.min(chunk.length, TEXT_PROBE_BYTES - firstProbe.length);
				if (take > 0) firstProbe = Buffer.concat([firstProbe, chunk.subarray(0, take)]);
				if (firstProbe.length >= TEXT_PROBE_BYTES) firstProbeDone = true;
				if (firstProbe.includes(0)) {
					isText = false;
					finish(true); // binary: stop counting, caller passes through
					return;
				}
			}
			let idx = -1;
			while ((idx = chunk.indexOf(0x0a, idx + 1)) !== -1) {
				lines += 1;
				if (lines > minLines) {
					finish(true); // early exit: count is a lower bound (minLines + 1)
					return;
				}
			}
			if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
		});
		stream.on("end", () => finish(false));
		stream.on("error", () => settle(undefined));
	});
}
