import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LoopSchedulerLock {
	sessionId: string;
	pid: number;
	acquiredAt: number;
}

const LOCK_FILE = join(process.cwd(), ".pi", "loop-tasks.lock");

export async function tryAcquireLoopSchedulerLock(sessionId: string): Promise<boolean> {
	const lock: LoopSchedulerLock = {
		sessionId,
		pid: process.pid,
		acquiredAt: Date.now(),
	};

	if (await tryCreateExclusive(lock)) {
		return true;
	}

	const existing = await readLock();
	if (existing?.sessionId === sessionId) {
		if (existing.pid !== process.pid) {
			await writeFile(LOCK_FILE, JSON.stringify(lock), "utf-8");
		}
		return true;
	}

	if (existing && isProcessRunning(existing.pid)) {
		return false;
	}

	await unlink(LOCK_FILE).catch(() => undefined);
	return tryCreateExclusive(lock);
}

export async function releaseLoopSchedulerLock(sessionId: string): Promise<void> {
	const existing = await readLock();
	if (!existing || existing.sessionId !== sessionId) return;
	await unlink(LOCK_FILE).catch(() => undefined);
}

async function tryCreateExclusive(lock: LoopSchedulerLock): Promise<boolean> {
	const body = JSON.stringify(lock);
	try {
		await writeFile(LOCK_FILE, body, { flag: "wx" });
		return true;
	} catch (error) {
		if (getErrorCode(error) === "EEXIST") return false;
		if (getErrorCode(error) === "ENOENT") {
			await mkdir(dirname(LOCK_FILE), { recursive: true });
			try {
				await writeFile(LOCK_FILE, body, { flag: "wx" });
				return true;
			} catch (retryError) {
				if (getErrorCode(retryError) === "EEXIST") return false;
				throw retryError;
			}
		}
		throw error;
	}
}

async function readLock(): Promise<LoopSchedulerLock | undefined> {
	try {
		const raw = await readFile(LOCK_FILE, "utf-8");
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

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function getErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
