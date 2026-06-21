import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import workflowExtension from "../extension.js";
import { createDynamicWorkflowTool } from "../dynamic.js";
import {
  closeWorkflowDb,
  countBacklogRecords,
  createBacklogRecord,
  getWorkflowRun,
  listWorkflowRuns,
  openWorkflowDb,
  upsertWorkflowRun,
} from "../db.js";

const repoRoot = mkdtempSync(join(tmpdir(), "workflows-smoke-"));

try {
  mkdirSync(join(repoRoot, ".pi", "workflows", "specs"), { recursive: true });
  writeFileSync(join(repoRoot, ".pi", "workflows", "specs", "instant.mjs"), `
export default {
  name: "instant",
  description: "instant smoke workflow",
  parseInput(raw) { return { task: raw.trim() }; },
  async createRun(input) {
    return { title: "instant:" + input.task, summary: input.task, state: { phase: "done" } };
  },
  async step(state) {
    return { kind: "complete", state, result: { ok: true }, summary: "instant complete" };
  },
};
`, "utf8");

  const db = openWorkflowDb(repoRoot);
  try {
    upsertWorkflowRun(db, {
      id: "smoke-run",
      workflow: "fix-one",
      description: "smoke",
      status: "completed",
      startedAt: "2026-05-29T00:00:00.000Z",
      endedAt: "2026-05-29T00:00:01.000Z",
      cwd: repoRoot,
      argsText: "test",
      summary: "ok",
      stepCount: 1,
      state: { phase: "done" },
      result: { ok: true },
    });
    createBacklogRecord(db, repoRoot, {
      id: "smoke-item",
      title: "smoke item",
      status: "open",
      body: "body",
      path: "",
      metadata: {
        id: "smoke-item",
        title: "smoke item",
        kind: "task",
        priority: "medium",
        source: "smoke",
        status: "open",
        createdAt: "2026-05-29T00:00:00.000Z",
      },
    });
    assert.equal(listWorkflowRuns(db, repoRoot).length, 1);
    assert.equal(countBacklogRecords(db, repoRoot, "open"), 1);
  } finally {
    closeWorkflowDb(db);
  }

  const registrations = {
    commands: [] as string[],
    tools: [] as string[],
    sessionStartHandlers: 0,
  };
  const notifications: Array<{ message: string; type?: string }> = [];
  const fakePi: Pick<ExtensionAPI, "on" | "registerCommand" | "registerTool"> = {
    on(event) {
      if (event === "session_start") registrations.sessionStartHandlers += 1;
    },
    registerCommand(name) {
      registrations.commands.push(name);
    },
    registerTool(tool) {
      registrations.tools.push(tool.name);
    },
  };
  workflowExtension(fakePi as ExtensionAPI);
  assert.deepEqual(registrations.commands.sort(), ["fuzz", "grind", "workflow"]);
  assert.deepEqual(registrations.tools.sort(), ["workflow_script"]);
  assert.equal(registrations.sessionStartHandlers, 1);

  const dynamicScopes: string[] = [];
  const dynamicUpdates: unknown[] = [];
  const dynamicTool = createDynamicWorkflowTool(async (_cwd, _agent, prompt, _signal, agentScope) => {
    dynamicScopes.push(agentScope);
    return `result:${prompt}`;
  });
  const dynamicResult = await dynamicTool.execute("workflow-script-smoke", {
    script: `
export const meta = { name: 'dynamic_smoke', description: 'dynamic smoke workflow' }
phase('Scan')
const result = await agent('inspect', { label: 'inspect repo' })
return { result }
`,
  }, undefined, (update) => dynamicUpdates.push(update), {
    cwd: repoRoot,
    hasUI: false,
    ui: {},
  } as any);
  assert.deepEqual(dynamicScopes, ["user"]);
  assert.ok(dynamicUpdates.length >= 2);
  assert.match(dynamicResult.content[0]?.type === "text" ? dynamicResult.content[0].text : "", /dynamic_smoke completed/);

  const commandRegistrations = {
    handlers: new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>(),
  };
  const fakeCommandPi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      commandRegistrations.handlers.set(name, spec.handler);
    },
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
  workflowExtension(fakeCommandPi);

  const workflowHandler = commandRegistrations.handlers.get("workflow");
  assert.ok(workflowHandler);

  const ctx = {
    cwd: repoRoot,
    signal: undefined,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      confirm: async () => true,
    },
  } as unknown as ExtensionCommandContext;

  await workflowHandler!("list", ctx);
  assert.ok(notifications.some((entry) => entry.message.includes("instant")));

  await workflowHandler!("run instant smoke-task", ctx);

  const db2 = openWorkflowDb(repoRoot);
  try {
    const runs = listWorkflowRuns(db2, repoRoot).filter((run) => run.workflow === "instant");
    assert.equal(runs.length, 1);
    const stored = getWorkflowRun(db2, repoRoot, runs[0]!.id);
    assert.ok(stored);
    assert.equal(stored.status, "completed");
    assert.deepEqual(stored.result, { ok: true });
  } finally {
    closeWorkflowDb(db2);
  }

  console.log("workflows smoke passed");
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}
