// ── Time units ────────────────────────────────────────────────────────────────

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

// ── Scheduler ─────────────────────────────────────────────────────────────────

/** How often the scheduler checks for due tasks. */
export const CHECK_INTERVAL_MS = 1_000;

/** How often a passive (non-owner) session probes to take over the lock. */
export const LOCK_PROBE_INTERVAL_MS = 5_000;

/** Fallback next-fire delay when cron computation fails. */
export const FALLBACK_FIRE_DELAY_MS = MS_PER_MINUTE;

/** How long a task stays in-flight after firing (guards against double-fire
 *  during the async persist + file-watcher reload cycle). */
export const IN_FLIGHT_GUARD_MS = 2_000;

// ── File watcher ──────────────────────────────────────────────────────────────

/** Debounce before reloading tasks from disk after a file-system event.
 *  Matches openclaude's FILE_STABILITY_MS — gives atomic writes
 *  (writeFile tmp + rename) time to settle before we read the final content. */
export const FILE_RELOAD_DEBOUNCE_MS = 300;

// ── Task limits ───────────────────────────────────────────────────────────────

/** Maximum number of scheduled tasks per project. */
export const MAX_TASKS = 50;

/** Recurring tasks expire after this many days. */
export const RECURRING_EXPIRY_DAYS = 7;

/** One-shot tasks expire after this many days if never fired. */
export const ONE_SHOT_EXPIRY_DAYS = 1;

// ── Jitter ────────────────────────────────────────────────────────────────────

/** Maximum fraction of a period used as forward jitter for recurring tasks. */
export const RECURRING_JITTER_FRAC = 0.1;

/** Absolute cap on recurring forward jitter. */
export const RECURRING_JITTER_CAP_MS = 15 * MS_PER_MINUTE;

// ── Cron off-minute anchor ────────────────────────────────────────────────────

/** Minute offset for hourly tasks (avoids thundering herd on :00). */
export const HOURLY_TASK_MINUTE_OFFSET = 7;
