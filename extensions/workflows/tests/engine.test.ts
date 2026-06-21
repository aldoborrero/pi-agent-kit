import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgsText, runStepWorkflow } from "../engine.js";
import { closeWorkflowDb, getWorkflowRun, openWorkflowDb } from "../db.js";
import type {
  CodeWorkflowContext,
  WorkflowLogger,
  WorkflowRunRecord,
  WorkflowSpec,
  WorkflowStore,
} from "../api.js";

function makeRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "workflows-engine-test-"));
}

function makeLogger(): WorkflowLogger {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    event: async () => {},
  };
}

function makeContext(repoRoot: string, runId: string): CodeWorkflowContext {
  const store: WorkflowStore = {
    getRun: async <TState = unknown, TResult = unknown>() => ({ id: runId } as WorkflowRunRecord<TState, TResult>),
    saveRun: async () => {},
    updateRun: async () => {},
  };
  return {
    runId,
    cwd: repoRoot,
    log: makeLogger(),
    store,
    control: {
      isStopRequested: async () => false,
      assertNotStopped: async () => {},
      stop: async () => {},
    },
    ui: {
      notify: () => {},
      confirm: async () => true,
    },
    signal: undefined,
    env: {},
    artifacts: {
      write: async (_kind, name) => join(repoRoot, name),
    },
    candidates: {
      upsert: async () => {},
      list: async () => [],
    },
    agents: {
      run: async () => ({
        ok: true,
        output: "ok",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    },
    backlog: {
      list: async () => [],
      count: async () => 0,
      create: async () => {
        throw new Error("unused");
      },
      move: async () => {
        throw new Error("unused");
      },
      claim: async () => [],
      note: async () => {},
      pick: async () => [],
    },
    worktrees: {
      create: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
    },
    review: {
      reviewCandidate: async () => ({
        agent: "review",
        verdict: "pass",
        summary: "ok",
        raw: "",
      }),
      judgeCandidates: async () => [],
    },
    merge: {
      commitIfNeeded: async () => undefined,
      mergeCandidate: async () => ({ merged: false }),
    },
  };
}

test("parseArgsText supports loose object input", () => {
  assert.deepEqual(parseArgsText("{task:'Add retry logic', rounds: 2}"), {
    task: "Add retry logic",
    rounds: 2,
  });
  assert.equal(parseArgsText("plain task"), "plain task");
});

test("runStepWorkflow persists a waiting run and resumes it on the next invocation", async () => {
  const repoRoot = makeRepoRoot();
  let createCalls = 0;
  let stepCalls = 0;

  const spec: WorkflowSpec<string, { phase: "wait" | "done" }, { ok: true }> = {
    name: "resume-test",
    description: "resume smoke test",
    parseInput: (raw) => raw.trim(),
    createRun: async (input) => {
      createCalls += 1;
      return {
        title: `resume ${input}`,
        summary: "created",
        state: { phase: "wait" },
      };
    },
    step: async (state) => {
      stepCalls += 1;
      if (state.phase === "wait") {
        return {
          kind: "wait",
          state,
          reason: "waiting for next invocation",
        };
      }
      return {
        kind: "complete",
        state,
        result: { ok: true },
        summary: "done",
      };
    },
  };

  const ctx = {
    cwd: repoRoot,
    signal: undefined,
    ui: {
      notify: () => {},
      confirm: async () => true,
    },
  } as const;

  const createWorkflowContext = async (_pi: unknown, root: string, runId: string) => makeContext(root, runId);
  const projectRoot = async () => repoRoot;

  try {
    await runStepWorkflow({} as never, spec, "do thing", ctx as never, projectRoot as never, createWorkflowContext as never);

    let db = openWorkflowDb(repoRoot);
    let waitingRuns = 0;
    try {
      const rows = db.prepare(`SELECT id, status FROM workflow_runs WHERE workflow = 'resume-test'`).all() as Array<{ id: string; status: string }>;
      waitingRuns = rows.length;
      assert.equal(rows[0]?.status, "waiting");
    } finally {
      closeWorkflowDb(db);
    }

    assert.equal(waitingRuns, 1);
    assert.equal(createCalls, 1);
    assert.equal(stepCalls, 1);

    spec.step = async (state) => {
      stepCalls += 1;
      return {
        kind: "complete",
        state: { phase: "done" },
        result: { ok: true },
        summary: "done",
      };
    };

    await runStepWorkflow({} as never, spec, "do thing", ctx as never, projectRoot as never, createWorkflowContext as never);

    db = openWorkflowDb(repoRoot);
    try {
      const row = db.prepare(`SELECT id FROM workflow_runs WHERE workflow = 'resume-test' LIMIT 1`).get() as { id: string } | undefined;
      assert.ok(row);
      const run = getWorkflowRun(db, repoRoot, row.id);
      assert.ok(run);
      assert.equal(run.status, "completed");
      assert.deepEqual(run.result, { ok: true });
      assert.equal(run.stepCount, 2);
    } finally {
      closeWorkflowDb(db);
    }

    assert.equal(createCalls, 1);
    assert.equal(stepCalls, 2);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
