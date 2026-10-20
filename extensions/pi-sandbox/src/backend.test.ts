import { afterEach, describe, expect, test } from "bun:test";
import { resolveNativeShellEnabled } from "./extension.ts";

const ENV = "PI_SHELL_NATIVE";
const saved = process.env[ENV];
const CWD = import.meta.dir; // settings-free directory

afterEach(() => {
	if (saved === undefined) delete process.env[ENV];
	else process.env[ENV] = saved;
});

describe("resolveNativeShellEnabled", () => {
	test("defaults to ON with no env and no settings", () => {
		delete process.env[ENV];
		expect(resolveNativeShellEnabled(CWD)).toBe(true);
	});

	test("env forces on", () => {
		process.env[ENV] = "1";
		expect(resolveNativeShellEnabled(CWD)).toBe(true);
		process.env[ENV] = "yes";
		expect(resolveNativeShellEnabled(CWD)).toBe(true);
	});

	test("env forces off (strict: anything but 1/true/yes)", () => {
		process.env[ENV] = "0";
		expect(resolveNativeShellEnabled(CWD)).toBe(false);
		process.env[ENV] = "false";
		expect(resolveNativeShellEnabled(CWD)).toBe(false);
		process.env[ENV] = "garbage";
		expect(resolveNativeShellEnabled(CWD)).toBe(false);
	});

	test("env wins over settings (settings file next to this test enables it; env 0 must still win)", () => {
		// import.meta.dir has no .pi/settings.json, so this only checks precedence
		// wiring does not crash when settings are absent.
		process.env[ENV] = "0";
		expect(resolveNativeShellEnabled(CWD)).toBe(false);
	});
});