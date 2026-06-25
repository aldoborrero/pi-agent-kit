import { describe, expect, it } from "bun:test";
import { runArgv } from "./run.ts";

describe("runArgv", () => {
	it("captures stdout", async () => {
		expect(
			(await runArgv(["echo", "hello"], { cwd: process.cwd() })).trim(),
		).toBe("hello");
	});

	it("caps output at maxBytes", async () => {
		const out = await runArgv(["head", "-c", "100000", "/dev/zero"], {
			cwd: process.cwd(),
			maxBytes: 1000,
		});
		expect(out.length).toBeLessThanOrEqual(1100);
	});

	it("returns text on failure without throwing", async () => {
		const out = await runArgv(["ls", "/no/such/xyz"], { cwd: process.cwd() });
		expect(out.length).toBeGreaterThan(0);
	});

	it("handles empty argv", async () => {
		expect(await runArgv([], { cwd: process.cwd() })).toBe("(empty command)");
	});
});
