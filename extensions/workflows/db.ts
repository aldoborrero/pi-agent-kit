import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BacklogItemRecord, WorkflowRunRecord } from "./api.js";

export const WORKFLOW_DB_PATH = ".pi/workflows/state.db";
const LEASE_TTL_MS = 30_000;

export type WorkflowDb = DatabaseSync;
export type WorkflowRunEventRecord = {
  id: number;
  run_id: string;
  type: string;
  message: string | null;
  data: unknown;
  created_at: string;
};

type RunRow = {
  id: string;
  workflow: string;
  description: string;
  title: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  cwd: string;
  args_text: string;
  args_hash: string;
  args_value_json: string | null;
  summary: string | null;
  error: string | null;
  outputs_json: string | null;
  tags_json: string | null;
  step_count: number | null;
  last_checkpoint: string | null;
  state_json: string | null;
  result_json: string | null;
  updated_at: string;
};

type LeaseRow = {
  run_id: string;
  owner_id: string;
  owner_pid: number | null;
  heartbeat_at: string;
  lease_expires_at: string;
};

type BacklogRow = {
  id: string;
  repo_root: string;
  title: string;
  body: string;
  kind: string;
  priority: string;
  status: string;
  source: string;
  owner_run_id: string | null;
  round: number | null;
  created_at: string;
  updated_at: string;
};

export type CandidateRecord = {
  id: string;
  run_id: string;
  branch: string | null;
  worktree: string | null;
  score: number | null;
  commit_sha: string | null;
  merged: number;
  merge_error: string | null;
  merge_commit: string | null;
  round: number | null;
  summary: string | null;
  exit_code: number | null;
  verify_exit_code: number | null;
  review_verdict: string | null;
};

type RunEventRow = {
  id: number;
  run_id: string;
  type: string;
  message: string | null;
  data_json: string | null;
  created_at: string;
};

function bootstrap(db: WorkflowDb): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      description TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL CHECK (status IN ('running','waiting','completed','failed','stopped')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      cwd TEXT NOT NULL,
      args_text TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      args_value_json TEXT,
      summary TEXT,
      error TEXT,
      outputs_json TEXT,
      tags_json TEXT,
      step_count INTEGER,
      last_checkpoint TEXT,
      state_json TEXT,
      result_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_resume
      ON workflow_runs (workflow, cwd, args_hash, status);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_unique_active
      ON workflow_runs (workflow, cwd, args_hash)
      WHERE status IN ('running', 'waiting');

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_started
      ON workflow_runs (cwd, started_at DESC);

    CREATE TABLE IF NOT EXISTS run_leases (
      run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      owner_pid INTEGER,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backlog_items (
      id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','in-progress','done','tried')),
      source TEXT NOT NULL,
      owner_run_id TEXT,
      round INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_backlog_pick
      ON backlog_items (repo_root, status, priority, created_at);

    CREATE TABLE IF NOT EXISTS backlog_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_candidates (
      id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      branch TEXT,
      worktree TEXT,
      score REAL,
      commit_sha TEXT,
      merged INTEGER NOT NULL DEFAULT 0,
      merge_error TEXT,
      merge_commit TEXT,
      round INTEGER,
      summary TEXT,
      exit_code INTEGER,
      verify_exit_code INTEGER,
      review_verdict TEXT,
      PRIMARY KEY (run_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_candidates_run
      ON workflow_candidates (run_id, round, id);

    CREATE TABLE IF NOT EXISTS workflow_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT,
      data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run
      ON workflow_run_events (run_id, id);
  `);
}

export function openWorkflowDb(repoRoot: string): WorkflowDb {
  mkdirSync(join(repoRoot, ".pi/workflows"), { recursive: true });
  const db = new DatabaseSync(join(repoRoot, WORKFLOW_DB_PATH));
  bootstrap(db);
  return db;
}

export function closeWorkflowDb(db: WorkflowDb): void {
  db.close();
}

export function normalizeArgsText(argsText: string): string {
  return argsText.trim();
}

export function hashArgs(argsText: string): string {
  return createHash("sha256").update(normalizeArgsText(argsText)).digest("hex");
}

export function makeLeaseOwnerId(): string {
  return `${process.pid}:${randomUUID()}`;
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function withTransaction<T>(db: WorkflowDb, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw error;
  }
}

export function upsertWorkflowRun(db: WorkflowDb, run: WorkflowRunRecord): void {
  db.prepare(`
    INSERT INTO workflow_runs (
      id, workflow, description, title, status, started_at, ended_at, cwd,
      args_text, args_hash, args_value_json, summary, error, outputs_json,
      tags_json, step_count, last_checkpoint, state_json, result_json, updated_at
    ) VALUES (
      :id, :workflow, :description, :title, :status, :started_at, :ended_at, :cwd,
      :args_text, :args_hash, :args_value_json, :summary, :error, :outputs_json,
      :tags_json, :step_count, :last_checkpoint, :state_json, :result_json, :updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      workflow = excluded.workflow,
      description = excluded.description,
      title = excluded.title,
      status = excluded.status,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      cwd = excluded.cwd,
      args_text = excluded.args_text,
      args_hash = excluded.args_hash,
      args_value_json = excluded.args_value_json,
      summary = excluded.summary,
      error = excluded.error,
      outputs_json = excluded.outputs_json,
      tags_json = excluded.tags_json,
      step_count = excluded.step_count,
      last_checkpoint = excluded.last_checkpoint,
      state_json = excluded.state_json,
      result_json = excluded.result_json,
      updated_at = excluded.updated_at
  `).run({
    id: run.id,
    workflow: run.workflow,
    description: run.description,
    title: run.title ?? null,
    status: run.status,
    started_at: run.startedAt,
    ended_at: run.endedAt ?? null,
    cwd: run.cwd,
    args_text: run.argsText,
    args_hash: hashArgs(run.argsText),
    args_value_json: run.argsValue === undefined ? null : JSON.stringify(run.argsValue),
    summary: run.summary ?? null,
    error: run.error ?? null,
    outputs_json: run.outputs === undefined ? null : JSON.stringify(run.outputs),
    tags_json: run.tags === undefined ? null : JSON.stringify(run.tags),
    step_count: run.stepCount ?? null,
    last_checkpoint: run.lastCheckpoint ?? null,
    state_json: run.state === undefined ? null : JSON.stringify(run.state),
    result_json: run.result === undefined ? null : JSON.stringify(run.result),
    updated_at: new Date().toISOString(),
  });
}

function rowToRunRecord(row: RunRow): WorkflowRunRecord {
  return {
    id: row.id,
    workflow: row.workflow,
    description: row.description,
    title: row.title ?? undefined,
    status: row.status as WorkflowRunRecord["status"],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    cwd: row.cwd,
    argsText: row.args_text,
    argsValue: row.args_value_json ? JSON.parse(row.args_value_json) : undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    outputs: row.outputs_json ? JSON.parse(row.outputs_json) : undefined,
    tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
    stepCount: row.step_count ?? undefined,
    lastCheckpoint: row.last_checkpoint ?? undefined,
    state: row.state_json ? JSON.parse(row.state_json) : undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
  };
}

export function getWorkflowRun(db: WorkflowDb, repoRoot: string, runId: string): WorkflowRunRecord | null {
  const row = db.prepare(`
    SELECT * FROM workflow_runs WHERE cwd = ? AND id = ?
  `).get(repoRoot, runId) as RunRow | null;
  return row ? rowToRunRecord(row) : null;
}

export function listWorkflowRuns(db: WorkflowDb, repoRoot: string): WorkflowRunRecord[] {
  const rows = db.prepare(`
    SELECT * FROM workflow_runs
    WHERE cwd = ?
    ORDER BY started_at DESC
  `).all(repoRoot) as RunRow[];
  return rows.map(rowToRunRecord);
}

export function deleteWorkflowRun(db: WorkflowDb, repoRoot: string, runId: string): void {
  db.prepare(`
    DELETE FROM workflow_runs
    WHERE cwd = ? AND id = ?
  `).run(repoRoot, runId);
}

export function findResumableWorkflowRun(db: WorkflowDb, repoRoot: string, workflow: string, argsText: string): WorkflowRunRecord | null {
  const row = db.prepare(`
    SELECT * FROM workflow_runs
    WHERE cwd = ?
      AND workflow = ?
      AND args_hash = ?
      AND status IN ('running', 'waiting')
    ORDER BY started_at DESC
    LIMIT 1
  `).get(repoRoot, workflow, hashArgs(argsText)) as RunRow | null;
  return row ? rowToRunRecord(row) : null;
}

export function acquireWorkflowLease(db: WorkflowDb, runId: string, ownerId: string, ownerPid = process.pid, ttlMs = LEASE_TTL_MS): void {
  const now = Date.now();
  const heartbeatAt = new Date(now).toISOString();
  const leaseExpiresAt = new Date(now + ttlMs).toISOString();
  withTransaction(db, () => {
    const existing = db.prepare(`SELECT * FROM run_leases WHERE run_id = ?`).get(runId) as LeaseRow | null;
    const leaseActive = existing && new Date(existing.lease_expires_at).getTime() > now;
    const holderAlive = existing && isPidAlive(existing.owner_pid);
    if (existing && leaseActive && holderAlive && existing.owner_id !== ownerId) {
      throw new Error(`Run '${runId}' is already active (owner=${existing.owner_id})`);
    }
    db.prepare(`
      INSERT INTO run_leases (run_id, owner_id, owner_pid, heartbeat_at, lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        owner_pid = excluded.owner_pid,
        heartbeat_at = excluded.heartbeat_at,
        lease_expires_at = excluded.lease_expires_at
    `).run(runId, ownerId, ownerPid, heartbeatAt, leaseExpiresAt);
  });
}

export function heartbeatWorkflowLease(db: WorkflowDb, runId: string, ownerId: string, ttlMs = LEASE_TTL_MS): void {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE run_leases
    SET heartbeat_at = ?, lease_expires_at = ?
    WHERE run_id = ? AND owner_id = ?
  `).run(
    new Date(now).toISOString(),
    new Date(now + ttlMs).toISOString(),
    runId,
    ownerId,
  );
  if ((result.changes ?? 0) === 0) throw new Error(`Lost lease for run '${runId}'`);
}

export function releaseWorkflowLease(db: WorkflowDb, runId: string, ownerId: string): void {
  db.prepare(`DELETE FROM run_leases WHERE run_id = ? AND owner_id = ?`).run(runId, ownerId);
}

export function appendWorkflowRunEvent(
  db: WorkflowDb,
  runId: string,
  type: string,
  options?: { message?: string; data?: unknown; createdAt?: string },
): void {
  db.prepare(`
    INSERT INTO workflow_run_events (run_id, type, message, data_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    runId,
    type,
    options?.message ?? null,
    options?.data === undefined ? null : JSON.stringify(options.data),
    options?.createdAt ?? new Date().toISOString(),
  );
}

export function tryAppendWorkflowRunEvent(
  db: WorkflowDb,
  runId: string,
  type: string,
  options?: { message?: string; data?: unknown; createdAt?: string },
): void {
  try {
    appendWorkflowRunEvent(db, runId, type, options);
  } catch {
    // Observability must not change workflow behavior.
  }
}

function rowToWorkflowRunEvent(row: RunEventRow): WorkflowRunEventRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    type: row.type,
    message: row.message ?? null,
    data: row.data_json ? JSON.parse(row.data_json) : undefined,
    created_at: row.created_at,
  };
}

export function listWorkflowRunEvents(db: WorkflowDb, runId: string, limit = 200): WorkflowRunEventRecord[] {
  const rows = db.prepare(`
    SELECT * FROM workflow_run_events
    WHERE run_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(runId, limit) as RunEventRow[];
  return rows.reverse().map(rowToWorkflowRunEvent);
}

export function workflowRunExists(db: WorkflowDb, runId: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS found
    FROM workflow_runs
    WHERE id = ?
    LIMIT 1
  `).get(runId) as { found: number } | null;
  return Boolean(row);
}

function rowToBacklogRecord(row: BacklogRow): BacklogItemRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status as BacklogItemRecord["status"],
    body: row.body,
    path: "",
    metadata: {
      id: row.id,
      title: row.title,
      kind: row.kind as BacklogItemRecord["metadata"]["kind"],
      priority: row.priority as BacklogItemRecord["metadata"]["priority"],
      source: row.source,
      status: row.status as BacklogItemRecord["metadata"]["status"],
      createdAt: row.created_at,
      owner: row.owner_run_id ?? undefined,
      round: row.round ?? undefined,
    },
  };
}

export function listBacklogRecords(db: WorkflowDb, repoRoot: string, status: BacklogItemRecord["status"]): BacklogItemRecord[] {
  const rows = db.prepare(`
    SELECT * FROM backlog_items
    WHERE repo_root = ? AND status = ?
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        ELSE 3
      END,
      created_at ASC
  `).all(repoRoot, status) as BacklogRow[];
  return rows.map(rowToBacklogRecord);
}

export function countBacklogRecords(db: WorkflowDb, repoRoot: string, status: BacklogItemRecord["status"]): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM backlog_items
    WHERE repo_root = ? AND status = ?
  `).get(repoRoot, status) as { count: number };
  return row.count;
}

export function createBacklogRecord(db: WorkflowDb, repoRoot: string, item: BacklogItemRecord): BacklogItemRecord {
  db.prepare(`
    INSERT INTO backlog_items (
      id, repo_root, title, body, kind, priority, status, source,
      owner_run_id, round, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    repoRoot,
    item.title,
    item.body,
    item.metadata.kind,
    item.metadata.priority,
    item.status,
    item.metadata.source,
    item.metadata.owner ?? null,
    item.metadata.round ?? null,
    item.metadata.createdAt,
    new Date().toISOString(),
  );
  return item;
}

export function claimBacklogRecords(
  db: WorkflowDb,
  repoRoot: string,
  ids: string[],
  owner: string,
  round: number,
): BacklogItemRecord[] {
  if (ids.length === 0) return [];
  return withTransaction(db, () => {
    const select = db.prepare(`
      SELECT * FROM backlog_items
      WHERE repo_root = ?
        AND status = 'open'
        AND id = ?
    `);
    const update = db.prepare(`
      UPDATE backlog_items
      SET status = 'in-progress',
          owner_run_id = ?,
          round = ?,
          updated_at = ?
      WHERE repo_root = ?
        AND id = ?
        AND status = 'open'
    `);
    const claimed: BacklogItemRecord[] = [];
    const now = new Date().toISOString();
    for (const id of ids) {
      const row = select.get(repoRoot, id) as BacklogRow | null;
      if (!row) continue;
      const result = update.run(owner, round, now, repoRoot, id);
      if ((result.changes ?? 0) !== 1) continue;
      claimed.push({
        ...rowToBacklogRecord(row),
        status: "in-progress",
        metadata: {
          ...rowToBacklogRecord(row).metadata,
          status: "in-progress",
          owner,
          round,
        },
      });
    }
    return claimed;
  });
}

export function moveBacklogRecord(
  db: WorkflowDb,
  item: BacklogItemRecord,
  status: BacklogItemRecord["status"],
  extra?: Partial<Pick<BacklogItemRecord["metadata"], "owner" | "round" | "source" | "priority" | "kind">>,
): BacklogItemRecord {
  db.prepare(`
    UPDATE backlog_items
    SET
      status = ?,
      source = ?,
      priority = ?,
      kind = ?,
      owner_run_id = ?,
      round = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    status,
    extra?.source ?? item.metadata.source,
    extra?.priority ?? item.metadata.priority,
    extra?.kind ?? item.metadata.kind,
    extra?.owner ?? null,
    extra?.round ?? item.metadata.round ?? null,
    new Date().toISOString(),
    item.id,
  );
  return {
    ...item,
    status,
    metadata: {
      ...item.metadata,
      status,
      source: extra?.source ?? item.metadata.source,
      priority: extra?.priority ?? item.metadata.priority,
      kind: extra?.kind ?? item.metadata.kind,
      owner: extra?.owner,
      round: extra?.round ?? item.metadata.round,
    },
  };
}

export function noteBacklogRecord(db: WorkflowDb, itemId: string, note: string): void {
  db.prepare(`
    INSERT INTO backlog_notes (backlog_item_id, note, created_at)
    VALUES (?, ?, ?)
  `).run(itemId, note, new Date().toISOString());
}

export function replaceWorkflowCandidates(
  db: WorkflowDb,
  runId: string,
  candidates: Array<{
    id: string;
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
    verify?: { exitCode?: number };
    review?: { verdict?: "pass" | "block" | "unknown" };
  }>,
): void {
  withTransaction(db, () => {
    db.prepare(`DELETE FROM workflow_candidates WHERE run_id = ?`).run(runId);
    const insert = db.prepare(`
      INSERT INTO workflow_candidates (
        id, run_id, branch, worktree, score, commit_sha, merged,
        merge_error, merge_commit, round, summary, exit_code,
        verify_exit_code, review_verdict
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const candidate of candidates) {
      insert.run(
        candidate.id,
        runId,
        candidate.branch ?? null,
        candidate.worktree ?? null,
        candidate.score ?? null,
        candidate.commit ?? null,
        candidate.merged ? 1 : 0,
        candidate.mergeError ?? null,
        candidate.mergeCommit ?? null,
        candidate.round ?? null,
        candidate.summary ?? null,
        candidate.exitCode ?? null,
        candidate.verify?.exitCode ?? null,
        candidate.review?.verdict ?? null,
      );
    }
  });
}

export function upsertWorkflowCandidate(
  db: WorkflowDb,
  runId: string,
  candidate: {
    id: string;
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
  },
): void {
  db.prepare(`
    INSERT INTO workflow_candidates (
      id, run_id, branch, worktree, score, commit_sha, merged,
      merge_error, merge_commit, round, summary, exit_code,
      verify_exit_code, review_verdict
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, id) DO UPDATE SET
      branch = excluded.branch,
      worktree = excluded.worktree,
      score = excluded.score,
      commit_sha = excluded.commit_sha,
      merged = excluded.merged,
      merge_error = excluded.merge_error,
      merge_commit = excluded.merge_commit,
      round = excluded.round,
      summary = excluded.summary,
      exit_code = excluded.exit_code,
      verify_exit_code = excluded.verify_exit_code,
      review_verdict = excluded.review_verdict
  `).run(
    candidate.id,
    runId,
    candidate.branch ?? null,
    candidate.worktree ?? null,
    candidate.score ?? null,
    candidate.commit ?? null,
    candidate.merged ? 1 : 0,
    candidate.mergeError ?? null,
    candidate.mergeCommit ?? null,
    candidate.round ?? null,
    candidate.summary ?? null,
    candidate.exitCode ?? null,
    candidate.verifyExitCode ?? null,
    candidate.reviewVerdict ?? null,
  );
}

export function listWorkflowCandidates(db: WorkflowDb, runId: string): CandidateRecord[] {
  return db.prepare(`
    SELECT *
    FROM workflow_candidates
    WHERE run_id = ?
    ORDER BY COALESCE(round, 0), id
  `).all(runId) as CandidateRecord[];
}
