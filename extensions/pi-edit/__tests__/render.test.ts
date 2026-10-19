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

import { compactChange } from "../src/preview.ts";

test("cache hits and presentation changes do not serialize snapshots or recompute hunks", async () => {
  const context = ctx();
  const result = changeResult("a\n", "b\n");
  const change = result.details.fileChanges[0]!;
  Object.defineProperty(change, "toJSON", {
    value() {
      throw new Error("snapshot serialized");
    },
  });
  await rendered(result, context);
  const preview = context.state._pieViews[0].preview;
  const key = context.state._piek;
  renderResult(result, options, theme, context);
  assert.equal(context.state._piek, key);
  renderResult(result, { ...options, expanded: true }, theme, context);
  assert.equal(context.state._pieViews[0].preview, preview);
  const recolored = { ...theme, getFgAnsi: () => "\x1b[32m" };
  renderResult(result, options, recolored, context);
  assert.equal(context.state._pieViews[0].preview, preview);
});

test("legacy same-object content updates replace the cached preview", async () => {
  const context = ctx();
  const result = changeResult();
  const first = await rendered(result, context);
  result.details.fileChanges[0]!.newContent = "c\n";
  const second = await rendered(result, context);
  assert.notEqual(first, second);
});

test("compact historical results render after JSON round-trip, without reading files", async () => {
  const result = changeResult("a\n", "b\n");
  const compact = {
    ...result,
    details: { fileChanges: result.details.fileChanges.map(compactChange) },
  };
  const context = ctx();
  const ready = new Promise<void>((resolve) => {
    context.invalidate = resolve;
  });
  renderResult(JSON.parse(JSON.stringify(compact)), options, theme, context);
  await ready;
  assert.match(String(context.state._piet), /b/);
});

test("resize callbacks belong to the component, not a global listener", async () => {
  const context = ctx();
  const result = changeResult();
  await rendered(result, context);
  let invalidations = 0;
  context.invalidate = () => {
    invalidations++;
  };
  const listeners = process.stdout.listenerCount("resize");
  const component = renderResult(result, options, theme, context);
  component.render(80);
  component.render(80);
  component.render(100);
  assert.equal(invalidations, 1);
  assert.equal(process.stdout.listenerCount("resize"), listeners);
});

test("completed renderer callbacks do not retain closed session owners", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const module = new URL("../src/render.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--eval",
      `
    const {renderResult}=await import(${JSON.stringify(module)});
    function make() {
      const owner={calls:0};
      const ctx={state:{},toolCallId:'retention-check',invalidate:()=>owner.calls++};
      renderResult({details:{fileChanges:[{path:'f',oldContent:'a\\n',newContent:'b\\n'}]}},
        {expanded:false,isPartial:false}, {fg:(_,s)=>s,bold:s=>s,getFgAnsi:()=>''},ctx);
      return new WeakRef(owner);
    }
    const ref=make();
    for(let i=0;i<20;i++) {
      await new Promise(resolve=>setTimeout(resolve,10));
      Bun.gc(true);
      if(!ref.deref()){console.log('released');break;}
    }
  `,
    ],
    { timeout: 5000 },
  );
  assert.match(stdout, /released/);
});

test("a preview that stops short of the change says so once it is fully shown", async () => {
  const added =
    Array.from({ length: 600 }, (_, i) => `ins ${i}`).join("\n") + "\n";
  const result = changeResult("", added);
  const note = /88 more diff lines not shown/;

  // Collapsed, only part of the stored preview is visible.
  assert.doesNotMatch(await rendered(result, ctx()), note);

  const context = ctx();
  const ready = new Promise<void>((resolve) => {
    context.invalidate = resolve;
  });
  const expanded = { ...options, expanded: true };
  renderResult(result, expanded, theme, context);
  await ready;
  const text = renderResult(result, expanded, theme, context)
    .render(120)
    .join("\n");
  assert.match(text, /ins 511/);
  assert.match(text, note);
});

test("a historical diff skipped for lack of time is computed on a later render", async () => {
  const change = (name: string) => ({
    path: `/tmp/${name}.txt`,
    oldContent: `${name} old\n`,
    newContent: `${name} new\n`,
    firstChangedLine: 1,
  });
  const result = {
    content: [{ type: "text", text: "Edited." }],
    details: { fileChanges: [change("first"), change("second")] },
  };
  const context = ctx();
  const realNow = Date.now;
  // The clock jumps past the render deadline once the first diff is done.
  let reads = 0;
  Date.now = () => realNow() + (reads++ > 1 ? 60_000 : 0);
  try {
    renderResult(result as any, options, theme, context);
  } finally {
    Date.now = realNow;
  }
  const omitted = () =>
    (context.state._pieViews as { preview: { omitted?: string } }[]).map(
      (view) => view.preview.omitted !== undefined,
    );
  assert.deepEqual(omitted(), [false, true]);

  renderResult(result as any, options, theme, context);
  assert.deepEqual(omitted(), [false, false]);
});

test("long-line word diffs use the linear renderer", async () => {
  const before =
    Array.from({ length: 200 }, (_, i) => `a${i}`).join(" ") + "\n";
  const after = Array.from({ length: 200 }, (_, i) => `b${i}`).join(" ") + "\n";
  const text = await rendered(changeResult(before, after), ctx());
  assert.match(text, /word highlighting disabled by budget/);
  assert.match(text, /a0/);
  assert.match(text, /b0/);
});
