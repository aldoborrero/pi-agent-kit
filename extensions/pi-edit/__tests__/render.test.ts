import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderResult } from "../src/render.ts";

class StubText {
  t = "";
  setText(v: string) {
    this.t = v;
  }
  getText() {
    return this.t;
  }
}
const theme: any = {
  fg: (_k: string, s: string) => s,
  bold: (s: string) => s,
  getFgAnsi: () => "",
};
function ctx(): any {
  return {
    state: {},
    invalidate() {},
    lastComponent: new StubText(),
    toolCallId: "t1",
    isError: false,
  };
}

test("renderResult returns a component for a fileChange and resolves async render", async () => {
  const result: any = {
    content: [{ type: "text", text: "Edited f.ts." }],
    details: {
      diff: "",
      fileChanges: [
        {
          path: "/tmp/f.ts",
          oldContent: "a\n",
          newContent: "b\n",
          firstChangedLine: 1,
          language: "typescript",
        },
      ],
    },
  };
  const c = renderResult(result, {} as any, theme, ctx());
  assert.ok(c && typeof (c as any).setText === "function");
  await new Promise((r) => setTimeout(r, 50));
});

test("renderResult shows error branch when ctx.isError", () => {
  const c = renderResult(
    { content: [{ type: "text", text: "boom" }] } as any,
    {} as any,
    theme,
    { ...ctx(), isError: true },
  );
  assert.ok(c);
});

import { renderCall } from "../src/render.ts";
import { Text } from "@earendil-works/pi-tui";
import { parseDiff } from "@xynogen/pix-pretty/diff";
import {
  renderSplit,
  resolveDiffColors,
} from "@xynogen/pix-pretty/diff-render";
import { MAX_RENDER_LINES } from "@xynogen/pix-pretty/config";

const options = { expanded: false, isPartial: false };
function changeResult(
  oldContent = "a\n",
  newContent = "b\n",
  firstChangedLine = 1,
) {
  return {
    content: [{ type: "text", text: "Edited." }],
    details: {
      fileChanges: [
        { path: "/tmp/a.txt", oldContent, newContent, firstChangedLine },
      ],
    },
  };
}

async function rendered(
  result: ReturnType<typeof changeResult>,
  context: ReturnType<typeof ctx>,
) {
  const ready = new Promise<void>((resolve) => {
    context.invalidate = resolve;
  });
  renderResult(result, options, theme, context);
  await ready;
  return renderResult(result, options, theme, context).render(120).join("\n");
}

test("renderCall counts edits[] and returns a real Pi component", () => {
  const context = ctx();
  context.lastComponent = undefined;
  const c = renderCall({ path: "a.txt", edits: [{}, {}] }, theme, context);
  assert.ok(c instanceof Text);
  assert.match(c.render(120).join("\n"), /2 edits/);
  assert.equal(typeof c.render, "function");
  context.lastComponent = c;
  assert.equal(renderCall({ path: "a.txt" }, theme, context), c);
});

test("renderResult refreshes same-length changes", async () => {
  const context = ctx();
  const first = await rendered(changeResult("a\n", "b\n"), context);
  const oldKey = context.state._piek;
  const second = await rendered(changeResult("a\n", "c\n"), context);
  assert.notEqual(context.state._piek, oldKey);
  assert.notEqual(first, second);
});

test("whole-file diff line numbers are not shifted by firstChangedLine", async () => {
  const result = changeResult(
    "one\ntwo\nthree\nfour\n",
    "one\ntwo\nTHREE\nfour\n",
    3,
  );
  const fc = result.details.fileChanges[0]!;
  const expected = await renderSplit(
    parseDiff(fc.oldContent, fc.newContent, 3),
    undefined,
    MAX_RENDER_LINES,
    resolveDiffColors(theme),
  );
  assert.equal(
    await rendered(result, ctx()),
    new Text(expected, 0, 0).render(120).join("\n"),
  );
});

test("expanding a result invalidates the truncated diff cache", async () => {
  const context = ctx();
  const result = changeResult();
  await rendered(result, context);
  const oldKey = context.state._piek;
  renderResult(result, { ...options, expanded: true }, theme, context);
  assert.notEqual(context.state._piek, oldKey);
});

test("pending diffs cannot overwrite a later error", async () => {
  const context = ctx();
  renderResult(changeResult(), options, theme, context);
  const error = renderResult(
    { content: [{ type: "text", text: "boom" }] },
    options,
    theme,
    { ...context, isError: true },
  );
  assert.match(error.render(120).join("\n"), /boom/);
  assert.equal(context.state._piek, undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(context.state._piek, undefined);
});
