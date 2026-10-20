/**
 * Native shell operations for pi's bash tool.
 *
 * Implements the SDK's `BashOperations` contract on top of the addon's
 * persistent brush-core `Shell` class — the same integration shape
 * pi-sandbox uses to swap the execution backend without touching the tool
 * itself (contract parity: same schema, same safeguards, same output
 * pipeline, since the SDK's bash tool keeps owning truncation, rendering
 * and status formatting).
 *
 * Session model (mirrors the oh-my-pi integration, reduced to v1 needs):
 * - one persistent `Shell` per process; commands run inside it so shell
 *   state (variables, functions) survives across tool calls;
 * - a parallel call degrades to an isolated one-shot `Shell` instead of
 *   queueing (commands stay independent, no head-of-line blocking);
 * - timeout, abort, and unexpected native errors quarantine the session
 *   (abort + drop) so the next call starts from a clean shell.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { buildShellFilesystem } from "./shell-vfs.ts";

/** The addon module, as returned by loadNatives(). */
export type NativesModule = typeof import("@oh-my-pi/pi-natives");

type NativeShell = InstanceType<NativesModule["Shell"]>;

export interface NativeShellOperationsOptions {
	/**
	 * Environment applied once when the persistent session is created
	 * (session-scoped variables). Per-call `env` from the bash tool is
	 * applied per command on top of it.
	 */
	sessionEnv?: Record<string, string>;
}

export class NativeShellUnavailableError extends Error {
	constructor() {
		super("Native shell unavailable (@oh-my-pi/pi-natives Shell not loaded).");
		this.name = "NativeShellUnavailableError";
	}
}

/** Every live Shell created by this module, for shutdown cleanup. */
const liveSessions = new Set<NativeShell>();

function killSession(shell: NativeShell | null | undefined): void {
	if (!shell) return;
	liveSessions.delete(shell);
	try {
		shell.abort();
	} catch {
		// already gone
	}
}

/**
 * Create `BashOperations` backed by the native brush-core session.
 *
 * Throws `NativeShellUnavailableError` immediately when called without a
 * loaded addon — callers should check `natives?.Shell` first and fall back
 * to the SDK's `createLocalBashOperations()`.
 */
export function createNativeShellOperations(
	natives: NativesModule,
	options?: NativeShellOperationsOptions,
): BashOperations {
	if (!natives?.Shell) throw new NativeShellUnavailableError();

	let session: NativeShell | null = null;
	let busy = false;

	function acquire(): { shell: NativeShell; persistent: boolean } {
		if (!busy) {
			busy = true;
			if (!session) {
				session = new natives.Shell({ sessionEnv: options?.sessionEnv });
				liveSessions.add(session);
			}
			return { shell: session, persistent: true };
		}
		// Session busy (parallel bash calls): isolated one-shot shell.
		const oneShot = new natives.Shell();
		liveSessions.add(oneShot);
		return { shell: oneShot, persistent: false };
	}

	function release(usedShell: NativeShell, persistent: boolean, broken: boolean): void {
		if (persistent) {
			busy = false;
			if (broken) {
				session = null;
				killSession(usedShell);
			}
		} else {
			// One-shot shells are never reused.
			liveSessions.delete(usedShell);
			if (broken) killSession(usedShell);
		}
	}

	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			const { shell, persistent } = acquire();
			let acceptingChunks = true;
			let broken = false;
			try {
				const result = await shell.run(
					{ command, cwd, env, timeoutMs: timeout, signal, filesystem: buildShellFilesystem() },
					(error, chunk) => {
						if (error || !acceptingChunks) return;
						onData(Buffer.from(chunk, "utf8"));
					},
				);

				// Contract mapping (pi's bash tool branches on these exact
				// error messages): timeout -> `timeout:<secs>`, abort -> `aborted`.
				// Both quarantine the session: brush state after a killed
				// command is not trustworthy.
				if (result.timedOut) {
					acceptingChunks = false;
					broken = true;
					const secs = Math.max(1, Math.ceil((timeout ?? 0) / 1000));
					throw new Error(`timeout:${secs}`);
				}
				if (result.cancelled || signal?.aborted) {
					acceptingChunks = false;
					broken = true;
					throw new Error("aborted");
				}

				return { exitCode: result.exitCode ?? null };
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!(error.message === "aborted" || error.message.startsWith("timeout:"))
				) {
					// Unexpected native failure (not the mapped timeout/abort
					// errors): treat the session as broken and rethrow — the SDK
					// tool surfaces the message with the output collected so far.
					broken = true;
				}
				throw error;
			} finally {
				release(shell, persistent, broken);
			}
		},
	};
}

/**
 * Abort and drop every live session (pi `session_shutdown` hook).
 */
export function shutdownNativeShellSessions(): void {
	for (const shell of liveSessions) {
		killSession(shell);
	}
	liveSessions.clear();
}