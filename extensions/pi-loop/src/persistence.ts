import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoredCronTask } from "./types";

interface PersistedLoopTasksFile {
	tasks: StoredCronTask[];
}

const LOOP_TASKS_FILE = join(process.cwd(), ".pi", "loop-tasks.json");

export function getLoopTasksFilePath(): string {
	return LOOP_TASKS_FILE;
}

export async function loadStoredTasks(): Promise<StoredCronTask[]> {
	try {
		const raw = await readFile(LOOP_TASKS_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<PersistedLoopTasksFile>;
		if (!Array.isArray(parsed.tasks)) return [];
		return parsed.tasks.filter(isStoredCronTask);
	} catch (error) {
		if (isMissingFileError(error)) return [];
		return [];
	}
}

export async function saveStoredTasks(tasks: StoredCronTask[]): Promise<void> {
	await mkdir(dirname(LOOP_TASKS_FILE), { recursive: true });
	const body: PersistedLoopTasksFile = { tasks };
	const tempFile = `${LOOP_TASKS_FILE}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tempFile, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
	await rename(tempFile, LOOP_TASKS_FILE);
}

function isMissingFileError(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isStoredCronTask(value: unknown): value is StoredCronTask {
	if (!value || typeof value !== "object") return false;
	const task = value as Record<string, unknown>;
	return (
		typeof task.id === "string" &&
		typeof task.prompt === "string" &&
		typeof task.cronExpr === "string" &&
		typeof task.recurring === "boolean" &&
		typeof task.humanLabel === "string" &&
		typeof task.createdAt === "number" &&
		typeof task.expiresAt === "number" &&
		(task.lastFiredAt === undefined || typeof task.lastFiredAt === "number")
	);
}
