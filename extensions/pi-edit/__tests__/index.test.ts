/**
 * planEdits — pure planner unit tests.
 *
 * Covers the validation and dispatch logic in planEdits without touching the
 * filesystem. All assertions are on the returned Plan shape or on thrown error
 * messages.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { planEdits } from "../src/extension.ts";

describe("planEdits — mutually exclusive params", () => {
  test("patch + path together → throws /mutually exclusive/", () => {
    assert.throws(
      () =>
        planEdits({
          patch: "*** Begin Patch\n*** End Patch",
          path: "a.ts",
        }),
      /mutually exclusive/,
    );
  });

  test("patch + oldText together → throws /mutually exclusive/", () => {
    assert.throws(
      () =>
        planEdits({
          patch: "*** Begin Patch\n*** End Patch",
          oldText: "x",
        }),
      /mutually exclusive/,
    );
  });

  test("patch + newText together → throws /mutually exclusive/", () => {
    assert.throws(
      () =>
        planEdits({
          patch: "*** Begin Patch\n*** End Patch",
          newText: "y",
        }),
      /mutually exclusive/,
    );
  });

  test("patch + multi together → throws /mutually exclusive/", () => {
    assert.throws(
      () =>
        planEdits({
          patch: "*** Begin Patch\n*** End Patch",
          multi: [{ oldText: "x", newText: "y" }],
        }),
      /mutually exclusive/,
    );
  });
});

describe("planEdits — incomplete top-level edit", () => {
  test("path + oldText without newText → throws listing missing newText", () => {
    assert.throws(() => planEdits({ path: "a.ts", oldText: "x" }), /newText/);
  });

  test("oldText alone without path/newText → throws listing missing fields", () => {
    assert.throws(() => planEdits({ oldText: "x" }), /path/);
  });

  test("path + newText without oldText → throws listing missing oldText", () => {
    assert.throws(() => planEdits({ path: "a.ts", newText: "y" }), /oldText/);
  });
});

describe("planEdits — classic mode", () => {
  test("multi items inherit top-level path", () => {
    const plan = planEdits({
      path: "a.ts",
      multi: [{ oldText: "x", newText: "y" }],
    });
    assert.equal(plan.mode, "classic");
    assert(plan.mode === "classic");
    assert.equal(plan.edits.length, 1);
    assert.deepEqual(plan.edits[0], {
      path: "a.ts",
      oldText: "x",
      newText: "y",
    });
  });

  test("top-level complete edit prepended before multi items", () => {
    const plan = planEdits({
      path: "a.ts",
      oldText: "x",
      newText: "y",
      multi: [{ oldText: "p", newText: "q" }],
    });
    assert.equal(plan.mode, "classic");
    assert(plan.mode === "classic");
    assert.equal(plan.edits.length, 2);
    assert.deepEqual(plan.edits[0], {
      path: "a.ts",
      oldText: "x",
      newText: "y",
    });
    assert.deepEqual(plan.edits[1], {
      path: "a.ts",
      oldText: "p",
      newText: "q",
    });
  });

  test("top-level complete edit alone → single edit", () => {
    const plan = planEdits({ path: "a.ts", oldText: "x", newText: "y" });
    assert.equal(plan.mode, "classic");
    assert(plan.mode === "classic");
    assert.equal(plan.edits.length, 1);
    assert.deepEqual(plan.edits[0], {
      path: "a.ts",
      oldText: "x",
      newText: "y",
    });
  });

  test("multi item with its own path overrides top-level path", () => {
    const plan = planEdits({
      path: "default.ts",
      multi: [
        { path: "override.ts", oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });
    assert.equal(plan.mode, "classic");
    assert(plan.mode === "classic");
    assert.equal(plan.edits.length, 2);
    assert.equal(plan.edits[0]!.path, "override.ts");
    assert.equal(plan.edits[1]!.path, "default.ts");
  });
});

describe("planEdits — patch mode", () => {
  test("valid patch string → mode:patch with parsed ops", () => {
    const patch = "*** Begin Patch\n*** Add File: f.ts\n+hi\n*** End Patch";
    const plan = planEdits({ patch });
    assert.equal(plan.mode, "patch");
    assert(plan.mode === "patch");
    assert.equal(plan.ops.length, 1);
    assert.equal(plan.ops[0]!.kind, "add");
    assert(plan.ops[0]!.kind === "add");
    assert.equal(plan.ops[0]!.path, "f.ts");
  });
});

describe("planEdits — no edits provided", () => {
  test("empty params → throws /No edits provided/", () => {
    assert.throws(() => planEdits({}), /No edits provided/);
  });

  test("only multi:[] → throws /No edits provided/", () => {
    assert.throws(() => planEdits({ multi: [] }), /No edits provided/);
  });
});
