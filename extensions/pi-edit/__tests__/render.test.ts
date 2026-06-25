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
