import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunRecord, WorkflowSpec, WorkflowStepResult, CodeWorkflowContext } from "./api.js";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import {
  acquireWorkflowLease,
  appendWorkflowRunEvent,
  closeWorkflowDb,
  findResumableWorkflowRun,
  getWorkflowRun,
  heartbeatWorkflowLease,
  listWorkflowRuns,
  makeLeaseOwnerId,
  openWorkflowDb,
  releaseWorkflowLease,
  tryAppendWorkflowRunEvent,
  upsertWorkflowRun,
} from "./db.js";

export const WORKFLOW_DIR = ".pi/workflows";
export const RUNS_DIR = join(WORKFLOW_DIR, "runs");
export const SPECS_DIR = join(WORKFLOW_DIR, "specs");
export const STOP_FILE = join(WORKFLOW_DIR, ".grind-stop");
export const MAX_LISTED_RUNS = 20;

export type WorkflowRunManifest = WorkflowRunRecord & {
  candidates?: Array<{
    id: string; branch?: string; worktree?: string; score?: number; commit?: string;
    merged?: boolean; mergeError?: string; mergeCommit?: string;
  }>;
};

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function ensureWorkflowDirs(cwd: string): void {
  ensureDir(join(cwd, WORKFLOW_DIR));
  ensureDir(join(cwd, RUNS_DIR));
  ensureDir(join(cwd, SPECS_DIR));
}

export function runPath(cwd: string, runId: string): string {
  return join(cwd, RUNS_DIR, runId);
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function makeRunId(name: string, argsText: string): string {
  return `${nowStamp()}-${slugify(name)}-${slugify(argsText || "run", 24)}`;
}

export function slugify(input: string, max = 48): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return base || "run";
}

export function parseLooseObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Not an object literal");
  }
  if (trimmed.length > 32 * 1024) throw new Error("Input too large for loose object parsing (max 32 KB)");
  let normalized = trimmed;
  normalized = normalized.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
  normalized = normalized.replace(/\s*:\s*'((?:[^'\\]|\\.)*?)'/g, (_, inner: string) => {
    const unescaped = inner.replace(/\\'/g, "'");
    const escaped = unescaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `: "${escaped}"`;
  });
  return JSON.parse(normalized);
}

export function parseArgsText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try { return parseLooseObject(trimmed); } catch { /* fall through */ }
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return trimmed;
}

const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;

function retryDelay(attempt: number): number {
  const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
  const jitter = delay * 0.3 * Math.random();
  return delay + jitter;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Aborted")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }, { once: true });
  });
}

export interface WorkflowRunOptions {
  storeRoot?: string;
}

export type CreateWorkflowContextFn = (
  pi: ExtensionAPI,
  repoRoot: string,
  runId: string,
  ctx: ExtensionCommandContext,
) => Promise<CodeWorkflowContext>;

export type WorkflowProjectRootFn = (pi: ExtensionAPI, cwd: string) => Promise<string>;

export async function runStepWorkflow<TInput, TState, TResult>(
  pi: ExtensionAPI,
  spec: WorkflowSpec<TInput, TState, TResult>,
  argsText: string,
  ctx: ExtensionCommandContext,
  projectRoot: WorkflowProjectRootFn,
  createWorkflowContext: CreateWorkflowContextFn,
): Promise<void> {
  const storeRoot = await projectRoot(pi, ctx.cwd);
  ensureWorkflowDirs(storeRoot);

  const db = openWorkflowDb(storeRoot);
  const leaseOwnerId = makeLeaseOwnerId();
  const normalizedArgs = argsText.trim();

  let runId: string;
  let state: TState;

  const resumable = findResumableWorkflowRun(db, storeRoot, spec.name, normalizedArgs);
  if (resumable) {
    runId = resumable.id;
    state = resumable.state as TState;
    tryAppendWorkflowRunEvent(db, runId, "run.resumed", {
      message: `Resumed ${spec.name}`,
      data: { workflow: spec.name, argsText: normalizedArgs },
    });
    ctx.ui.notify(`Resuming ${spec.name} run ${runId}`, "info");
  } else {
    runId = makeRunId(spec.name, argsText || spec.name);
    const initCtx = await createWorkflowContext(pi, storeRoot, runId, ctx);
    const input = spec.parseInput ? await spec.parseInput(argsText) : (parseArgsText(argsText) as TInput);
    const init = await spec.createRun(input, initCtx);
    const manifest: WorkflowRunManifest = {
      id: runId,
      workflow: spec.name,
      description: spec.description,
      title: init.title,
      status: "running",
      startedAt: new Date().toISOString(),
      cwd: storeRoot,
      argsText,
      argsValue: input,
      summary: init.summary,
      tags: init.tags,
      stepCount: 0,
      state: init.state,
      outputs: [],
    };
    try {
      upsertWorkflowRun(db, manifest);
      tryAppendWorkflowRunEvent(db, runId, "run.created", {
        message: `Created ${spec.name}`,
        data: { workflow: spec.name, argsText },
      });
      state = init.state;
    } catch (error) {
      const recovered = findResumableWorkflowRun(db, storeRoot, spec.name, normalizedArgs);
      if (!recovered) throw error;
      runId = recovered.id;
      state = recovered.state as TState;
      tryAppendWorkflowRunEvent(db, runId, "run.resumed", {
        message: `Resumed ${spec.name} after duplicate active run detection`,
        data: { workflow: spec.name, argsText: normalizedArgs },
      });
      ctx.ui.notify(`Resuming ${spec.name} run ${runId}`, "info");
    }
  }

  acquireWorkflowLease(db, runId, leaseOwnerId, process.pid);
  tryAppendWorkflowRunEvent(db, runId, "lease.acquired", {
    message: "Acquired workflow lease",
    data: { ownerId: leaseOwnerId, ownerPid: process.pid },
  });
  const workflowCtx = await createWorkflowContext(pi, storeRoot, runId, ctx);
  let retryCount = 0;

  try {
    while (true) {
      await workflowCtx.control.assertNotStopped();
      heartbeatWorkflowLease(db, runId, leaseOwnerId);

      const current = getWorkflowRun(db, storeRoot, runId) as WorkflowRunManifest | null;
      if (!current) throw new Error(`Run '${runId}' disappeared`);
      current.status = "running";
      current.state = state;
      current.endedAt = undefined;
      upsertWorkflowRun(db, current);

      const stepResult = await spec.step(state, workflowCtx) as WorkflowStepResult<TState, TResult>;
      const next = (getWorkflowRun(db, storeRoot, runId) as WorkflowRunManifest | null) ?? current;
      next.stepCount = (next.stepCount ?? 0) + 1;
      next.state = stepResult.state;
      if ("summary" in stepResult && stepResult.summary) next.summary = stepResult.summary;

      if (stepResult.kind === "continue") {
        if (stepResult.checkpoint) next.lastCheckpoint = stepResult.checkpoint;
        upsertWorkflowRun(db, next);
        tryAppendWorkflowRunEvent(db, runId, "step.continue", {
          message: next.summary ?? "Workflow continued",
          data: { checkpoint: stepResult.checkpoint, stepCount: next.stepCount },
        });
        state = stepResult.state;
        retryCount = 0;
        continue;
      }

      if (stepResult.kind === "wait") {
        const wakeAt = stepResult.wakeAt ? new Date(stepResult.wakeAt).getTime() : 0;
        const now = Date.now();
        if (wakeAt > now) {
          next.status = "waiting";
          next.summary = stepResult.reason ?? next.summary;
          next.endedAt = undefined;
          upsertWorkflowRun(db, next);
          tryAppendWorkflowRunEvent(db, runId, "step.waiting", {
            message: stepResult.reason ?? "Workflow waiting until wakeAt",
            data: { wakeAt: stepResult.wakeAt, stepCount: next.stepCount },
          });
          ctx.ui.notify(`Workflow ${spec.name} waiting until ${stepResult.wakeAt}`, "info");

          let remaining = wakeAt - now;
          while (remaining > 0) {
            await sleep(Math.min(10_000, remaining), ctx.signal);
            heartbeatWorkflowLease(db, runId, leaseOwnerId);
            await workflowCtx.control.assertNotStopped();
            remaining = wakeAt - Date.now();
          }
          state = stepResult.state;
          continue;
        }

        next.status = "waiting";
        next.endedAt = new Date().toISOString();
        next.summary = stepResult.reason ?? next.summary;
        upsertWorkflowRun(db, next);
        tryAppendWorkflowRunEvent(db, runId, "step.waiting", {
          message: stepResult.reason ?? "Workflow waiting",
          data: { wakeAt: null, stepCount: next.stepCount },
        });
        ctx.ui.notify(`Workflow ${spec.name} waiting`, "info");
        return;
      }

      if (stepResult.kind === "failed") {
        if (stepResult.retryable) {
          retryCount += 1;
          const delayMs = retryDelay(retryCount);
          next.summary = `Retrying (attempt ${retryCount}): ${stepResult.error}`;
          next.endedAt = undefined;
          upsertWorkflowRun(db, next);
          tryAppendWorkflowRunEvent(db, runId, "step.retryable-failed", {
            message: stepResult.error,
            data: { retryCount, delayMs, stepCount: next.stepCount },
          });
          ctx.ui.notify(`${spec.name}: retryable failure, retrying in ${Math.round(delayMs / 1000)}s (attempt ${retryCount})`, "warning");
          await sleep(delayMs, ctx.signal);
          state = stepResult.state;
          continue;
        }

        next.status = "failed";
        next.endedAt = new Date().toISOString();
        next.error = stepResult.error;
        upsertWorkflowRun(db, next);
        tryAppendWorkflowRunEvent(db, runId, "run.failed", {
          message: stepResult.error,
          data: { stepCount: next.stepCount },
        });
        ctx.ui.notify(`Workflow ${spec.name} finished: failed`, "warning");
        return;
      }

      if (next.status !== "stopped" && next.status !== "failed") next.status = "completed";
      next.endedAt = new Date().toISOString();
      next.result = stepResult.result;
      upsertWorkflowRun(db, next);
      tryAppendWorkflowRunEvent(db, runId, "run.completed", {
        message: next.summary ?? `${spec.name} completed`,
        data: { stepCount: next.stepCount },
      });
      ctx.ui.notify(`Workflow ${spec.name} finished: ${next.status}`, next.status === "completed" ? "info" : "warning");
      return;
    }
  } catch (error) {
    const current = getWorkflowRun(db, storeRoot, runId) as WorkflowRunManifest | null;
    if (current) {
      current.status = existsSync(join(storeRoot, STOP_FILE)) ? "stopped" : "failed";
      current.endedAt = new Date().toISOString();
      current.error = error instanceof Error ? error.message : String(error);
      upsertWorkflowRun(db, current);
      tryAppendWorkflowRunEvent(db, runId, current.status === "stopped" ? "run.stopped" : "run.failed", {
        message: current.error,
        data: { stepCount: current.stepCount ?? 0 },
      });
    }
    throw error;
  } finally {
    tryAppendWorkflowRunEvent(db, runId, "lease.released", {
      message: "Released workflow lease",
      data: { ownerId: leaseOwnerId },
    });
    releaseWorkflowLease(db, runId, leaseOwnerId);
    closeWorkflowDb(db);
  }
}

export function completeWorkflowArgument(prefix: string, values: string[]): Array<{ value: string; label: string }> | null {
  const trimmed = prefix.trimStart().toLowerCase();
  if (!trimmed) return values.map((value) => ({ value, label: value }));
  const filtered = values.filter((value) => value.startsWith(trimmed));
  return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
}

export function formatRunList(runs: WorkflowRunManifest[]): string {
  if (runs.length === 0) return "No workflow runs recorded yet.";
  return runs.slice(0, MAX_LISTED_RUNS).map((run) => `${run.id} \u00b7 ${run.workflow} \u00b7 ${run.status} \u00b7 ${run.startedAt}`).join("\n");
}

export function summarizeText(text: string, max = 400): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}\u2026` : compact;
}
