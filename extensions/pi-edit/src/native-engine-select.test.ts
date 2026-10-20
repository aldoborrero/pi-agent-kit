import { afterEach, describe, expect, test } from "bun:test";
import { resolveEditEngine } from "./native-engine.ts";

const ENV = "PI_EDIT_ENGINE";
const saved = process.env[ENV];
const CWD = import.meta.dir;

afterEach(() => {
	if (saved === undefined) delete process.env[ENV];
	else process.env[ENV] = saved;
});

describe("resolveEditEngine", () => {
	test("defaults to pi (contract parity: original-content matching)", () => {
		delete process.env[ENV];
		expect(resolveEditEngine(CWD)).toBe("pi");
	});

	test("env forces the oh-my-pi engine", () => {
		process.env[ENV] = "1";
		expect(resolveEditEngine(CWD)).toBe("oh-my-pi");
		process.env[ENV] = "yes";
		expect(resolveEditEngine(CWD)).toBe("oh-my-pi");
	});

	test("env forces pi (strict: anything but 1/true/yes)", () => {
		process.env[ENV] = "0";
		expect(resolveEditEngine(CWD)).toBe("pi");
		process.env[ENV] = "native";
		expect(resolveEditEngine(CWD)).toBe("pi");
	});
});
