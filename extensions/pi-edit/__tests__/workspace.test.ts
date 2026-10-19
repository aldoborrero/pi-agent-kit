import { strict as assert } from "node:assert";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
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

test("real workspace gives a file written back after a delete its permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piedit-"));
  const fp = join(dir, "run.sh");
  await writeFile(fp, "#!/bin/sh\n", "utf-8");
  await chmod(fp, 0o755);
  const ws = createRealWorkspace(piStub);
  const text = await ws.readText(fp);
  await ws.deleteFile(fp);
  await ws.writeText(fp, text);
  assert.equal((await stat(fp)).mode & 0o777, 0o755);
});

test("real workspace gives a moved file the permissions of its source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piedit-"));
  const from = join(dir, "run.sh");
  const to = join(dir, "bin", "run.sh");
  await writeFile(from, "#!/bin/sh\r\n", "utf-8");
  await chmod(from, 0o755);
  const ws = createRealWorkspace(piStub);
  await ws.writeText(to, await ws.readText(from), from);
  assert.equal((await stat(to)).mode & 0o777, 0o755);
  assert.equal(await readFile(to, "utf-8"), "#!/bin/sh\r\n");
});

test("virtual workspace sees a directory as existing but unreadable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piedit-"));
  await mkdir(join(dir, "sub"));
  const ws = createVirtualWorkspace(dir);
  assert.equal(await ws.exists(join(dir, "sub")), true);
  assert.equal(await ws.exists(join(dir, "missing")), false);
  await assert.rejects(() => ws.readText(join(dir, "sub")), /EISDIR/);
  await assert.rejects(() => ws.deleteFile(join(dir, "sub")), /EISDIR/);
  await assert.rejects(() => ws.readText(join(dir, "missing")), /File not found/);
});
