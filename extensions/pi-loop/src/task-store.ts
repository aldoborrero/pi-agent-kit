import { Cron } from "croner";
import { estimatePeriodMs } from "./interval-parser";
import {
	FALLBACK_FIRE_DELAY_MS,
	MAX_TASKS,
	MS_PER_DAY,
	ONE_SHOT_EXPIRY_DAYS,
	RECURRING_EXPIRY_DAYS,
	RECURRING_JITTER_CAP_MS,
	RECURRING_JITTER_FRAC,
} from "./constants";
import type { ParsedInterval, RuntimeCronTask, StoredCronTask } from "./types";

export { MAX_TASKS, RECURRING_EXPIRY_DAYS };

export interface TaskStore {
	list(): RuntimeCronTask[];
	get(id: string): RuntimeCronTask | undefined;
	size(): number;
	add(task: RuntimeCronTask): void;
	delete(id: string): boolean;
	clear(): number;
	createFromParsed(parsed: ParsedInterval, recurring: boolean): RuntimeCronTask;
	replaceAll(tasks: StoredCronTask[], immediateIds?: Set<string>): void;
	toStoredTasks(): StoredCronTask[];
}

export class InMemoryTaskStore implements TaskStore {
	private readonly tasks = new Map<string, RuntimeCronTask>();

	list(): RuntimeCronTask[] {
		return Array.from(this.tasks.values());
	}

	get(id: string): RuntimeCronTask | undefined {
		return this.tasks.get(id);
	}

	size(): number {
		return this.tasks.size;
	}

	add(task: RuntimeCronTask): void {
		this.tasks.set(task.id, task);
	}

	delete(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task) return false;
		task.cron.stop();
		return this.tasks.delete(id);
	}

	clear(): number {
		for (const task of this.tasks.values()) {
			task.cron.stop();
		}
		const count = this.tasks.size;
		this.tasks.clear();
		return count;
	}

	createFromParsed(parsed: ParsedInterval, recurring: boolean): RuntimeCronTask {
		return buildRuntimeTask(parsed, recurring);
	}

	replaceAll(tasks: StoredCronTask[], immediateIds: Set<string> = new Set()): void {
		this.clear();
		for (const task of tasks) {
			if (task.expiresAt <= Date.now()) continue;
			const runtimeTask = hydrateRuntimeTask(task, {
				forceImmediate: immediateIds.has(task.id),
			});
			this.tasks.set(runtimeTask.id, runtimeTask);
		}
	}

	toStoredTasks(): StoredCronTask[] {
		return this.list().map((task) => ({
			id: task.id,
			prompt: task.prompt,
			cronExpr: task.cronExpr,
			recurring: task.recurring,
			humanLabel: task.humanLabel,
			createdAt: task.createdAt,
			expiresAt: task.expiresAt,
			...(task.lastFiredAt !== undefined ? { lastFiredAt: task.lastFiredAt } : {}),
		}));
	}
}

export function buildRuntimeTask(parsed: ParsedInterval, recurring: boolean): RuntimeCronTask {
	const id = generateId();
	const now = Date.now();
	const expiresAt = recurring
		? now + RECURRING_EXPIRY_DAYS * MS_PER_DAY
		: now + ONE_SHOT_EXPIRY_DAYS * MS_PER_DAY;

	return hydrateRuntimeTask({
		id,
		prompt: parsed.prompt,
		cronExpr: parsed.cronExpr,
		recurring,
		humanLabel: parsed.humanLabel,
		createdAt: now,
		expiresAt,
	});
}

export function hydrateRuntimeTask(
	task: StoredCronTask,
	options: { forceImmediate?: boolean } = {},
): RuntimeCronTask {
	const cron = new Cron(task.cronExpr, {
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
	const periodMs = estimatePeriodMs(task.cronExpr);
	const jitterMs = computeJitterMs(task.id, periodMs, task.recurring);
	const nextFireAt = options.forceImmediate
		? Date.now()
		: computeTaskNextFireAt(task, task.lastFiredAt ?? task.createdAt, jitterMs, cron) ?? Date.now() + FALLBACK_FIRE_DELAY_MS;

	return {
		...task,
		cron,
		nextFireAt,
		jitterMs,
		fireCount: 0,
	};
}

export function findMissedTasks(tasks: StoredCronTask[], now = Date.now()): StoredCronTask[] {
	return tasks.filter((task) => {
		if (task.expiresAt <= now) return false;
		const nextFireAt = computeTaskNextFireAt(task, task.lastFiredAt ?? task.createdAt);
		return nextFireAt !== null && nextFireAt <= now;
	});
}

export function computeTaskNextFireAt(
	task: Pick<StoredCronTask, "id" | "cronExpr" | "recurring">,
	fromMs: number,
	precomputedJitterMs?: number,
	precomputedCron?: Cron,
): number | null {
	const cron = precomputedCron ?? new Cron(task.cronExpr, {
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
	const periodMs = estimatePeriodMs(task.cronExpr);
	const jitterMs = precomputedJitterMs ?? computeJitterMs(task.id, periodMs, task.recurring);
	const nextRun = cron.nextRun(new Date(fromMs));
	return nextRun ? nextRun.getTime() + jitterMs : null;
}

function generateId(): string {
	return Math.random().toString(36).slice(2, 10);
}

function computeJitterMs(id: string, periodMs: number, recurring: boolean): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
	}
	const seed = Math.abs(hash) / 2147483647;

	if (recurring) {
		const maxJitter = Math.min(periodMs * RECURRING_JITTER_FRAC, RECURRING_JITTER_CAP_MS);
		return Math.floor(seed * maxJitter);
	}
	return -Math.floor(seed * 90_000);
}
