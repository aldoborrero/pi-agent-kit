import { appendFileSync, mkdirSync, existsSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "../../pi-subagent/src/agents.js";
import type {
  BacklogItemRecord,
  BacklogStatus as ApiBacklogStatus,
  WorkflowCandidateRecord,
  CodeWorkflowContext,
  WorkflowAgentResult,
  WorkflowRunRecord,
} from "./api.js";
import {
  ensureDir,
  ensureWorkflowDirs,
  runPath,
  nowStamp,
  slugify,
  runStepWorkflow,
  completeWorkflowArgument,
  MAX_LISTED_RUNS,
  WORKFLOW_DIR,
  STOP_FILE,
  type WorkflowRunManifest,
  summarizeText,
} from "./engine.js";
import {
  claimBacklogRecords,
  closeWorkflowDb,
  countBacklogRecords,
  createBacklogRecord,
  getWorkflowRun,
  listBacklogRecords,
  listWorkflowRunEvents,
  listWorkflowCandidates,
  listWorkflowRuns,
  moveBacklogRecord,
  noteBacklogRecord,
  openWorkflowDb,
  replaceWorkflowCandidates,
  tryAppendWorkflowRunEvent,
  upsertWorkflowCandidate,
  upsertWorkflowRun,
  workflowRunExists,
} from "./db.js";

// ---------------------------------------------------------------------------
// Git helpers (moved from engine.ts)
// ---------------------------------------------------------------------------

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 60_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Failed to find git root");
  return result.stdout.trim();
}

export async function git(pi: ExtensionAPI, cwd: string, ...args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout: 60_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed with exit code ${result.code}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Grinder-specific constants
// ---------------------------------------------------------------------------

const GRIND_LOG_DIR = join(WORKFLOW_DIR, "logs");
import {
  findWorkflow,
  loadWorkflowDiscovery,
  listModuleSpecFiles,
  workflowNamesForCompletion,
} from "./loader.js";
import { createDynamicWorkflowTool } from "./dynamic.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BacklogStatus = ApiBacklogStatus;
type BacklogItem = BacklogItemRecord;

type AgentRunResult = {
  agent: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  finalText: string;
};

type GrindRoundRecord = {
  round: number;
  summary?: string;
};

type GrindStateSnapshot = {
  phase?: string;
  rounds?: GrindRoundRecord[];
  dryStreak?: number;
  specialistCursor?: number;
};

export function listBacklogItems(cwd: string, status: BacklogStatus): BacklogItem[] {
  const db = openWorkflowDb(cwd);
  try { return listBacklogRecords(db, cwd, status); }
  finally { closeWorkflowDb(db); }
}

export function createBacklogItem(
  cwd: string, title: string, body: string, prefix = "task",
  metadata?: Partial<Omit<BacklogItemRecord["metadata"], "id" | "title" | "status" | "createdAt">>,
): BacklogItem {
  const id = `${prefix}-${nowStamp()}-${slugify(title, 32)}`;
  const item: BacklogItem = {
    id, title, status: "open", path: "", body: body.trim(),
    metadata: {
      id, title, kind: (["bug", "perf", "coverage", "refactor", "research", "meta"].includes(prefix) ? prefix : "task") as BacklogItemRecord["metadata"]["kind"],
      priority: metadata?.priority ?? "medium" as BacklogItemRecord["metadata"]["priority"],
      source: metadata?.source ?? "workflow", status: "open", createdAt: new Date().toISOString(),
      owner: metadata?.owner, round: metadata?.round,
    },
  };
  const db = openWorkflowDb(cwd);
  try { return createBacklogRecord(db, cwd, item); }
  finally { closeWorkflowDb(db); }
}

function moveBacklogItem(cwd: string, item: BacklogItem, nextStatus: BacklogStatus, extra?: Partial<Pick<BacklogItemRecord["metadata"], "owner" | "round" | "source" | "priority" | "kind">>): BacklogItem {
  const db = openWorkflowDb(cwd);
  try { return moveBacklogRecord(db, item, nextStatus, extra); }
  finally { closeWorkflowDb(db); }
}

export function salvageOrphanBacklog(cwd: string): number {
  const db = openWorkflowDb(cwd);
  try {
    const orphans = listBacklogRecords(db, cwd, "in-progress");
    for (const item of orphans) {
      const restored = moveBacklogRecord(db, item, "open", { owner: undefined });
      noteBacklogRecord(db, restored.id, "Restored from in-progress at workflow start (orphan recovery).");
    }
    return orphans.length;
  } finally {
    closeWorkflowDb(db);
  }
}

// ---------------------------------------------------------------------------
// Agent execution (uses `pi --mode json --no-session`)
// ---------------------------------------------------------------------------

function writeTempPromptFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-"));
  const filePath = join(dir, `${slugify(agentName)}.md`);
  writeFileSync(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

async function runAgentTask(cwd: string, agentName: string, promptText: string, signal?: AbortSignal, agentScope: "user" | "project" | "both" = "both"): Promise<AgentRunResult> {
  const discovery = discoverAgents(cwd, agentScope);
  const agent = discovery.agents.find((item) => item.name === agentName);
  if (!agent) {
    const available = discovery.agents.map((item) => item.name).sort().join(", ") || "none";
    throw new Error(`Unknown agent '${agentName}'. Available: ${available}`);
  }
  return await spawnAgentProcess(cwd, agent, promptText, signal);
}

const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — circuit breaker for hung agents
const OUTPUT_CAP_BYTES = 64 * 1024; // keep only the tail of stdout/stderr to avoid unbounded memory

function cappedAppend(existing: string, chunk: string, cap: number): string {
  const combined = existing + chunk;
  if (combined.length <= cap) return combined;
  return combined.slice(combined.length - cap);
}

async function spawnAgentProcess(cwd: string, agent: AgentConfig, promptText: string, signal?: AbortSignal): Promise<AgentRunResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

  let tempDir: string | null = null;
  let tempPromptPath: string | null = null;
  if (agent.systemPrompt?.trim()) {
    const tmp = writeTempPromptFile(agent.name, agent.systemPrompt);
    tempDir = tmp.dir; tempPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tempPromptPath);
  }
  args.push(promptText);

  let stdout = ""; let stderr = ""; let finalText = ""; let buffer = "";
  let timedOut = false;

  const result = await new Promise<AgentRunResult>((resolve) => {
    const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const parts = Array.isArray(event.message.content) ? event.message.content : [];
        const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("\n").trim();
        if (text) finalText = text;
      }
    };

    proc.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = cappedAppend(stdout, text, OUTPUT_CAP_BYTES);
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr?.on("data", (chunk) => { stderr = cappedAppend(stderr, chunk.toString(), OUTPUT_CAP_BYTES); });

    const KILL_TIMEOUT_MS = 3000;
    const kill = () => {
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try {
          proc.kill(0); // throws if process already exited
          proc.kill("SIGKILL");
        } catch { /* already exited */ }
      }, KILL_TIMEOUT_MS);
    };
    if (signal) { if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true }); }

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, AGENT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) { try { signal.removeEventListener("abort", kill); } catch {} }
    };

    proc.on("close", (code) => {
      cleanup();
      if (buffer.trim()) processLine(buffer);
      if (timedOut) stderr = cappedAppend(stderr, `\nAgent timed out after ${AGENT_TIMEOUT_MS / 1000}s`, OUTPUT_CAP_BYTES);
      resolve({ agent: agent.name, cwd, exitCode: timedOut ? 124 : (code ?? 0), stdout, stderr, finalText });
    });
    proc.on("error", (error) => {
      cleanup();
      resolve({ agent: agent.name, cwd, exitCode: 1, stdout, stderr: cappedAppend(stderr, `\n${error.message}`, OUTPUT_CAP_BYTES), finalText });
    });
  });

  if (tempPromptPath) { try { rmSync(tempPromptPath, { force: true }); } catch {} }
  if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  return result;
}

// ---------------------------------------------------------------------------
// Workflow context creation
// ---------------------------------------------------------------------------

export async function createWorkflowContext(pi: ExtensionAPI, repoRoot: string, runId: string, ctx: ExtensionCommandContext): Promise<CodeWorkflowContext> {
  const logPath = join(repoRoot, GRIND_LOG_DIR, `${runId}.log`);
  const artifactsBase = join(runPath(repoRoot, runId), "artifacts");
  ensureDir(artifactsBase);

  async function recordRunEvent(type: string, message?: string, data?: unknown): Promise<void> {
    const db = openWorkflowDb(repoRoot);
    try {
      tryAppendWorkflowRunEvent(db, runId, type, { message, data });
    } finally {
      closeWorkflowDb(db);
    }
  }

  const logCtx = {
    info: async (message: string) => appendFileSync(logPath, `[${new Date().toISOString()}] INFO ${message}\n`, "utf8"),
    warn: async (message: string) => appendFileSync(logPath, `[${new Date().toISOString()}] WARN ${message}\n`, "utf8"),
    error: async (message: string) => appendFileSync(logPath, `[${new Date().toISOString()}] ERROR ${message}\n`, "utf8"),
    event: async (type: string, data?: unknown) => {
      appendFileSync(logPath, `[${new Date().toISOString()}] EVENT ${type}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`, "utf8");
      await recordRunEvent(type, undefined, data);
    },
  };

  const storeCtx = {
    getRun: async <TState = unknown, TResult = unknown>() => {
      const manifest = getStoredRun(repoRoot, runId);
      if (!manifest) throw new Error(`Run '${runId}' not found`);
      return manifest as WorkflowRunRecord<TState, TResult>;
    },
    saveRun: async <TState = unknown, TResult = unknown>(run: WorkflowRunRecord<TState, TResult>) => {
      saveStoredRun(repoRoot, run as WorkflowRunManifest);
      syncRunCandidates(repoRoot, run as WorkflowRunManifest);
    },
    updateRun: async (patch: Partial<WorkflowRunRecord>) => {
      const current = getStoredRun(repoRoot, runId);
      if (!current) throw new Error(`Run '${runId}' not found`);
      const next = { ...current, ...patch } as WorkflowRunManifest;
      saveStoredRun(repoRoot, next);
      syncRunCandidates(repoRoot, next);
    },
  };

  const backlogCtx = {
    list: async (status: ApiBacklogStatus) => listBacklogItems(repoRoot, status),
    count: async (status: ApiBacklogStatus) => {
      const db = openWorkflowDb(repoRoot);
      try { return countBacklogRecords(db, repoRoot, status); }
      finally { closeWorkflowDb(db); }
    },
    create: async (title: string, body: string, prefix = "task", metadata?: Partial<Omit<BacklogItemRecord["metadata"], "id" | "title" | "status" | "createdAt">>) => {
      const item = createBacklogItem(repoRoot, title, body, prefix, metadata);
      await recordRunEvent("backlog.created", `Created backlog item ${item.id}`, {
        backlogItemId: item.id,
        title: item.title,
        status: item.status,
      });
      return item;
    },
    move: async (item: BacklogItemRecord, status: ApiBacklogStatus, extra?: Partial<Pick<BacklogItemRecord["metadata"], "owner" | "round" | "source" | "priority" | "kind">>) => {
      const moved = moveBacklogItem(repoRoot, item, status, extra);
      await recordRunEvent("backlog.moved", `Moved backlog item ${item.id} to ${status}`, {
        backlogItemId: item.id,
        previousStatus: item.status,
        status,
        owner: moved.metadata.owner,
        round: moved.metadata.round,
      });
      return moved;
    },
    claim: async (ids: string[], owner: string, round: number) => {
      const db = openWorkflowDb(repoRoot);
      try {
        const claimed = claimBacklogRecords(db, repoRoot, ids, owner, round);
        for (const item of claimed) {
          tryAppendWorkflowRunEvent(db, runId, "backlog.claimed", {
            message: `Claimed backlog item ${item.id}`,
            data: { backlogItemId: item.id, owner, round },
          });
        }
        return claimed;
      } finally { closeWorkflowDb(db); }
    },
    note: async (item: BacklogItemRecord, note: string) => {
      const db = openWorkflowDb(repoRoot);
      try { noteBacklogRecord(db, item.id, note); }
      finally { closeWorkflowDb(db); }
    },
    pick: async (limit: number) => {
      const openItems = listBacklogItems(repoRoot, "open").slice(0, Math.max(0, limit));
      const db = openWorkflowDb(repoRoot);
      try {
        const claimed = claimBacklogRecords(db, repoRoot, openItems.map((item) => item.id), runId, 0);
        for (const item of claimed) {
          tryAppendWorkflowRunEvent(db, runId, "backlog.picked", {
            message: `Picked backlog item ${item.id}`,
            data: { backlogItemId: item.id, owner: runId, round: 0 },
          });
        }
        return claimed;
      } finally { closeWorkflowDb(db); }
    },
  };

  const candidatesCtx = {
    upsert: async (candidate: WorkflowCandidateRecord) => {
      const db = openWorkflowDb(repoRoot);
      try {
        upsertWorkflowCandidate(db, candidate.runId, {
          id: candidate.id,
          branch: candidate.branch,
          worktree: candidate.worktree,
          score: candidate.score,
          commit: candidate.commit,
          merged: candidate.merged,
          mergeError: candidate.mergeError,
          mergeCommit: candidate.mergeCommit,
          round: candidate.round,
          summary: candidate.summary,
          exitCode: candidate.exitCode,
          verifyExitCode: candidate.verifyExitCode,
          reviewVerdict: candidate.reviewVerdict,
        });
        tryAppendWorkflowRunEvent(db, candidate.runId, "candidate.upserted", {
          message: `Updated candidate ${candidate.id}`,
          data: {
            candidateId: candidate.id,
            branch: candidate.branch,
            merged: candidate.merged,
            round: candidate.round,
            reviewVerdict: candidate.reviewVerdict,
          },
        });
      } finally {
        closeWorkflowDb(db);
      }
    },
    list: async (requestedRunId?: string) => {
      const db = openWorkflowDb(repoRoot);
      try {
        return listWorkflowCandidates(db, requestedRunId ?? runId).map((candidate) => ({
          id: candidate.id,
          runId: candidate.run_id,
          branch: candidate.branch ?? undefined,
          worktree: candidate.worktree ?? undefined,
          score: candidate.score ?? undefined,
          commit: candidate.commit_sha ?? undefined,
          merged: Boolean(candidate.merged),
          mergeError: candidate.merge_error ?? undefined,
          mergeCommit: candidate.merge_commit ?? undefined,
          round: candidate.round ?? undefined,
          summary: candidate.summary ?? undefined,
          exitCode: candidate.exit_code ?? undefined,
          verifyExitCode: candidate.verify_exit_code ?? undefined,
          reviewVerdict: candidate.review_verdict as WorkflowCandidateRecord["reviewVerdict"] | undefined,
        }));
      } finally {
        closeWorkflowDb(db);
      }
    },
  };

  const artifactsCtx = {
    write: async (kind: string, name: string, content: string) => {
      const dir = join(artifactsBase, kind);
      ensureDir(dir);
      const filePath = join(dir, name);
      writeFileSync(filePath, content, "utf8");
      const current = getStoredRun(repoRoot, runId);
      if (current) {
        current.outputs = [...(current.outputs ?? []).filter((e) => e !== filePath), filePath];
        saveStoredRun(repoRoot, current);
      }
      return filePath;
    },
  };

  const worktreesCtx = {
    create: async (id: string, branch: string, baseRef: string) => {
      const worktreeRoot = join(dirname(repoRoot), `${basename(repoRoot)}-workflows`, runId);
      ensureDir(worktreeRoot);
      const path = join(worktreeRoot, id);
      await git(pi, repoRoot, "worktree", "add", "-b", branch, path, baseRef);
      return { id, path, branch, baseRef };
    },
    remove: async (path: string) => {
      const worktreeBase = join(dirname(repoRoot), `${basename(repoRoot)}-workflows`);
      if (!path.startsWith(worktreeBase)) throw new Error(`Worktree path is outside expected directory (${worktreeBase}): ${path}`);
      try {
        const dirtyResult = await pi.exec("git", ["-C", path, "status", "--porcelain"], { cwd: repoRoot, timeout: 60_000 });
        if (dirtyResult.stdout.trim().length > 0) throw new Error(`Worktree ${path} has uncommitted changes; refusing force removal. Use git worktree remove manually after reviewing changes.`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Worktree")) throw e;
      }
      await git(pi, repoRoot, "worktree", "remove", "--force", path);
    },
  };

  const agentsCtx = {
    run: async (task) => {
      const startedAt = Date.now();
      const result = await runAgentTask(task.cwd ?? repoRoot, task.agent, task.task, ctx.signal, task.agentScope ?? "both");
      return { ok: result.exitCode === 0, output: result.finalText || result.stderr || result.stdout || "", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: Date.now() - startedAt } as WorkflowAgentResult;
    },
  };

  const reviewCtx = {
    reviewCandidate: async (task: { worktree: string; itemTitle: string; itemBody: string; candidateId: string; candidateSummary: string; agent?: string; agentScope?: "user" | "project" | "both" }) => {
      const prompt = ["You are the REVIEWER for a code grinder candidate.", `Backlog title: ${task.itemTitle}`, "", task.itemBody.trim(), "", `Candidate ID: ${task.candidateId}`, `Candidate summary: ${task.candidateSummary}`, "", "Review the changes in the current worktree.", "Return a concise review ending with exactly one line: Verdict: PASS or Verdict: BLOCK"].join("\n");
      const res = await runAgentTask(task.worktree, task.agent ?? "review", prompt, ctx.signal, task.agentScope ?? "both");
      const raw = res.finalText || res.stdout || res.stderr || "";
      return { agent: task.agent ?? "review", verdict: parseReviewVerdict(raw), summary: summarizeText(raw, 700), raw };
    },
    judgeCandidates: async (task: { repoRoot: string; task: string; candidates: Array<{ id: string; score?: number; exitCode: number; verifyExitCode?: number; reviewVerdict?: "pass" | "block" | "unknown"; summary: string }>; agent?: string; agentScope?: "user" | "project" | "both" }) => {
      if (task.candidates.length === 0) return [];
      const prompt = ["You are the JUDGE for a code grinder merge queue.", `Primary task/theme: ${task.task}`, "Order the best candidates to merge first.", "Return ONLY candidate IDs, one per line, best first, no prose.", "Prefer candidates that pass verify, have PASS reviews, and seem lower risk.", "", "Candidates:", ...task.candidates.map((c) => [`- ${c.id}`, `  score=${c.score ?? 0}`, `  exit=${c.exitCode}`, `  verify=${c.verifyExitCode ?? "n/a"}`, `  review=${c.reviewVerdict ?? "unknown"}`, `  summary=${c.summary}`].join("\n"))].join("\n");
      try { const res = await runAgentTask(task.repoRoot, task.agent ?? "plan", prompt, ctx.signal, task.agentScope ?? "both"); const ids = parseSelectedIds(res.finalText || res.stdout, task.candidates.map((c) => c.id), task.candidates.length); return ids.length > 0 ? ids : null; } catch { return null; }
    },
  };

  const mergeCtx = {
    commitIfNeeded: async (cwd: string, message: string) => {
      const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 60_000 });
      if (statusResult.stdout.trim().length === 0) return undefined;
      const addResult = await pi.exec("git", ["add", "-A"], { cwd, timeout: 60_000 });
      if (addResult.code !== 0) return undefined;
      const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd, timeout: 60_000 });
      if (commitResult.code !== 0) return undefined;
      const shaResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 60_000 });
      return shaResult.code === 0 ? shaResult.stdout.trim() : undefined;
    },
    mergeCandidate: async (task: { repoRoot: string; commit?: string; verify?: string }) => {
      if (!task.commit) return { merged: false, mergeError: "candidate has no commit" };
      await recordRunEvent("merge.attempted", "Attempting candidate merge", {
        commit: task.commit,
        verify: task.verify ?? null,
      });
      if (task.verify) {
        const verify = task.verify.trim();
        const shellMeta = /[|;&`$><(){}!\\"'\n\r]/;
        if (shellMeta.test(verify)) {
          await recordRunEvent("merge.blocked", "Rejected unsafe verify command", {
            commit: task.commit,
            verify,
          });
          return { merged: false, mergeError: `verify command contains unsafe shell metacharacters: ${JSON.stringify(verify)}. Only simple commands are supported (e.g. "bun test", "npm run lint").` };
        }
      }
      const dirtyResult = await pi.exec("git", ["status", "--porcelain"], { cwd: task.repoRoot, timeout: 60_000 });
      if (dirtyResult.stdout.trim().length > 0) {
        await recordRunEvent("merge.blocked", "Base repo is dirty; refusing auto-merge", {
          commit: task.commit,
        });
        return { merged: false, mergeError: "base repo is dirty; refusing auto-merge" };
      }
      const pickResult = await pi.exec("git", ["cherry-pick", task.commit], { cwd: task.repoRoot, timeout: 10 * 60_000, signal: ctx.signal });
      if (pickResult.code !== 0) {
        try { await pi.exec("git", ["cherry-pick", "--abort"], { cwd: task.repoRoot, timeout: 60_000 }); } catch {}
        await recordRunEvent("merge.failed", pickResult.stderr.trim() || `cherry-pick failed (${pickResult.code})`, {
          commit: task.commit,
          exitCode: pickResult.code,
        });
        return { merged: false, mergeError: pickResult.stderr.trim() || `cherry-pick failed (${pickResult.code})` };
      }
      if (task.verify) {
        const verify = task.verify.trim();
        const [cmd, ...verifyArgs] = verify.split(/\s+/);
        const verifyResult = await pi.exec(cmd, verifyArgs, { cwd: task.repoRoot, timeout: 30 * 60_000, signal: ctx.signal });
        if (verifyResult.code !== 0) {
          try { await pi.exec("git", ["revert", "--no-edit", "HEAD"], { cwd: task.repoRoot, timeout: 60_000 }); } catch {}
          await recordRunEvent("merge.failed", `post-merge verify failed (${verifyResult.code})`, {
            commit: task.commit,
            verify,
            exitCode: verifyResult.code,
          });
          return { merged: false, mergeError: `post-merge verify failed (${verifyResult.code})` };
        }
      }
      const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: task.repoRoot, timeout: 60_000 });
      await recordRunEvent("merge.completed", "Merged candidate into base repo", {
        commit: task.commit,
        mergeCommit: headResult.stdout.trim(),
      });
      return { merged: true, mergeCommit: headResult.stdout.trim() };
    },
  };

  const stopFilePath = join(repoRoot, STOP_FILE);
  const controlCtx = {
    isStopRequested: async () => existsSync(stopFilePath),
    assertNotStopped: async () => { if (existsSync(stopFilePath)) throw new Error("Workflow stop requested"); },
    stop: async (reason?: string) => {
      await recordRunEvent("run.stop-requested", reason ? `Stop requested: ${reason}` : "Stop requested", { reason: reason ?? null });
      ensureDir(dirname(stopFilePath));
      writeFileSync(stopFilePath, `${reason ?? "stop"}\n`, "utf8");
    },
  };

  const uiCtx = {
    notify: (message: string, type?: string) => { if (ctx.hasUI) ctx.ui.notify(message, type as "info" | "warning" | "error"); },
    confirm: async (message: string, detail?: string) => ctx.hasUI ? ctx.ui.confirm(message, detail) : true,
  };

  return { runId, cwd: repoRoot, log: logCtx, store: storeCtx, backlog: backlogCtx, artifacts: artifactsCtx, candidates: candidatesCtx, worktrees: worktreesCtx, agents: agentsCtx, review: reviewCtx, merge: mergeCtx, control: controlCtx, ui: uiCtx, signal: ctx.signal, env: process.env };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function parseReviewVerdict(text: string): "pass" | "block" | "unknown" {
  const n = text.toLowerCase();
  if (n.includes("verdict: block") || n.includes("overall: block") || n.includes("blocker")) return "block";
  if (n.includes("verdict: pass") || n.includes("overall: pass")) return "pass";
  return "unknown";
}

function parseSelectedIds(output: string, ids: string[], limit: number): string[] {
  const matches = new Set<string>();
  for (const id of ids) {
    const regex = new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_-])`, "m");
    if (regex.test(output)) matches.add(id);
  }
  return ids.filter((id) => matches.has(id)).slice(0, limit);
}

function getStopFilePath(cwd: string): string { return join(cwd, STOP_FILE); }

function formatWorkflowRunEvents(events: Array<{ id: number; type: string; message: string | null; data: unknown; created_at: string }>): string {
  if (events.length === 0) return "No workflow events recorded yet.";
  return events.map((event) => {
    const lines = [`${event.id} · ${event.created_at} · ${event.type}`];
    if (event.message) lines.push(`  ${event.message}`);
    if (event.data !== undefined) lines.push(`  ${JSON.stringify(event.data)}`);
    return lines.join("\n");
  }).join("\n");
}

function recordStopRequest(repoRoot: string, source: "workflow" | "grind"): void {
  const activeRuns = listStoredRuns(repoRoot).filter((run) => run.status === "running" || run.status === "waiting");
  if (activeRuns.length === 0) return;
  const db = openWorkflowDb(repoRoot);
  try {
    for (const run of activeRuns) {
      tryAppendWorkflowRunEvent(db, run.id, "run.stop-requested", {
        message: `Stop requested via /${source} stop`,
        data: { source },
      });
    }
  } finally {
    closeWorkflowDb(db);
  }
}

function getStoredRun(repoRoot: string, runId: string): WorkflowRunManifest | null {
  const db = openWorkflowDb(repoRoot);
  try {
    return getWorkflowRun(db, repoRoot, runId) as WorkflowRunManifest | null;
  } finally {
    closeWorkflowDb(db);
  }
}

function listStoredRuns(repoRoot: string): WorkflowRunManifest[] {
  const db = openWorkflowDb(repoRoot);
  try {
    return listWorkflowRuns(db, repoRoot) as WorkflowRunManifest[];
  } finally {
    closeWorkflowDb(db);
  }
}

function saveStoredRun(repoRoot: string, run: WorkflowRunManifest): void {
  const db = openWorkflowDb(repoRoot);
  try {
    upsertWorkflowRun(db, run);
  } finally {
    closeWorkflowDb(db);
  }
}

function syncRunCandidates(repoRoot: string, run: WorkflowRunRecord): void {
  const candidateList = (run as WorkflowRunManifest).candidates;
  if (!candidateList) return;
  const db = openWorkflowDb(repoRoot);
  try { replaceWorkflowCandidates(db, run.id, candidateList); }
  finally { closeWorkflowDb(db); }
}

function hydrateGrindManifest(repoRoot: string, manifest: WorkflowRunManifest): WorkflowRunManifest {
  const db = openWorkflowDb(repoRoot);
  try {
    const candidates = listWorkflowCandidates(db, manifest.id).map((candidate) => ({
      id: candidate.id,
      branch: candidate.branch ?? undefined,
      worktree: candidate.worktree ?? undefined,
      score: candidate.score ?? undefined,
      commit: candidate.commit_sha ?? undefined,
      merged: Boolean(candidate.merged),
      mergeError: candidate.merge_error ?? undefined,
      mergeCommit: candidate.merge_commit ?? undefined,
    }));
    return { ...manifest, candidates };
  } finally {
    closeWorkflowDb(db);
  }
}

function getGrindStateSnapshot(manifest: WorkflowRunRecord): GrindStateSnapshot {
  const state = manifest.state;
  if (!state || typeof state !== "object") return {};
  return state as GrindStateSnapshot;
}

// ---------------------------------------------------------------------------
// Grind CLI commands (operate on manifests/worktrees, not the run loop itself)
// ---------------------------------------------------------------------------

export function formatGrindRunList(runs: WorkflowRunRecord[]): string {
  const filtered = (runs as (WorkflowRunRecord & { workflow?: string, candidates?: Array<{ merged?: boolean }> })[]).filter((run) => run.workflow === "grind");
  if (filtered.length === 0) return "No grind runs recorded yet.";
  return filtered.slice(0, MAX_LISTED_RUNS).map((run) => {
    const snapshot = getGrindStateSnapshot(run);
    return [
      `${run.id}`,
      `status=${run.status}`,
      `rounds=${(snapshot.rounds ?? []).length}`,
      `merged=${(run.candidates ?? []).filter((c) => (c as { merged?: boolean }).merged).length}`,
      run.startedAt,
    ].join(" \u00b7 ");
  }).join("\n");
}

export function renderGrindManifest(manifest: WorkflowRunManifest): string {
  const lines: string[] = [];
  const snapshot = getGrindStateSnapshot(manifest);
  lines.push(`Run: ${manifest.id}`);
  lines.push(`Status: ${manifest.status}`);
  lines.push(`Task: ${typeof manifest.argsValue === "object" && manifest.argsValue && "task" in manifest.argsValue ? String((manifest.argsValue as Record<string, unknown>).task) : manifest.argsText}`);
  lines.push(`Started: ${manifest.startedAt}`);
  lines.push(`Ended: ${manifest.endedAt ?? "(running)"}`);
  if (snapshot.rounds) {
    for (const round of snapshot.rounds) {
      lines.push("", `Round ${round.round}`, `  summary: ${round.summary ?? "(none)"}`);
    }
  }
  if (manifest.summary) lines.push("", `Summary`, manifest.summary);
  return lines.join("\n");
}

export function formatGrindStatus(repoRoot: string, latest: WorkflowRunManifest | undefined): string {
  const stopF = getStopFilePath(repoRoot);
  const stop = existsSync(stopF);
  const db = openWorkflowDb(repoRoot);
  const open = countBacklogRecords(db, repoRoot, "open");
  const done = countBacklogRecords(db, repoRoot, "done");
  const tried = countBacklogRecords(db, repoRoot, "tried");
  closeWorkflowDb(db);

  const lines = ["Grind status", `Stop marker: ${stop ? "present" : "absent"}`, "", "Backlog", `- open: ${open}`, `- done: ${done}`, `- tried: ${tried}`];
  if (latest) {
    const snapshot = getGrindStateSnapshot(latest);
    lines.push("", "Latest run", `- id: ${latest.id}`, `- status: ${latest.status}`, `- rounds: ${(snapshot.rounds ?? []).length}`, `- merged: ${(latest.candidates ?? []).filter((c) => c.merged).length}`);
    if (latest.summary) lines.push(`- ${latest.summary.replace(/\n/g, " ")}`);
  }
  return lines.join("\n");
}

export async function showGrindStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  ensureWorkflowDirs(repoRoot);
  const latestBase = listStoredRuns(repoRoot).filter((run) => run.workflow === "grind")[0];
  const latest = latestBase ? hydrateGrindManifest(repoRoot, latestBase) : undefined;
  ctx.ui.notify(formatGrindStatus(repoRoot, latest), "info");
}

export async function showGrindList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  ensureWorkflowDirs(repoRoot);
  const runs = listStoredRuns(repoRoot)
    .filter((run) => run.workflow === "grind")
    .map((run) => hydrateGrindManifest(repoRoot, run));
  ctx.ui.notify(formatGrindRunList(runs), "info");
}

export async function showGrindRun(pi: ExtensionAPI, runId: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  const manifestBase = getStoredRun(repoRoot, runId);
  const manifest = manifestBase ? hydrateGrindManifest(repoRoot, manifestBase) : null;
  if (!manifest || manifest.workflow !== "grind") throw new Error(`Grind run '${runId}' not found`);
  ctx.ui.notify(renderGrindManifest(manifest), "info");
}

export async function cleanGrindRun(pi: ExtensionAPI, runId: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  const manifestBase = getStoredRun(repoRoot, runId);
  const manifest = manifestBase ? hydrateGrindManifest(repoRoot, manifestBase) : null;
  if (!manifest || manifest.workflow !== "grind") throw new Error(`Grind run '${runId}' not found`);
  if (manifest.status === "running" || manifest.status === "waiting") throw new Error(`Cannot clean active grind run '${runId}'`);

  const ok = await ctx.ui.confirm("Clean grind run?", `Delete local artifacts for run ${runId} and remove known worktrees/branches? Run history will be preserved.`);
  if (!ok) return;

  const db = openWorkflowDb(repoRoot);
  try {
    tryAppendWorkflowRunEvent(db, runId, "run.cleaned", {
      message: `Cleaning grind run ${runId}`,
      data: { workflow: manifest.workflow, candidateCount: (manifest.candidates ?? []).length },
    });
  } finally {
    closeWorkflowDb(db);
  }

  for (const candidate of manifest.candidates ?? []) {
    if (candidate.worktree) {
      try { await pi.exec("git", ["worktree", "prune", "--dry-run"], { cwd: repoRoot, timeout: 60_000 }); } catch {}
      try { await pi.exec("git", ["worktree", "remove", "--force", candidate.worktree], { cwd: repoRoot, timeout: 60_000 }); } catch {}
    }
    if (candidate.branch) try { await pi.exec("git", ["branch", "-D", candidate.branch], { cwd: repoRoot, timeout: 60_000 }); } catch {}
  }
  rmSync(runPath(repoRoot, runId), { recursive: true, force: true });
  rmSync(join(repoRoot, GRIND_LOG_DIR, `${runId}.log`), { force: true });
  ctx.ui.notify(`Cleaned grind run ${runId}; run history preserved`, "info");
}

export async function checkoutGrindCandidate(pi: ExtensionAPI, runId: string, candidateId: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  const manifestBase = getStoredRun(repoRoot, runId);
  const manifest = manifestBase ? hydrateGrindManifest(repoRoot, manifestBase) : null;
  if (!manifest || manifest.workflow !== "grind") throw new Error(`Grind run '${runId}' not found`);
  const candidate = manifest.candidates?.find((c) => c.id === candidateId);
  if (!candidate) throw new Error(`Candidate '${candidateId}' not found in run '${runId}'`);

  const dirtyResult = await pi.exec("git", ["status", "--porcelain"], { cwd: repoRoot, timeout: 60_000 });
  if (dirtyResult.stdout.trim().length > 0) {
    const db = openWorkflowDb(repoRoot);
    try {
      tryAppendWorkflowRunEvent(db, runId, "candidate.checkout-blocked", {
        message: `Repo dirty; refused checkout of candidate ${candidateId}`,
        data: { candidateId, branch: candidate.branch, worktree: candidate.worktree },
      });
    } finally {
      closeWorkflowDb(db);
    }
    ctx.ui.notify(`Repo is dirty. Candidate branch: ${candidate.branch}\nWorktree: ${candidate.worktree}`, "warning");
    return;
  }

  const result = await pi.exec("git", ["checkout", candidate.branch!], { cwd: repoRoot, timeout: 60_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Failed to checkout ${candidate.branch}`);
  const db = openWorkflowDb(repoRoot);
  try {
    tryAppendWorkflowRunEvent(db, runId, "candidate.checked-out", {
      message: `Checked out candidate ${candidateId}`,
      data: { candidateId, branch: candidate.branch },
    });
  } finally {
    closeWorkflowDb(db);
  }
  ctx.ui.notify(`Checked out ${candidate.branch}`, "info");
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleWorkflowCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  ensureWorkflowDirs(repoRoot);
  const trimmed = args.trim();
  if (!trimmed || trimmed === "help") {
    ctx.ui.notify(["Workflow engine", "/workflow list", "/workflow run <name> <args>", "/workflow show <run-id>", "/workflow events <run-id>", "/workflow stop", "", "Specs live in .pi/workflows/specs/ (JSON for agent, JS/TS for step workflows)"].join("\n"), "info");
    return;
  }

  const [subcommand, ...rest] = trimmed.split(/\s+/);
  const remainder = rest.join(" ").trim();

  if (subcommand === "list") {
    const discovery = await loadWorkflowDiscovery(pi, repoRoot);
    const names = discovery.workflows.map((w) => `${w.spec.name} \u2014 ${w.spec.description}`);
    const runs = listStoredRuns(repoRoot);
    const diagnostics = discovery.diagnostics.length > 0 ? `\n\nModule diagnostics:\n${discovery.diagnostics.map((entry) => `- ${basename(entry.filePath)} [${entry.level}] ${entry.message}`).join("\n")}` : "";
    ctx.ui.notify(`Workflows:\n${names.join("\n")}\n\nRecent runs:\n${runs.slice(0, MAX_LISTED_RUNS).map((r) => `${r.id} \u00b7 ${r.workflow} \u00b7 ${r.status} \u00b7 ${r.startedAt}`).join("\n") || "None"}${diagnostics}`, discovery.diagnostics.some((entry) => entry.level === "error") ? "warning" : "info");
    return;
  }

  if (subcommand === "run") {
    const firstSpace = remainder.indexOf(" ");
    const name = firstSpace === -1 ? remainder : remainder.slice(0, firstSpace);
    const argText = firstSpace === -1 ? "" : remainder.slice(firstSpace + 1).trim();
    if (!name) throw new Error("Usage: /workflow run <name> <args>");
    const discovery = await loadWorkflowDiscovery(pi, repoRoot);
    const workflow = discovery.workflows.find((entry) => entry.spec.name.toLowerCase() === name.trim().toLowerCase());
    if (!workflow) {
      const hintedModule = listModuleSpecFiles(repoRoot).find((filePath) => basename(filePath, extname(filePath)).toLowerCase() === name.trim().toLowerCase());
      if (hintedModule) {
        const related = discovery.diagnostics.filter((entry) => entry.filePath === hintedModule);
        if (related.length > 0) throw new Error(`Workflow module '${basename(hintedModule)}' could not be loaded:\n${related.map((entry) => `- [${entry.level}] ${entry.message}`).join("\n")}`);
      }
      throw new Error(`Unknown workflow '${name}'`);
    }
    await runStepWorkflow(pi, workflow.spec, argText, ctx, getRepoRoot, createWorkflowContext);
    return;
  }

  if (subcommand === "show") {
    if (!remainder) throw new Error("Usage: /workflow show <run-id>");
    const manifest = getStoredRun(repoRoot, remainder);
    if (!manifest) throw new Error(`Run '${remainder}' not found`);
    ctx.ui.notify(JSON.stringify(manifest, null, 2), "info");
    return;
  }

  if (subcommand === "events") {
    if (!remainder) throw new Error("Usage: /workflow events <run-id>");
    const db = openWorkflowDb(repoRoot);
    try {
      if (!workflowRunExists(db, remainder) && listWorkflowRunEvents(db, remainder, 1).length === 0) {
        throw new Error(`Run '${remainder}' not found`);
      }
      const events = listWorkflowRunEvents(db, remainder);
      ctx.ui.notify(formatWorkflowRunEvents(events), "info");
    } finally {
      closeWorkflowDb(db);
    }
    return;
  }

  if (subcommand === "stop") {
    ensureDir(dirname(getStopFilePath(repoRoot)));
    recordStopRequest(repoRoot, "workflow");
    writeFileSync(getStopFilePath(repoRoot), "stop\n", "utf8");
    ctx.ui.notify(`Created stop marker at ${getStopFilePath(repoRoot)}`, "info");
    return;
  }

  throw new Error(`Unknown /workflow subcommand '${subcommand}'`);
}

async function handleGrindCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    const repoRoot = await getRepoRoot(pi, ctx.cwd);
    salvageOrphanBacklog(repoRoot);
    const workflow = await findWorkflow(pi, ctx.cwd, "grind");
    if (!workflow) throw new Error("grind workflow not found in .pi/workflows/specs/");
    await runStepWorkflow(pi, workflow.spec, trimmed, ctx, getRepoRoot, createWorkflowContext);
    return;
  }

  const [firstWord, ...rest] = trimmed.split(/\s+/);
  const remainder = rest.join(" ").trim();
  const GRIND_SUBCOMMANDS = new Set(["status", "list", "show", "clean", "checkout", "stop"]);

  if (!GRIND_SUBCOMMANDS.has(firstWord)) {
    // Not a subcommand — treat the entire input as the grind task.
    const repoRoot = await getRepoRoot(pi, ctx.cwd);
    salvageOrphanBacklog(repoRoot);
    const workflow = await findWorkflow(pi, ctx.cwd, "grind");
    if (!workflow) throw new Error("grind workflow not found in .pi/workflows/specs/");
    await runStepWorkflow(pi, workflow.spec, trimmed, ctx, getRepoRoot, createWorkflowContext);
    return;
  }

  switch (firstWord) {
    case "status": await showGrindStatus(pi, ctx); return;
    case "list": await showGrindList(pi, ctx); return;
    case "show": if (!remainder) throw new Error("Usage: /grind show <run-id>"); await showGrindRun(pi, remainder, ctx); return;
    case "clean": if (!remainder) throw new Error("Usage: /grind clean <run-id>"); await cleanGrindRun(pi, remainder, ctx); return;
    case "checkout": { const [runId, candidateId] = remainder.split(/\s+/).filter(Boolean); if (!runId || !candidateId) throw new Error("Usage: /grind checkout <run-id> <candidate-id>"); await checkoutGrindCandidate(pi, runId, candidateId, ctx); return; }
    case "stop": {
      const repoRoot = await getRepoRoot(pi, ctx.cwd);
      ensureDir(dirname(getStopFilePath(repoRoot)));
      recordStopRequest(repoRoot, "grind");
      writeFileSync(getStopFilePath(repoRoot), "stop\n", "utf8");
      ctx.ui.notify(`Created stop marker at ${getStopFilePath(repoRoot)}`, "info");
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function workflowExtension(pi: ExtensionAPI): void {
  // Track session cwd for completions (getArgumentCompletions has no ctx argument).
  let sessionCwd = process.cwd();
  pi.on("session_start", (_event, ctx) => { sessionCwd = ctx.cwd; });

  pi.registerTool(createDynamicWorkflowTool(async (cwd, agentName, prompt, signal, agentScope) => {
    const result = await runAgentTask(cwd, agentName, prompt, signal, agentScope);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.finalText.trim() || `Agent '${agentName}' failed with exit code ${result.exitCode}`);
    }
    return result.finalText || result.stdout || "";
  }));

  pi.registerCommand("workflow", {
    description: "Run autonomous workflow specs from .pi/workflows/specs/",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const endsWithSpace = /\s$/.test(trimmed);
      const root = ["help", "list", "run", "show", "events", "stop"];
      if (!trimmed) return root.map((value) => ({ value, label: value }));
      if (parts.length <= 1 && !endsWithSpace) return completeWorkflowArgument(parts[0] ?? "", root);
      if ((parts[0] ?? "") === "run") {
        const builtins = workflowNamesForCompletion(sessionCwd);
        const subPrefix = parts.length <= 1 || endsWithSpace ? "" : (parts[1] ?? "");
        return completeWorkflowArgument(subPrefix, builtins)?.map((item) => ({ value: `run ${item.value}`, label: item.label })) ?? null;
      }
      return null;
    },
    handler: async (args, ctx) => { await handleWorkflowCommand(pi, args, ctx); },
  });

  pi.registerCommand("grind", {
    description: "Run, inspect, and operate the autonomous git-worktree grinder (spec in .pi/workflows/specs/grind.mjs)",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const endsWithSpace = /\s$/.test(trimmed);
      const root = ["status", "list", "show", "clean", "checkout", "stop"];
      if (!trimmed) return root.map((value) => ({ value, label: value }));
      if (parts.length <= 1 && !endsWithSpace) return completeWorkflowArgument(parts[0] ?? "", root);
      return null;
    },
    handler: async (args, ctx) => { await handleGrindCommand(pi, args, ctx); },
  });

  pi.registerCommand("fuzz", {
    description: "Run a focused adversarial/fuzz workflow (spec in .pi/workflows/specs/fuzz.json)",
    handler: async (args, ctx) => {
      const workflow = await findWorkflow(pi, ctx.cwd, "fuzz");
      if (!workflow) throw new Error("fuzz workflow not found in .pi/workflows/specs/");
      await runStepWorkflow(pi, workflow.spec, args, ctx, getRepoRoot, createWorkflowContext);
    },
  });
}
