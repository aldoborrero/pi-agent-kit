import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	executeOhMyPiHashline,
	hasNativeEditEngine,
	hashlineSnapshotTag,
	resetEditStore,
} from "./native-engine.ts";
import { createHashlineReadDefinition } from "./read-wrapper.ts";

const d = hasNativeEditEngine() ? describe : describe.skip;

const mockPi = { events: { emit: () => {} } } as unknown as Parameters<typeof executeOhMyPiHashline>[0];

let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "pi-edit-hashline-"));
});

afterAll(() => {
	resetEditStore();
	rmSync(workDir, { recursive: true, force: true });
});

function write(path: string, content: string): string {
	const absolute = join(workDir, path);
	writeFileSync(absolute, content, "utf-8");
	return absolute;
}

function edit(input: string) {
	return executeOhMyPiHashline(mockPi, { input }, workDir);
}

/** Simulate the read wrapper for a path: returns the header it prepends. */
function read(path: string): { header: string; tag: string } {
	const absolute = write(path, readFileSync(join(workDir, path), "utf-8"));
	const tag = hashlineSnapshotTag(absolute);
	if (!tag) throw new Error(`no tag for ${path}`);
	return { header: `[${path}#${tag}]`, tag };
}

d("hashline end-to-end (read → tag → engine)", () => {
	test("read wrapper prepends [path#TAG] and keeps the body intact", () => {
		write("r.ts", "uno\ndos\ntres\n");
		const definition = createHashlineReadDefinition(workDir);
		const ctx = { cwd: workDir, hasUI: false } as never;
		// @ts-expect-error — mock host execute signature
		const promise = definition.execute("t1", { path: "r.ts" }, undefined, undefined, ctx);
		return promise.then((result: { content: Array<{ type: string; text: string }> }) => {
			const text = result.content[0]!.text;
			expect(text).toMatch(/^\[[^\]]+#[0-9A-F]{4}\]\n/);
			expect(text).toContain("uno\ndos\ntres");
		});
	});

	test("PUT range replaces lines via line anchors", async () => {
		write("p.ts", "uno\ndos\ntres\n");
		const { tag } = read("p.ts");
		const result = await edit(`*** Begin Patch\n[p.ts#${tag}]\nPUT 2.=2:\n+DOS\n*** End Patch\n`);
		expect(result.ok).toBe(true);
		expect(readFileSync(join(workDir, "p.ts"), "utf-8")).toBe("uno\nDOS\ntres\n");
	});

	test("CUT removes a line range", async () => {
		write("c.ts", "keep1\ncut\ncut\ncut\nkeep2\n");
		const { tag } = read("c.ts");
		const result = await edit(`*** Begin Patch\n[c.ts#${tag}]\nCUT 2.=4\n*** End Patch\n`);
		expect(result.ok).toBe(true);
		expect(readFileSync(join(workDir, "c.ts"), "utf-8")).toBe("keep1\nkeep2\n");
	});

	test("gap anchors: PUT >1: inserts after line 1", async () => {
		write("g.ts", "primero\nsegundo\n");
		const { tag } = read("g.ts");
		const result = await edit(`*** Begin Patch\n[g.ts#${tag}]\nPUT >1:\n+medio\n*** End Patch\n`);
		expect(result.ok).toBe(true);
		expect(readFileSync(join(workDir, "g.ts"), "utf-8")).toBe("primero\nmedio\nsegundo\n");
	});

	test("MV renames the file", async () => {
		write("m.ts", "contenido\n");
		const { tag } = read("m.ts");
		const result = await edit(`*** Begin Patch\n[m.ts#${tag}]\nMV renombrado.ts\n*** End Patch\n`);
		expect(result.ok).toBe(true);
		expect(readFileSync(join(workDir, "renombrado.ts"), "utf-8")).toBe("contenido\n");
	});

	test("REM deletes the file", async () => {
		write("rem.ts", "adios\n");
		const { tag } = read("rem.ts");
		const result = await edit(`*** Begin Patch\n[rem.ts#${tag}]\nREM\n*** End Patch\n`);
		expect(result.ok).toBe(true);
		let exists = true;
		try {
			readFileSync(join(workDir, "rem.ts"), "utf-8");
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);
	});

	test("stale tag: file changed after read is rejected", async () => {
		write("s.ts", "version-a\nversion-b\n");
		const { tag } = read("s.ts");
		writeFileSync(join(workDir, "s.ts"), "cambio-externo\n");
		const result = await edit(`*** Begin Patch\n[s.ts#${tag}]\nPUT 1.=1:\n+x\n*** End Patch\n`);
		expect(result.ok).toBe(false);
	});

	test("wrong tag is rejected", async () => {
		write("w.ts", "contenido\n");
		read("w.ts");
		const result = await edit(`*** Begin Patch\n[w.ts#ZZZZ]\nPUT 1.=1:\n+x\n*** End Patch\n`);
		expect(result.ok).toBe(false);
	});

	test("never-read file is rejected with a read-first hint", async () => {
		write("nr.ts", "nunca leido\n");
		const result = await edit(`*** Begin Patch\n[nr.ts#AAAA]\nPUT 1.=1:\n+x\n*** End Patch\n`);
		expect(result.ok).toBe(false);
	});

	test("payload without Begin/End Patch markers is rejected", async () => {
		const result = await edit("[random.ts#AAAA]\nPUT 1.=1:\n+x\n");
		expect(result.ok).toBe(false);
	});
});