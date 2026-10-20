import { describe, expect, test } from "bun:test";
import { loadNatives } from "./natives.ts";
import {
	createNativeShellOperations,
	NativeShellUnavailableError,
	shutdownNativeShellSessions,
} from "./shell-ops.ts";

const natives = await loadNatives();
const available = Boolean(natives?.Shell);
const d = available ? describe : describe.skip;

d("createNativeShellOperations (native Shell present)", () => {
	test("throws when constructed without a loaded addon", () => {
		// @ts-expect-error — deliberately invalid input
		expect(() => createNativeShellOperations(null)).toThrow(NativeShellUnavailableError);
	});

	test("runs a command and streams stdout", async () => {
		const ops = createNativeShellOperations(natives!);
		const chunks: Buffer[] = [];
		const result = await ops.exec("echo hi-from-brush", process.cwd(), {
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toContain("hi-from-brush");
	});

	test("propagates non-zero exit codes", async () => {
		const ops = createNativeShellOperations(natives!);
		const result = await ops.exec("exit 3", process.cwd(), { onData: () => {} });
		expect(result.exitCode).toBe(3);
	});

	test("persists shell state across calls (persistent session)", async () => {
		const ops = createNativeShellOperations(natives!);
		await ops.exec("PERSISTENCE_PROBE=agent-kit", process.cwd(), { onData: () => {} });
		const chunks: Buffer[] = [];
		await ops.exec("echo $PERSISTENCE_PROBE", process.cwd(), {
			onData: (data) => chunks.push(data),
		});
		expect(Buffer.concat(chunks).toString().trim()).toBe("agent-kit");
	});

	test("per-call env reaches the command", async () => {
		const ops = createNativeShellOperations(natives!);
		const chunks: Buffer[] = [];
		await ops.exec("echo $CALL_ENV_PROBE", process.cwd(), {
			onData: (data) => chunks.push(data),
			env: { CALL_ENV_PROBE: "per-call" },
		});
		expect(Buffer.concat(chunks).toString().trim()).toBe("per-call");
	});

	test("times out and maps to the SDK timeout contract", async () => {
		const ops = createNativeShellOperations(natives!);
		let threw: Error | null = null;
		await ops.exec("sleep 5", process.cwd(), {
			onData: () => {},
			timeout: 1, // seconds — SDK contract
		}).catch((error) => {
			threw = error as Error;
		});
		expect(threw).not.toBeNull();
		expect((threw as Error).message).toMatch(/^timeout:/);
	});

	test("quarantines the session after a timeout (state is reset)", async () => {
		const ops = createNativeShellOperations(natives!);
		await ops.exec("QUARANTINE_PROBE=1", process.cwd(), { onData: () => {} });
		await ops
			.exec("sleep 5", process.cwd(), { onData: () => {}, timeout: 1 })
			.catch(() => {});
		const chunks: Buffer[] = [];
		await ops.exec("echo ${QUARANTINE_PROBE:-clean}", process.cwd(), {
			onData: (data) => chunks.push(data),
		});
		expect(Buffer.concat(chunks).toString().trim()).toBe("clean");
	});

	test("no timeout means no timeout (no brush 1s default)", async () => {
		const ops = createNativeShellOperations(natives!);
		const chunks: Buffer[] = [];
		const result = await ops.exec("sleep 1.5; echo completed", process.cwd(), {
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toContain("completed");
	});

	test("maps abort to the SDK abort contract", async () => {
		const ops = createNativeShellOperations(natives!);
		const controller = new AbortController();
		const run = ops.exec("sleep 5", process.cwd(), {
			onData: () => {},
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 150);
		let threw: Error | null = null;
		await run.catch((error) => {
			threw = error as Error;
		});
		expect(threw).not.toBeNull();
		expect((threw as Error).message).toBe("aborted");
	});

	test("parallel calls succeed (busy session degrades to one-shot)", async () => {
		const ops = createNativeShellOperations(natives!);
		const results = await Promise.all([
			ops.exec("sleep 0.3; echo one", process.cwd(), { onData: () => {} }),
			ops.exec("sleep 0.3; echo two", process.cwd(), { onData: () => {} }),
		]);
		expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
	});
});

test("shutdownNativeShellSessions is safe to call at any time", () => {
	expect(() => shutdownNativeShellSessions()).not.toThrow();
});