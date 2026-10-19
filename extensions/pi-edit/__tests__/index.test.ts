/**
 * planEdits — pure planner unit tests.
 *
 * Covers the validation and dispatch logic in planEdits without touching the
 * filesystem. All assertions are on the returned Plan shape or on thrown error
 * messages.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { planEdits, prepareArguments } from "../src/extension.ts";

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

describe("planEdits — Pi edits[]", () => {
  test("dispatches edits[] without translating to positional multi", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    assert.deepEqual(planEdits({ path: "a.ts", edits }), {
      mode: "native",
      path: "a.ts",
      edits,
    });
  });

  test("requires path and at least one edit", () => {
    assert.throws(
      () => planEdits({ edits: [{ oldText: "a", newText: "b" }] }),
      /requires a path/,
    );
    assert.throws(() => planEdits({ path: "a.ts", edits: [] }), /at least one/);
  });

  test("rejects mixed native and legacy modes", () => {
    const args = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
    for (const extra of [
      { oldText: "a" },
      { newText: "b" },
      { multi: [] },
      { patch: "*** Begin Patch\n*** End Patch" },
    ]) {
      assert.throws(
        () => planEdits({ ...args, ...extra }),
        /mutually exclusive/,
      );
    }
  });
});

describe("prepareArguments — Pi 0.87 model compatibility", () => {
  test("accepts arrays, JSON arrays, single objects and JSON objects", () => {
    const edit = { oldText: "a", newText: "b" };
    for (const edits of [
      [edit],
      JSON.stringify([edit]),
      edit,
      JSON.stringify(edit),
    ]) {
      const input = { path: "a.ts", edits };
      assert.deepEqual(prepareArguments(input), {
        path: "a.ts",
        edits: [edit],
      });
      assert.equal(input.edits, edits, "does not mutate the raw call");
    }
  });

  test("leaves invalid values for schema validation", () => {
    for (const edits of ["not json", 42, null, { oldText: "a" }]) {
      assert.deepEqual(prepareArguments({ edits }), { edits });
    }
  });

  test("a legacy pair next to edits[] becomes one more edit", () => {
    const input = {
      path: "a.ts",
      edits: [{ oldText: "p", newText: "q" }],
      oldText: "x",
      newText: "y",
    };
    assert.deepEqual(prepareArguments(input), {
      path: "a.ts",
      edits: [
        { oldText: "p", newText: "q" },
        { oldText: "x", newText: "y" },
      ],
    });
    assert.equal(input.edits.length, 1, "does not mutate the raw call");
  });

  test("keeps legacy and patch inputs unchanged", () => {
    for (const input of [
      { path: "a.ts", oldText: "a", newText: "b" },
      { multi: [{ path: "a.ts", oldText: "a", newText: "b" }] },
      { patch: "*** Begin Patch\n*** End Patch" },
    ])
      assert.deepEqual(prepareArguments(input), input);
  });
});
