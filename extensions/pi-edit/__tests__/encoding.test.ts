import { strict as assert } from "node:assert";
import { test } from "node:test";
import { detectEol, readEncoding, restore, stripBom } from "../src/encoding.ts";

test("stripBom detects and removes BOM", () => {
  assert.deepEqual(stripBom("﻿hi"), { bom: true, text: "hi" });
  assert.deepEqual(stripBom("hi"), { bom: false, text: "hi" });
});

test("detectEol picks CRLF when present, else LF", () => {
  assert.equal(detectEol("a\r\nb"), "\r\n");
  assert.equal(detectEol("a\nb"), "\n");
  assert.equal(detectEol("nolines"), "\n");
});

test("readEncoding normalizes to LF and remembers encoding", () => {
  const { text, encoding } = readEncoding("﻿a\r\nb\r\n");
  assert.equal(text, "a\nb\n");
  assert.deepEqual(encoding, { bom: true, eol: "\r\n" });
});

test("restore round-trips CRLF + BOM", () => {
  const raw = "﻿a\r\nb\r\n";
  const { text, encoding } = readEncoding(raw);
  assert.equal(restore(text, encoding), raw);
});

test("restore of LF/no-BOM is identity", () => {
  assert.equal(restore("a\nb\n", { bom: false, eol: "\n" }), "a\nb\n");
});
