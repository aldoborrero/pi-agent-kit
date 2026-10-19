import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LOCK_STALE_MS } from "./constants";

interface LoopSchedulerLock {
	sessionId: string;
	pid: number;
	acquiredAt: number;
}

const DEFAULT_LOCK_FILE = join(process.cwd(), ".pi", "loop-tasks.lock");

/**
 * Injectable dependencies for the lock protocol. Production code uses the
 * defaults; tests override them to control the filesystem, clock, process
 * liveness check, and staleness threshold deterministically.
 */
export interface LoopLockDeps {
	lockFile: string;
	pid: number;
	now: () => number;
	staleMs: number;
	/**
	 * Probes whether `pid` is alive.
	 * - `true`  → definitely running (do not steal on liveness alone)
	 * - `false` → definitely not running (safe to steal)
	 * - `"unknown"` → cannot determine (e.g. EPERM); fall back to staleness
	 */
	isProcessRunning: (pid: number) => boolean | "unknown";
}

function defaultDeps(): LoopLockDeps {
	return {
		lockFile: DEFAULT_LOCK_FILE,
		pid: process.pid,
		now: Date.now,
		staleMs: LOCK_STALE_MS,
		isProcessRunning: defaultIsProcessRunning,
	};
}

export async function tryAcquireLoopSchedulerLock(
	sessionId: string,
	overrides: Partial<LoopLockDeps> = {},
): Promise<boolean> {
	const deps = { ...defaultDeps(), ...overrides };
	const lock: LoopSchedulerLock = {
		sessionId,
		pid: deps.pid,
		acquiredAt: deps.now(),
	};

	if (await tryCreateExclusive(lock, deps)) {
		return true;
	}

	const existing = await readLock(deps);
	if (existing?.sessionId === sessionId) {
		// We already own it. Refresh pid/acquiredAt so the heartbeat stays fresh.
		await writeFile(deps.lockFile, JSON.stringify(lock), "utf-8");
		return true;
	}

	if (existing && !isReclaimable(existing, deps)) {
		return false;
	}

	// The lock looks reclaimable (dead pid or stale timestamp). Reclaim it
	// atomically (see claimStaleLock). If we didn't perform the reclaim — another
	// racer beat us, or the on-disk lock turned out not to be the stale copy — we
	// fall through to a plain exclusive create, which succeeds only if the slot is
	// now free. The `wx` create is the final exclusivity guard.
	if (existing) {
		await claimStaleLock(existing, sessionId, deps);
	}

	return tryCreateExclusive(lock, deps);
}

/**
 * Owner-side heartbeat. Re-writes `acquiredAt` (and pid) only if we still own
 * the lock on disk, so passive sessions can distinguish a live owner from a
 * crashed one via the staleness timestamp. Returns true if the heartbeat was
 * written (we still own it), false if ownership was lost.
 */
export async function refreshLoopSchedulerLock(
	sessionId: string,
	overrides: Partial<LoopLockDeps> = {},
): Promise<boolean> {
	const deps = { ...defaultDeps(), ...overrides };
	const existing = await readLock(deps);
	if (!existing || existing.sessionId !== sessionId) return false;
	const lock: LoopSchedulerLock = {
		sessionId,
		pid: deps.pid,
		acquiredAt: deps.now(),
	};
	await writeFile(deps.lockFile, JSON.stringify(lock), "utf-8");
	return true;
}

export async function releaseLoopSchedulerLock(
	sessionId: string,
	overrides: Partial<LoopLockDeps> = {},
): Promise<void> {
	const deps = { ...defaultDeps(), ...overrides };
	const existing = await readLock(deps);
	if (!existing || existing.sessionId !== sessionId) return;
	await unlink(deps.lockFile).catch(() => undefined);
}

/**
 * A lock is reclaimable if either its owning process is definitely gone, or its
 * heartbeat is older than the staleness threshold. When liveness cannot be
 * determined (EPERM → "unknown"), we fall back to the timestamp alone.
 */
function isReclaimable(existing: LoopSchedulerLock, deps: LoopLockDeps): boolean {
	if (deps.now() - existing.acquiredAt > deps.staleMs) return true;
	const running = deps.isProcessRunning(existing.pid);
	if (running === false) return true;
	// running === true or "unknown": not stale enough, keep out.
	return false;
}

/**
 * Atomically reclaim a stale lock by renaming the on-disk file aside to a
 * session-private sidecar. `rename` moves an inode atomically, so among
 * concurrent racers exactly one can move the stale file away; the others get
 * ENOENT and fall through to a plain exclusive create. Crucially, nothing here
 * ever unlinks the live lock path — only the private sidecar — which closes the
 * compare-then-unlink TOCTOU window where a racer could delete a fresh lock that
 * a winner had just created (a double-own).
 *
 * If the file we moved turns out NOT to be the stale copy we intended to reclaim
 * (a fresh lock appeared in the read window), we restore it untouched.
 *
 * Returns true if we reclaimed the stale lock, false otherwise. Either way the
 * caller then attempts an exclusive create as the final guard.
 */
async function claimStaleLock(
	existing: LoopSchedulerLock,
	sessionId: string,
	deps: LoopLockDeps,
): Promise<boolean> {
	const sidecar = `${deps.lockFile}.${deps.pid}.${sessionId.replace(/[^\w.-]/g, "_")}.steal`;
	try {
		await rename(deps.lockFile, sidecar);
	} catch (error) {
		// ENOENT: another racer already moved/removed the lock. We didn't reclaim it.
		if (getErrorCode(error) === "ENOENT") return false;
		throw error;
	}
	// We now hold the moved file exclusively at `sidecar`. Confirm it was the stale
	// copy we read; if a fresh lock had replaced it in the window, put it back.
	let moved: string;
	try {
		moved = await readFile(sidecar, "utf-8");
	} catch {
		moved = "";
	}
	if (moved !== JSON.stringify(existing)) {
		await rename(sidecar, deps.lockFile).catch(() => undefined);
		return false;
	}
	await unlink(sidecar).catch(() => undefined);
	return true;
}

async function tryCreateExclusive(lock: LoopSchedulerLock, deps: LoopLockDeps): Promise<boolean> {
	const body = JSON.stringify(lock);
	try {
		await writeFile(deps.lockFile, body, { flag: "wx" });
		return true;
	} catch (error) {
		if (getErrorCode(error) === "EEXIST") return false;
		if (getErrorCode(error) === "ENOENT") {
			await mkdir(dirname(deps.lockFile), { recursive: true });
			try {
				await writeFile(deps.lockFile, body, { flag: "wx" });
				return true;
			} catch (retryError) {
				if (getErrorCode(retryError) === "EEXIST") return false;
				throw retryError;
			}
		}
		throw error;
	}
}

async function readLock(deps: LoopLockDeps): Promise<LoopSchedulerLock | undefined> {
	try {
		const raw = await readFile(deps.lockFile, "utf-8");
		const parsed = JSON.parse(raw) as Partial<LoopSchedulerLock>;
		if (
			typeof parsed.sessionId === "string" &&
			typeof parsed.pid === "number" &&
			typeof parsed.acquiredAt === "number"
		) {
			return parsed as LoopSchedulerLock;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function defaultIsProcessRunning(pid: number): boolean | "unknown" {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user/container, so we
		// cannot signal it. We cannot conclude it is our dead scheduler — defer to
		// the staleness timestamp instead of assuming it is alive.
		if (getErrorCode(error) === "EPERM") return "unknown";
		return false;
	}
}

function getErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
