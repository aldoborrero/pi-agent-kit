import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CHECK_INTERVAL_MS,
	FALLBACK_FIRE_DELAY_MS,
	IN_FLIGHT_GUARD_MS,
	LOCK_HEARTBEAT_INTERVAL_MS,
	LOCK_PROBE_INTERVAL_MS,
} from "./constants";
import {
	type LoopLockDeps,
	refreshLoopSchedulerLock,
	releaseLoopSchedulerLock,
	tryAcquireLoopSchedulerLock,
} from "./loop-lock";
import type { RuntimeCronTask } from "./types";
import { computeTaskNextFireAt, type TaskStore } from "./task-store";

export interface LoopSchedulerCallbacks {
	onStatusChange?: () => void;
	onTaskExpired?: (task: RuntimeCronTask) => void;
	onOwnershipAcquired?: () => Promise<void> | void;
}

export class LoopScheduler {
	private checkTimer: ReturnType<typeof setInterval> | null = null;
	private lockProbeTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private agentBusy = false;
	private latestCtx: ExtensionContext | null = null;
	private isOwner = false;
	private readonly sessionId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

	// Fix 1: inFlight guard — prevents double-fire while the async
	// persistTasks() write + file-watcher reload cycle is in progress.
	private readonly inFlight = new Set<string>();

	// Fix 2: nextFireAt separated from the task store.
	// store.replaceAll() recreates task objects from disk (potentially stale),
	// but this Map survives intact, so first-sight anchoring from disk is
	// never clobbered by a file-watcher-triggered reload.
	private readonly nextFireAt = new Map<string, number>();

	// Test seam: overrides forwarded to every lock call (temp lock file,
	// controllable clock / process-liveness). Empty in production.
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly store: TaskStore,
		private readonly callbacks: LoopSchedulerCallbacks = {},
		private readonly lockOptions: Partial<LoopLockDeps> = {},
	) {}

	setContext(ctx: ExtensionContext): void {
		this.latestCtx = ctx;
	}

	setAgentBusy(busy: boolean): void {
		this.agentBusy = busy;
	}

	async start(): Promise<void> {
		if (this.isOwner) return;

		// Already probing (passive). A new task may have been added, so try to
		// acquire immediately instead of waiting for the next probe tick. If the
		// lock is held by a live owner this fails and we keep probing.
		if (this.lockProbeTimer) {
			const owned = await tryAcquireLoopSchedulerLock(this.sessionId, this.lockOptions).catch(() => false);
			if (owned) {
				clearInterval(this.lockProbeTimer);
				this.lockProbeTimer = null;
				this.isOwner = true;
				this.becomeOwner();
				await this.callbacks.onOwnershipAcquired?.();
			}
			return;
		}

		if (this.checkTimer) return;

		this.isOwner = await tryAcquireLoopSchedulerLock(this.sessionId, this.lockOptions).catch(() => false);
		if (this.isOwner) {
			this.becomeOwner();
			await this.callbacks.onOwnershipAcquired?.();
			return;
		}

		this.startLockProbe();
	}

	/**
	 * Full session shutdown: stop scheduling, stop probing, release ownership.
	 * Only call this when the session itself is going away — NOT when the task
	 * list merely becomes empty (a passive session must keep probing).
	 */
	async stop(): Promise<void> {
		this.stopCheckTimer();
		this.stopHeartbeat();
		if (this.lockProbeTimer) {
			clearInterval(this.lockProbeTimer);
			this.lockProbeTimer = null;
		}
		const wasOwner = this.isOwner;
		this.isOwner = false;
		if (wasOwner) {
			await releaseLoopSchedulerLock(this.sessionId, this.lockOptions).catch(() => undefined);
		}
	}

	/**
	 * Called when this session's task list becomes empty. An owner releases the
	 * lock and reverts to passive probing so another session can take over; a
	 * passive session keeps probing untouched. In both cases due-checks stop
	 * (there is nothing to fire) but the takeover probe stays alive.
	 */
	private async onTasksEmptied(): Promise<void> {
		this.stopCheckTimer();
		if (this.isOwner) {
			this.stopHeartbeat();
			this.isOwner = false;
			await releaseLoopSchedulerLock(this.sessionId, this.lockOptions).catch(() => undefined);
			this.startLockProbe();
		} else if (!this.lockProbeTimer) {
			// Defensive: ensure a passive session is always probing.
			this.startLockProbe();
		}
	}

	private startLockProbe(): void {
		if (this.lockProbeTimer || this.isOwner) return;
		this.lockProbeTimer = setInterval(() => {
			void tryAcquireLoopSchedulerLock(this.sessionId, this.lockOptions)
				.then(async (owned) => {
					if (!owned || this.isOwner) return;
					this.isOwner = true;
					if (this.lockProbeTimer) {
						clearInterval(this.lockProbeTimer);
						this.lockProbeTimer = null;
					}
					this.becomeOwner();
					await this.callbacks.onOwnershipAcquired?.();
				})
				.catch(() => undefined);
		}, LOCK_PROBE_INTERVAL_MS);
	}

	private becomeOwner(): void {
		this.startCheckTimer();
		this.startHeartbeat();
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => {
			void this.sendHeartbeat();
		}, LOCK_HEARTBEAT_INTERVAL_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private async sendHeartbeat(): Promise<void> {
		if (!this.isOwner) return;
		const stillOwner = await refreshLoopSchedulerLock(this.sessionId, this.lockOptions).catch(() => true);
		if (!stillOwner) {
			// Lost the lock (reclaimed by another session). Revert to passive.
			this.stopCheckTimer();
			this.stopHeartbeat();
			this.isOwner = false;
			this.startLockProbe();
		}
	}

	private stopCheckTimer(): void {
		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = null;
		}
	}

	isSchedulerOwner(): boolean {
		return this.isOwner;
	}

	/** Test-only inspectors for the timer state machine. */
	hasProbeTimer(): boolean {
		return this.lockProbeTimer !== null;
	}
	hasCheckTimer(): boolean {
		return this.checkTimer !== null;
	}
	hasHeartbeatTimer(): boolean {
		return this.heartbeatTimer !== null;
	}
	/** Test-only: run one heartbeat cycle without waiting for the interval. */
	async heartbeatOnce(): Promise<void> {
		await this.sendHeartbeat();
	}

	clearAll(): number {
		this.nextFireAt.clear();
		this.inFlight.clear();
		const count = this.store.clear();
		// Task list is now empty: stop due-checks and (if owner) hand off the
		// lock, but keep probing so this session can take over again later.
		void this.onTasksEmptied();
		this.callbacks.onStatusChange?.();
		return count;
	}

	deleteTask(id: string): boolean {
		const deleted = this.store.delete(id);
		if (deleted) {
			this.nextFireAt.delete(id);
			this.inFlight.delete(id);
		}
		if (deleted && this.store.size() === 0) {
			void this.onTasksEmptied();
		}
		if (deleted) {
			this.callbacks.onStatusChange?.();
		}
		return deleted;
	}

	fireDueTasks(): void {
		if (!this.isOwner || this.agentBusy || !this.latestCtx) return;

		const now = Date.now();
		for (const task of this.store.list()) {
			// Fix 1: skip tasks already being persisted/cleaned up
			if (this.inFlight.has(task.id)) continue;

			// Fix 2: use in-memory nextFireAt if available, fall back to task object
			const nextFire = this.nextFireAt.get(task.id) ?? task.nextFireAt;
			if (now < nextFire) continue;

			task.fireCount++;
			task.lastFiredAt = now;
			const isExpired = now >= task.expiresAt;

			this.sendScheduledMessage(task);

			if (!task.recurring || isExpired) {
				this.nextFireAt.delete(task.id);
				this.inFlight.add(task.id);
				this.store.delete(task.id);
				if (isExpired) {
					this.callbacks.onTaskExpired?.(task);
				}
			} else {
				// Update in-memory nextFireAt first — survives any store.replaceAll()
				const newNext = computeTaskNextFireAt(task, now, task.jitterMs, task.cron) ?? now + FALLBACK_FIRE_DELAY_MS;
				task.nextFireAt = newNext;
				this.nextFireAt.set(task.id, newNext);
				// Guard against double-fire during async write + file-watcher reload
				this.inFlight.add(task.id);
				setTimeout(() => this.inFlight.delete(task.id), IN_FLIGHT_GUARD_MS);
			}

			if (this.store.size() === 0) {
				void this.onTasksEmptied();
			}
			this.callbacks.onStatusChange?.();
			return;
		}
	}

	sendInitialRun(task: RuntimeCronTask): void {
		this.sendScheduledMessage(task, true);
	}

	private startCheckTimer(): void {
		if (this.checkTimer) return;
		this.checkTimer = setInterval(() => this.fireDueTasks(), CHECK_INTERVAL_MS);
	}

	private sendScheduledMessage(task: RuntimeCronTask, initial = false): void {
		this.pi.sendMessage(
			{
				customType: "loop",
				content: initial
					? `[Scheduled task ${task.id} — ${task.humanLabel} — initial run]\n\n${task.prompt}`
					: `[Scheduled task ${task.id} — ${task.humanLabel}]\n\n${task.prompt}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}
}
