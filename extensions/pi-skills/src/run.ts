/** Bounded, shell-free, non-throwing command execution for directive interpolation. */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 16_384;

export interface RunOptions {
	cwd: string;
	timeoutMs?: number;
	maxBytes?: number;
}

/**
 * Spawn argv directly (NO shell). Returns combined stdout+stderr, capped at
 * maxBytes. Never throws: timeouts, non-zero exits, and spawn errors all
 * resolve to descriptive text so skill loading always completes.
 *
 * Uses Node's child_process so it runs under Pi's host runtime (not just Bun).
 */
export function runArgv(argv: string[], opts: RunOptions): Promise<string> {
	if (!argv.length) return Promise.resolve("(empty command)");
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (text: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(text);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(argv[0]!, argv.slice(1), {
				cwd: opts.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			finish(
				`[command failed: ${err instanceof Error ? err.message : String(err)}]`,
			);
			return;
		}

		const chunks: Buffer[] = [];
		let bytes = 0;
		const collect = (buf: Buffer) => {
			if (bytes >= maxBytes) return;
			bytes += buf.length;
			chunks.push(buf);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		const timer = setTimeout(() => {
			child.kill();
			finish(format(chunks, bytes, maxBytes, "[output truncated: timed out]"));
		}, timeoutMs);

		child.on("error", (err) => finish(`[command failed: ${err.message}]`));
		child.on("close", () => finish(format(chunks, bytes, maxBytes)));
	});
}

function format(
	chunks: Buffer[],
	bytes: number,
	maxBytes: number,
	truncMarker = "[output truncated]",
): string {
	const combined = Buffer.concat(chunks).toString("utf-8").trimEnd();
	if (bytes > maxBytes)
		return `${combined.slice(0, maxBytes)}\n… ${truncMarker}`;
	return combined || "(no output)";
}
