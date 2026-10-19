import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoopLockDeps } from "./loop-lock";
import { LoopScheduler } from "./scheduler";
import { hydrateRuntimeTask, InMemoryTaskStore } from "./task-store";
import type { StoredCronTask } from "./types";

let dir: string;
let lockFile: string;
const clock = { t: 0 };
let liveness: (pid: number) => boolean | "unknown" = () => true;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "loop-sched-"));
	lockFile = join(dir, "loop-tasks.lock");
	clock.t = 0;
	liveness = () => true;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function lockOptions(pid: number): Partial<LoopLockDeps> {
	return {
		lockFile,
		pid,
		now: () => clock.t,
		staleMs: 120_000,
		isProcessRunning: (p) => liveness(p),
	};
}

/** Minimal ExtensionAPI stub capturing sent messages. */
function makePi(): { pi: ExtensionAPI; sent: unknown[] } {
	const sent: unknown[] = [];
	const pi = {
		sendMessage: (msg: unknown) => {
			sent.push(msg);
		},
	} as unknown as ExtensionAPI;
	return { pi, sent };
}

function makeCtx(): ExtensionContext {
	return { hasUI: false } as unknown as ExtensionContext;
}

function makeStore(): InMemoryTaskStore {
	return new InMemoryTaskStore();
}

function addTask(store: InMemoryTaskStore, id: string): void {
	const stored: StoredCronTask = {
		id,
		prompt: "ping",
		cronExpr: "* * * * *",
		recurring: true,
		humanLabel: "1m",
		createdAt: 0,
		expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
	};
	store.add(hydrateRuntimeTask(stored));
}

/** Lets pending fire-and-forget async work (release/refresh) settle. */
async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 5));
}

function makeScheduler(store: InMemoryTaskStore, pid: number): LoopScheduler {
	const { pi } = makePi();
	const s = new LoopScheduler(pi, store, {}, lockOptions(pid));
	s.setContext(makeCtx());
	return s;
}

describe("passive session emptiness", () => {
	it("keeps its takeover probe alive when its last task is deleted", async () => {
		// Owner S1 grabs the lock first.
		const store1 = makeStore();
		addTask(store1, "t1");
		const s1 = makeScheduler(store1, 1000);
		await s1.start();
		expect(s1.isSchedulerOwner()).toBe(true);

		// Passive S2 starts probing (cannot acquire; S1 is a live owner).
		const store2 = makeStore();
		addTask(store2, "t2");
		const s2 = makeScheduler(store2, 2000);
		await s2.start();
		expect(s2.isSchedulerOwner()).toBe(false);
		expect(s2.hasProbeTimer()).toBe(true);

		// S2 deletes its last task. THE BUG: previously this called stop() and
		// killed the probe. It must keep probing.
		s2.deleteTask("t2");
		await settle();
		expect(s2.isSchedulerOwner()).toBe(false);
		expect(s2.hasProbeTimer()).toBe(true);
		expect(s2.hasCheckTimer()).toBe(false);

		// S1 goes away; S2 must still be able to take over.
		await s1.stop();
		await s2.start(); // fast-path re-acquire (models a probe tick)
		expect(s2.isSchedulerOwner()).toBe(true);

		await s2.stop();
	});

	it("clearAll on a passive session also keeps probing", async () => {
		const store1 = makeStore();
		addTask(store1, "t1");
		const s1 = makeScheduler(store1, 1000);
		await s1.start();

		const store2 = makeStore();
		addTask(store2, "t2");
		const s2 = makeScheduler(store2, 2000);
		await s2.start();
		expect(s2.hasProbeTimer()).toBe(true);

		s2.clearAll();
		await settle();
		expect(s2.hasProbeTimer()).toBe(true);
		expect(s2.isSchedulerOwner()).toBe(false);

		await s1.stop();
		await s2.stop();
	});
});

describe("owner emptiness", () => {
	it("releases the lock and reverts to passive probing so others can take over", async () => {
		const store1 = makeStore();
		addTask(store1, "t1");
		const s1 = makeScheduler(store1, 1000);
		await s1.start();
		expect(s1.isSchedulerOwner()).toBe(true);
		expect(s1.hasHeartbeatTimer()).toBe(true);

		s1.deleteTask("t1");
		await settle();
		// No longer owner, heartbeat stopped, but still probing for a future task.
		expect(s1.isSchedulerOwner()).toBe(false);
		expect(s1.hasHeartbeatTimer()).toBe(false);
		expect(s1.hasCheckTimer()).toBe(false);
		expect(s1.hasProbeTimer()).toBe(true);

		// Another session can now grab the freed lock.
		const store2 = makeStore();
		addTask(store2, "t2");
		const s2 = makeScheduler(store2, 2000);
		await s2.start();
		expect(s2.isSchedulerOwner()).toBe(true);

		await s1.stop();
		await s2.stop();
	});
});

describe("time-based staleness takeover", () => {
	it("passive session reclaims a lock whose (reused) PID looks alive but is stale", async () => {
		// S1 owns at t=0, and its pid keeps reporting alive (PID reuse after crash).
		const store1 = makeStore();
		addTask(store1, "t1");
		const s1 = makeScheduler(store1, 1000);
		await s1.start();
		expect(s1.isSchedulerOwner()).toBe(true);

		const store2 = makeStore();
		addTask(store2, "t2");
		const s2 = makeScheduler(store2, 2000);
		await s2.start();
		expect(s2.isSchedulerOwner()).toBe(false);

		// Advance the clock past staleMs WITHOUT S1 heartbeating (S1 "crashed").
		clock.t = 200_000;
		liveness = () => true; // pid still reports running

		await s2.start(); // probe tick
		expect(s2.isSchedulerOwner()).toBe(true);

		await s1.stop();
		await s2.stop();
	});
});

describe("heartbeat keeps ownership", () => {
	it("a heartbeating owner is NOT reclaimed by a probing passive session", async () => {
		const store1 = makeStore();
		addTask(store1, "t1");
		const s1 = makeScheduler(store1, 1000);
		await s1.start();

		const store2 = makeStore();
		addTask(store2, "t2");
		const s2 = makeScheduler(store2, 2000);
		await s2.start();
		expect(s2.isSchedulerOwner()).toBe(false);

		// Time advances past staleMs, but S1 heartbeats to refresh acquiredAt.
		clock.t = 200_000;
		await s1.heartbeatOnce();
		expect(s1.isSchedulerOwner()).toBe(true);

		// S2 probes at the same (now-refreshed) time → must stay passive.
		await s2.start();
		expect(s2.isSchedulerOwner()).toBe(false);
		expect(s1.isSchedulerOwner()).toBe(true);

		await s1.stop();
		await s2.stop();
	});

	it("an owner that lost the lock reverts to passive on its next heartbeat", async () => {
		const store1 = makeStore();
		addTask(store1, "t1");
		const s1 = makeScheduler(store1, 1000);
		await s1.start();
		expect(s1.isSchedulerOwner()).toBe(true);

		// Simulate reclaim: S1 goes stale and S2 steals the lock.
		clock.t = 200_000;
		liveness = () => true;
		const store2 = makeStore();
		addTask(store2, "t2");
		const s2 = makeScheduler(store2, 2000);
		await s2.start();
		expect(s2.isSchedulerOwner()).toBe(true);

		// S1's heartbeat now finds it no longer owns the lock → steps down.
		await s1.heartbeatOnce();
		expect(s1.isSchedulerOwner()).toBe(false);
		expect(s1.hasProbeTimer()).toBe(true);
		expect(s1.hasCheckTimer()).toBe(false);

		await s1.stop();
		await s2.stop();
	});
});

describe("concurrent takeover does not double-own", () => {
	it("only one of two probing passives wins a freed lock", async () => {
		const store1 = makeStore();
		addTask(store1, "t1");
		const s1 = makeScheduler(store1, 1000);
		await s1.start();

		const s2 = makeScheduler((() => { const s = makeStore(); addTask(s, "a"); return s; })(), 2000);
		const s3 = makeScheduler((() => { const s = makeStore(); addTask(s, "b"); return s; })(), 3000);
		await s2.start();
		await s3.start();
		expect(s2.isSchedulerOwner()).toBe(false);
		expect(s3.isSchedulerOwner()).toBe(false);

		// Free the lock, then race both probes.
		await s1.stop();
		await Promise.all([s2.start(), s3.start()]);

		const owners = [s2, s3].filter((s) => s.isSchedulerOwner());
		expect(owners.length).toBe(1);

		await s2.stop();
		await s3.stop();
	});
});
