// Reproducible, warm-filesystem microbenchmarks. No LLM calls or terminal I/O.
// Run from the repo root: bun run --cwd extensions/pi-edit bench
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import register from "../src/extension.ts";
import { renderResult } from "../src/render.ts";
import { compactChange } from "../src/preview.ts";
import { withMutationQueues } from "../src/mutation.ts";

let tool: any;
register({
  registerTool(t: any) {
    tool = t;
  },
  events: { emit() {} },
} as any);
const dir = await mkdtemp(join(tmpdir(), "pi-edit-perf-"));
const native = createEditToolDefinition(dir);
const options = { expanded: false, isPartial: false };
const theme: any = {
  fg: (_: string, s: string) => s,
  bold: (s: string) => s,
  getFgAnsi: () => "",
};
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summarize = (values: number[]) => ({
  median_ms: +median(values).toFixed(3),
  min_ms: +Math.min(...values).toFixed(3),
  max_ms: +Math.max(...values).toFixed(3),
});
function fileData(lines: number) {
  return Array.from(
    { length: lines },
    (_, i) => `row_${String(i).padStart(7, "0")} = "${"a".repeat(42)}";\n`,
  ).join("");
}
const output: any = {
  environment: {
    runtime: process.versions.bun ?? process.version,
    platform: process.platform,
    pi: VERSION,
    rounds: 5,
  },
  edits: [],
  render: [],
  locks: [],
};
try {
  for (const [lines, count] of [
    [1024, 1],
    [16384, 1],
    [65536, 1],
    [16384, 20],
    [16384, 100],
  ]) {
    const content = fileData(lines!);
    const edits = Array.from({ length: count! }, (_, i) => {
      const id = Math.floor(((i + 1) * lines!) / (count! + 1));
      return {
        oldText: `row_${String(id).padStart(7, "0")}`,
        newText: `ROW_${String(id).padStart(7, "0")}`,
      };
    });
    const nativeParams = { path: "data.txt", edits };
    const legacyParams = { path: "data.txt", multi: edits };
    for (const mode of ["builtin", "plugin-native", "plugin-legacy"]) {
      const times: number[] = [];
      let result: any;
      for (let round = -1; round < 5; round++) {
        await writeFile(join(dir, "data.txt"), content);
        const t = performance.now();
        result =
          mode === "builtin"
            ? await native.execute(
                "bench",
                nativeParams,
                undefined,
                undefined,
                { cwd: dir } as any,
              )
            : await tool.execute(
                "bench",
                mode === "plugin-native" ? nativeParams : legacyParams,
                undefined,
                undefined,
                { cwd: dir },
              );
        const elapsed = performance.now() - t;
        if (round >= 0) times.push(elapsed);
      }
      const record = {
        mode,
        bytes: Buffer.byteLength(content),
        count,
        ...summarize(times),
        result_json_bytes: Buffer.byteLength(JSON.stringify(result)),
      };
      output.edits.push(record);
      console.log(JSON.stringify(record));
    }
  }

  for (const lines of [1024, 16384, 65536]) {
    const oldContent = fileData(lines);
    const newContent = oldContent.replace("row_0000010", "ROW_0000010");
    for (const format of ["historical-snapshot", "compact"]) {
      const result: any = {
        content: [{ type: "text", text: "Edited." }],
        details: {
          fileChanges: [
            {
              path: "/tmp/data.txt",
              oldContent,
              newContent,
              firstChangedLine: 11,
            },
          ],
        },
      };
      if (format === "compact")
        result.details.fileChanges =
          result.details.fileChanges.map(compactChange);
      let done!: () => void;
      const context: any = {
        state: {},
        toolCallId: `bench-${lines}`,
        invalidate: () => done(),
        isError: false,
      };
      const initialDone = new Promise<void>((resolve) => {
        done = resolve;
      });
      const first = performance.now();
      context.lastComponent = renderResult(result, options, theme, context);
      const firstSync = performance.now() - first;
      await initialDone;
      const firstTotal = performance.now() - first;
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t = performance.now();
        renderResult(result, options, theme, context);
        times.push(performance.now() - t);
      }
      const record = {
        format,
        bytes: Buffer.byteLength(oldContent),
        initial_sync_ms: +firstSync.toFixed(3),
        initial_total_ms: +firstTotal.toFixed(3),
        cached: summarize(times),
      };
      output.render.push(record);
      console.log(JSON.stringify(record));
    }
  }

  await writeFile(join(dir, "lock.txt"), "x");
  for (const count of [1, 100, 1000]) {
    const times: number[] = [];
    for (let round = 0; round < 10; round++) {
      const t = performance.now();
      await withMutationQueues(
        Array(count).fill("lock.txt"),
        dir,
        async () => {},
      );
      times.push(performance.now() - t);
    }
    const record = { same_file_references: count, ...summarize(times) };
    output.locks.push(record);
    console.log(JSON.stringify(record));
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ summary: output }, null, 2));
