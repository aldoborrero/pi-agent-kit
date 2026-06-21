export type WorkflowRunStatus = "running" | "waiting" | "completed" | "failed" | "stopped";

export interface WorkflowRunInit<TState> {
  title?: string;
  state: TState;
  summary?: string;
  tags?: string[];
}

export type WorkflowStepResult<TState, TResult> =
  | {
      kind: "continue";
      state: TState;
      summary?: string;
      checkpoint?: string;
    }
  | {
      kind: "wait";
      state: TState;
      reason?: string;
      wakeAt?: string;
    }
  | {
      kind: "complete";
      state: TState;
      result?: TResult;
      summary?: string;
    }
  | {
      kind: "failed";
      state: TState;
      error: string;
      summary?: string;
      retryable?: boolean;
    };

export interface WorkflowRunRecord<TState = unknown, TResult = unknown> {
  id: string;
  workflow: string;
  description: string;
  title?: string;
  status: WorkflowRunStatus;
  startedAt: string;
  endedAt?: string;
  cwd: string;
  argsText: string;
  argsValue?: unknown;
  summary?: string;
  error?: string;
  outputs?: string[];
  tags?: string[];
  stepCount?: number;
  lastCheckpoint?: string;
  state?: TState;
  result?: TResult;
}

export interface WorkflowLogger {
  info(message: string): Promise<void>;
  warn(message: string): Promise<void>;
  error(message: string): Promise<void>;
  event(type: string, data?: unknown): Promise<void>;
}

export interface WorkflowStore {
  getRun<TState = unknown, TResult = unknown>(): Promise<WorkflowRunRecord<TState, TResult>>;
  saveRun<TState = unknown, TResult = unknown>(run: WorkflowRunRecord<TState, TResult>): Promise<void>;
  updateRun(patch: Partial<WorkflowRunRecord>): Promise<void>;
}

export interface WorkflowControlApi {
  isStopRequested(): Promise<boolean>;
  assertNotStopped(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export interface WorkflowUiApi {
  notify(message: string, type?: string): void;
  confirm(message: string, detail?: string): Promise<boolean>;
}

export type BacklogStatus = "open" | "in-progress" | "done" | "tried";
export type BacklogPriority = "low" | "medium" | "high" | "critical";
export type BacklogKind = "task" | "bug" | "perf" | "coverage" | "refactor" | "research" | "meta";

export interface BacklogItemRecord {
  id: string;
  title: string;
  status: BacklogStatus;
  body: string;
  path: string;
  metadata: {
    id: string;
    title: string;
    kind: BacklogKind;
    priority: BacklogPriority;
    source: string;
    status: BacklogStatus;
    createdAt: string;
    owner?: string;
    round?: number;
  };
}

export interface WorkflowArtifactsApi {
  write(kind: string, name: string, content: string): Promise<string>;
}

export interface WorkflowCandidateRecord {
  id: string;
  runId: string;
  branch?: string;
  worktree?: string;
  score?: number;
  commit?: string;
  merged?: boolean;
  mergeError?: string;
  mergeCommit?: string;
  round?: number;
  summary?: string;
  exitCode?: number;
  verifyExitCode?: number;
  reviewVerdict?: "pass" | "block" | "unknown";
}

export interface WorkflowCandidateApi {
  upsert(candidate: WorkflowCandidateRecord): Promise<void>;
  list(runId?: string): Promise<WorkflowCandidateRecord[]>;
}

export interface WorkflowAgentTask {
  agent: string;
  task: string;
  cwd?: string;
  agentScope?: "user" | "project" | "both";
}

export interface WorkflowAgentResult {
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
}

export interface WorkflowAgentApi {
  run(task: WorkflowAgentTask): Promise<WorkflowAgentResult>;
}

// --- Generic workflow context ------------------------------------------------
// Neutral core: any workflow can rely on this.

export interface WorkflowContext {
  runId: string;
  cwd: string;
  log: WorkflowLogger;
  store: WorkflowStore;
  control: WorkflowControlApi;
  ui: WorkflowUiApi;
  signal: AbortSignal | undefined;
  env: Record<string, string | undefined>;
}

// --- Code-specific context extensions ----------------------------------------
// These are domain-specific and only relevant to the grinder harness.
// Generic workflows should not depend on them.

export interface WorkflowBacklogApi {
  list(status: BacklogStatus): Promise<BacklogItemRecord[]>;
  count(status: BacklogStatus): Promise<number>;
  create(
    title: string,
    body: string,
    prefix?: string,
    metadata?: Partial<Omit<BacklogItemRecord["metadata"], "id" | "title" | "status" | "createdAt">>,
  ): Promise<BacklogItemRecord>;
  move(
    item: BacklogItemRecord,
    status: BacklogStatus,
    extra?: Partial<Pick<BacklogItemRecord["metadata"], "owner" | "round" | "source" | "priority" | "kind">>,
  ): Promise<BacklogItemRecord>;
  claim(ids: string[], owner: string, round: number): Promise<BacklogItemRecord[]>;
  note(item: BacklogItemRecord, note: string): Promise<void>;
  pick(limit: number): Promise<BacklogItemRecord[]>;
}

export interface WorkflowWorktreeRecord {
  id: string;
  path: string;
  branch: string;
  baseRef: string;
}

export interface WorkflowWorktreeApi {
  create(id: string, branch: string, baseRef: string): Promise<WorkflowWorktreeRecord>;
  remove(path: string): Promise<void>;
}

export interface WorkflowReviewResult {
  agent: string;
  verdict: "pass" | "block" | "unknown";
  summary: string;
  raw: string;
}

export interface WorkflowReviewApi {
  reviewCandidate(task: {
    worktree: string;
    itemTitle: string;
    itemBody: string;
    candidateId: string;
    candidateSummary: string;
    agent?: string;
    agentScope?: "user" | "project" | "both";
  }): Promise<WorkflowReviewResult>;
  judgeCandidates(task: {
    repoRoot: string;
    task: string;
    candidates: Array<{
      id: string;
      score?: number;
      exitCode: number;
      verifyExitCode?: number;
      reviewVerdict?: "pass" | "block" | "unknown";
      summary: string;
    }>;
    agent?: string;
    agentScope?: "user" | "project" | "both";
  }): Promise<string[] | null>;
}

export interface WorkflowMergeApi {
  commitIfNeeded(cwd: string, message: string): Promise<string | undefined>;
  mergeCandidate(task: {
    repoRoot: string;
    commit?: string;
    verify?: string;
  }): Promise<{ merged: boolean; mergeError?: string; mergeCommit?: string }>;
}

// CodeWorkflowContext = generic core + code-grinder extensions.
// The WorkflowSpec type still uses `WorkflowContext` for the neutral contract.
// Grinder harnesses extend it via this superset.

export interface CodeWorkflowContext extends WorkflowContext {
  artifacts: WorkflowArtifactsApi;
  candidates: WorkflowCandidateApi;
  agents: WorkflowAgentApi;
  backlog: WorkflowBacklogApi;
  worktrees: WorkflowWorktreeApi;
  review: WorkflowReviewApi;
  merge: WorkflowMergeApi;
}

export interface WorkflowSpec<TInput = unknown, TState = unknown, TResult = unknown> {
  name: string;
  description: string;
  parseInput?(raw: string): Promise<TInput> | TInput;
  createRun(input: TInput, ctx: WorkflowContext): Promise<WorkflowRunInit<TState>> | WorkflowRunInit<TState>;
  step(state: TState, ctx: WorkflowContext): Promise<WorkflowStepResult<TState, TResult>> | WorkflowStepResult<TState, TResult>;
}
