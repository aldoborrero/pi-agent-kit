import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRealWorkspace, createVirtualWorkspace } from "../src/workspace.ts";

const piStub = { events: { emit() {} } } as any;

test("real workspace preserves CRLF + BOM on write-back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piedit-"));
  const fp = join(dir, "f.txt");
  await writeFile(fp, "﻿a\r\nb\r\n", "utf-8");
  const ws = createRealWorkspace(piStub);
  const text = await ws.readText(fp);
  assert.equal(text, "a\nb\n"); // engine sees LF
  await ws.writeText(fp, "a\nB\n"); // engine writes LF
  assert.equal(await readFile(fp, "utf-8"), "﻿a\r\nB\r\n"); // disk keeps CRLF+BOM
});

test("virtual workspace is in-memory and never mutates disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piedit-"));
  const fp = join(dir, "f.txt");
  await writeFile(fp, "x\n", "utf-8");
  const ws = createVirtualWorkspace(dir);
  await ws.writeText(fp, "y\n");
  assert.equal(await ws.readText(fp), "y\n");
  assert.equal(await readFile(fp, "utf-8"), "x\n"); // disk untouched
});
