import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LoopLockDeps,
	refreshLoopSchedulerLock,
	releaseLoopSchedulerLock,
	tryAcquireLoopSchedulerLock,
} from "./loop-lock";

let dir: string;
let lockFile: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "loop-lock-"));
	lockFile = join(dir, "loop-tasks.lock");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Builds lock overrides with a fixed clock and a controllable liveness probe. */
function deps(over: Partial<LoopLockDeps> = {}): Partial<LoopLockDeps> {
	return {
		lockFile,
		pid: 1000,
		now: () => 0,
		staleMs: 120_000,
		isProcessRunning: () => false,
		...over,
	};
}

async function readRaw(): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(lockFile, "utf-8"));
	} catch {
		return undefined;
	}
}

describe("tryAcquireLoopSchedulerLock", () => {
	it("acquires an unheld lock", async () => {
		const owned = await tryAcquireLoopSchedulerLock("A", deps());
		expect(owned).toBe(true);
		const raw = await readRaw();
		expect(raw?.sessionId).toBe("A");
	});

	it("refuses when a live owner holds a fresh lock", async () => {
		const now = { t: 0 };
		const over = deps({ now: () => now.t, isProcessRunning: () => true });
		expect(await tryAcquireLoopSchedulerLock("A", { ...over, pid: 1000 })).toBe(true);

		// Different session, live pid, only a little time later → cannot take over.
		now.t = 10_000;
		const owned = await tryAcquireLoopSchedulerLock("B", { ...over, pid: 2000 });
		expect(owned).toBe(false);
		expect((await readRaw())?.sessionId).toBe("A");
	});

	it("reclaims a lock with a dead pid regardless of timestamp", async () => {
		// A holds it, fresh timestamp, but its process is gone.
		await writeFile(lockFile, JSON.stringify({ sessionId: "A", pid: 1000, acquiredAt: 0 }), "utf-8");
		const owned = await tryAcquireLoopSchedulerLock("B", deps({ pid: 2000, now: () => 5_000, isProcessRunning: () => false }));
		expect(owned).toBe(true);
		expect((await readRaw())?.sessionId).toBe("B");
	});

	it("reclaims via time-based staleness even when the pid still looks alive (PID reuse)", async () => {
		await writeFile(lockFile, JSON.stringify({ sessionId: "A", pid: 1000, acquiredAt: 0 }), "utf-8");
		// pid reports running (reused pid), but acquiredAt is far past staleMs.
		const owned = await tryAcquireLoopSchedulerLock("B", deps({
			pid: 2000,
			now: () => 200_000,
			staleMs: 120_000,
			isProcessRunning: () => true,
		}));
		expect(owned).toBe(true);
		expect((await readRaw())?.sessionId).toBe("B");
	});

	it("does NOT reclaim a live owner before staleMs (heartbeat window)", async () => {
		await writeFile(lockFile, JSON.stringify({ sessionId: "A", pid: 1000, acquiredAt: 0 }), "utf-8");
		const owned = await tryAcquireLoopSchedulerLock("B", deps({
			pid: 2000,
			now: () => 90_000, // < staleMs (120s)
			staleMs: 120_000,
			isProcessRunning: () => true,
		}));
		expect(owned).toBe(false);
		expect((await readRaw())?.sessionId).toBe("A");
	});

	it("treats EPERM ('unknown') as indeterminate and falls back to the timestamp", async () => {
		await writeFile(lockFile, JSON.stringify({ sessionId: "A", pid: 1000, acquiredAt: 0 }), "utf-8");
		const unknownProbe = () => "unknown" as const;

		// Fresh timestamp + unknown liveness → must NOT steal.
		expect(await tryAcquireLoopSchedulerLock("B", deps({
			pid: 2000, now: () => 10_000, isProcessRunning: unknownProbe,
		}))).toBe(false);
		expect((await readRaw())?.sessionId).toBe("A");

		// Stale timestamp + unknown liveness → steal via timestamp fallback.
		expect(await tryAcquireLoopSchedulerLock("B", deps({
			pid: 2000, now: () => 200_000, isProcessRunning: unknownProbe,
		}))).toBe(true);
		expect((await readRaw())?.sessionId).toBe("B");
	});

	it("re-refreshes the lock when the same session re-acquires", async () => {
		await tryAcquireLoopSchedulerLock("A", deps({ now: () => 1_000 }));
		await tryAcquireLoopSchedulerLock("A", deps({ now: () => 9_000 }));
		expect((await readRaw())?.acquiredAt).toBe(9_000);
	});

	it("concurrent steal of the same stale lock does not double-own", async () => {
		// Both B and C see the same stale lock from A and race to steal it. A is
		// reclaimable because its heartbeat is ancient (acquiredAt=0, far beyond
		// staleMs) — NOT because its pid is dead. The racers B and C are live
		// processes (isProcessRunning=true), so once one of them writes its fresh
		// lock the other must NOT be able to steal it (its acquiredAt is current).
		// This models production, where process.kill(pid,0) reports a live racer.
		await writeFile(lockFile, JSON.stringify({ sessionId: "A", pid: 1000, acquiredAt: 0 }), "utf-8");
		const common = { now: () => 200_000, staleMs: 120_000, isProcessRunning: () => true as const };
		const [b, c] = await Promise.all([
			tryAcquireLoopSchedulerLock("B", deps({ ...common, pid: 2000 })),
			tryAcquireLoopSchedulerLock("C", deps({ ...common, pid: 3000 })),
		]);
		// Exactly one wins; the other stays passive.
		expect([b, c].filter(Boolean).length).toBe(1);
		const owner = (await readRaw())?.sessionId;
		expect(owner === "B" || owner === "C").toBe(true);
	});

	it("steal does not delete a different session's freshly-written lock (TOCTOU re-read guard)", async () => {
		// B reads a STALE lock owned by A and decides to reclaim it. But between
		// B's read and B's unlink, session D atomically replaces the lock with a
		// fresh copy. The content-match guard must detect the change and refuse to
		// unlink D's lock, so D keeps ownership and B stays passive.
		const staleA = { sessionId: "A", pid: 1000, acquiredAt: 0 };
		await writeFile(lockFile, JSON.stringify(staleA), "utf-8");

		// now() call order in tryAcquireLoopSchedulerLock:
		//   #1 building our candidate lock (top of fn, before any read)
		//   #2 inside isReclaimable, AFTER the initial readLock saw stale A,
		//      and BEFORE stealIfUnchanged re-reads the file.
		// Swap the file to a fresh D lock on call #2 to model a concurrent writer
		// landing in the TOCTOU window. The re-read must then see D != A and abort.
		let calls = 0;
		const interposingNow = () => {
			calls++;
			if (calls === 2) {
				require("node:fs").writeFileSync(
					lockFile,
					JSON.stringify({ sessionId: "D", pid: 4000, acquiredAt: 200_000 }),
				);
			}
			return 200_000;
		};

		const owned = await tryAcquireLoopSchedulerLock("B", deps({
			pid: 2000,
			now: interposingNow,
			staleMs: 120_000,
			// A looks dead → B decides to reclaim based on the stale A it first read.
			isProcessRunning: () => false,
		}));

		// B must lose: it must not have deleted D's fresh lock, and the exclusive
		// create then fails because D still holds it.
		expect(owned).toBe(false);
		expect((await readRaw())?.sessionId).toBe("D");
	});
});

describe("refreshLoopSchedulerLock", () => {
	it("updates acquiredAt for the owning session", async () => {
		await tryAcquireLoopSchedulerLock("A", deps({ now: () => 0 }));
		const ok = await refreshLoopSchedulerLock("A", deps({ now: () => 50_000 }));
		expect(ok).toBe(true);
		expect((await readRaw())?.acquiredAt).toBe(50_000);
	});

	it("returns false and does not clobber when another session owns the lock", async () => {
		await writeFile(lockFile, JSON.stringify({ sessionId: "OTHER", pid: 9, acquiredAt: 0 }), "utf-8");
		const ok = await refreshLoopSchedulerLock("A", deps({ now: () => 50_000 }));
		expect(ok).toBe(false);
		expect((await readRaw())?.sessionId).toBe("OTHER");
	});

	it("returns false when no lock exists", async () => {
		expect(await refreshLoopSchedulerLock("A", deps())).toBe(false);
	});
});

describe("releaseLoopSchedulerLock", () => {
	it("removes only the caller's own lock", async () => {
		await tryAcquireLoopSchedulerLock("A", deps());
		await releaseLoopSchedulerLock("A", deps());
		expect(await readRaw()).toBeUndefined();
	});

	it("does not remove another session's lock", async () => {
		await writeFile(lockFile, JSON.stringify({ sessionId: "OTHER", pid: 9, acquiredAt: 0 }), "utf-8");
		await releaseLoopSchedulerLock("A", deps());
		expect((await readRaw())?.sessionId).toBe("OTHER");
	});
});
