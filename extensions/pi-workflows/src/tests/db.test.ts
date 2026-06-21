import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWorkflowLease,
  claimBacklogRecords,
  closeWorkflowDb,
  createBacklogRecord,
  findResumableWorkflowRun,
  getWorkflowRun,
  listBacklogRecords,
  makeLeaseOwnerId,
  openWorkflowDb,
  releaseWorkflowLease,
  upsertWorkflowRun,
} from "../db.js";
import type { BacklogItemRecord, WorkflowRunRecord } from "../api.js";

function makeRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "workflows-db-test-"));
}

function makeRun(repoRoot: string, overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: "run-1",
    workflow: "grind",
    description: "test run",
    status: "running",
    startedAt: "2026-05-29T00:00:00.000Z",
    cwd: repoRoot,
    argsText: "ship it",
    stepCount: 0,
    state: { phase: "start" },
    ...overrides,
  };
}

function makeBacklogItem(id: string): BacklogItemRecord {
  return {
    id,
    title: id,
    status: "open",
    body: `body for ${id}`,
    path: "",
    metadata: {
      id,
      title: id,
      kind: "task",
      priority: "medium",
      source: "test",
      status: "open",
      createdAt: "2026-05-29T00:00:00.000Z",
    },
  };
}

test("workflow runs round-trip and resumable lookup works", () => {
  const repoRoot = makeRepoRoot();
  const db = openWorkflowDb(repoRoot);
  try {
    const run = makeRun(repoRoot);
    upsertWorkflowRun(db, run);

    const stored = getWorkflowRun(db, repoRoot, run.id);
    assert.ok(stored);
    assert.equal(stored.id, run.id);
    assert.deepEqual(stored.state, { phase: "start" });

    const resumable = findResumableWorkflowRun(db, repoRoot, "grind", "ship it");
    assert.ok(resumable);
    assert.equal(resumable.id, run.id);
  } finally {
    closeWorkflowDb(db);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("active run uniqueness rejects duplicate logical active runs", () => {
  const repoRoot = makeRepoRoot();
  const db = openWorkflowDb(repoRoot);
  try {
    upsertWorkflowRun(db, makeRun(repoRoot, { id: "run-1" }));
    assert.throws(() => {
      upsertWorkflowRun(db, makeRun(repoRoot, { id: "run-2" }));
    });
  } finally {
    closeWorkflowDb(db);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("workflow lease blocks live owners but can be reclaimed from dead ones", () => {
  const repoRoot = makeRepoRoot();
  const db = openWorkflowDb(repoRoot);
  try {
    const run = makeRun(repoRoot);
    upsertWorkflowRun(db, run);

    const ownerA = makeLeaseOwnerId();
    acquireWorkflowLease(db, run.id, ownerA, process.pid);
    assert.throws(() => {
      acquireWorkflowLease(db, run.id, "second-owner", process.pid);
    }, /already active/);
    releaseWorkflowLease(db, run.id, ownerA);

    const ownerDead = "dead-owner";
    acquireWorkflowLease(db, run.id, ownerDead, 999_999_999);
    acquireWorkflowLease(db, run.id, "new-owner", process.pid);
  } finally {
    closeWorkflowDb(db);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("backlog claims are atomic and only move open items once", () => {
  const repoRoot = makeRepoRoot();
  const db = openWorkflowDb(repoRoot);
  try {
    createBacklogRecord(db, repoRoot, makeBacklogItem("task-1"));
    createBacklogRecord(db, repoRoot, makeBacklogItem("task-2"));

    const firstClaim = claimBacklogRecords(db, repoRoot, ["task-1", "task-2"], "run-a", 1);
    assert.equal(firstClaim.length, 2);
    assert.equal(firstClaim[0]?.status, "in-progress");

    const secondClaim = claimBacklogRecords(db, repoRoot, ["task-1", "task-2"], "run-b", 2);
    assert.equal(secondClaim.length, 0);

    const open = listBacklogRecords(db, repoRoot, "open");
    const inProgress = listBacklogRecords(db, repoRoot, "in-progress");
    assert.equal(open.length, 0);
    assert.equal(inProgress.length, 2);
    assert.equal(inProgress[0]?.metadata.owner, "run-a");
  } finally {
    closeWorkflowDb(db);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
