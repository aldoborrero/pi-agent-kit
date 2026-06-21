import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseLoopInput } from "./interval-parser";
import { MAX_TASKS, RECURRING_EXPIRY_DAYS, type TaskStore } from "./task-store";
import type { LoopScheduler } from "./scheduler";

export function registerLoopCommand(
	pi: ExtensionAPI,
	deps: {
		store: TaskStore;
		scheduler: LoopScheduler;
		updateStatus: () => void;
		onTasksChanged: () => void;
		setContext: (ctx: ExtensionContext) => void;
	},
): void {
	const { store, scheduler, updateStatus, onTasksChanged, setContext } = deps;

	pi.registerCommand("loop", {
		description: "Schedule, list, or delete recurring prompts (e.g., /loop 5m check deploy)",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			const tasks = store.list();
			const subcommands = ["list", "show", "inspect", "delete", "remove", "rm", "stop", "clear", "help"];

			const idCompletionCommands = ["show", "inspect", "delete", "remove", "rm", "stop"];
			const parts = trimmed.split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "";
			const endsWithSpace = /\s$/.test(trimmed);

			if (!trimmed) {
				return subcommands.map((value) => ({ value, label: value }));
			}

			if (parts.length <= 1 && !endsWithSpace) {
				const filtered = subcommands.filter((value) => value.startsWith(sub));
				return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
			}

			if (idCompletionCommands.includes(sub)) {
				const idPrefix = parts.length <= 1
					? ""
					: endsWithSpace
						? ""
						: parts[parts.length - 1] ?? "";
				const filteredTasks = tasks.filter((task) => task.id.startsWith(idPrefix));
				return filteredTasks.length > 0
					? filteredTasks.map((task) => ({
						value: `${sub} ${task.id}`,
						label: `${task.id} — ${task.humanLabel} — ${task.prompt}`,
					}))
					: null;
			}

			return null;
		},
		handler: async (args, ctx) => {
			setContext(ctx);
			const input = args.trim();

			if (!input || input === "help" || input === "?") {
				if (!input && store.size() > 0) {
					showList(ctx, store);
					return;
				}
				ctx.ui.notify(
					"Loop usage:\n\n" +
						"  /loop 5m check deploy    schedule a task\n" +
						"  /loop list               show all tasks\n" +
						"  /loop show <id>          inspect a task\n" +
						"  /loop delete <id>        cancel a task\n" +
						"  /loop remove <id>        cancel a task\n" +
						"  /loop clear              delete all tasks\n" +
						"  /loop help               show this help",
					"info",
				);
				return;
			}

			if (input === "list" || input === "ls") {
				showList(ctx, store);
				return;
			}

			const showMatch = input.match(/^(?:show|inspect)\s+(\S+)\s*$/);
			if (showMatch) {
				showTask(ctx, store, showMatch[1]);
				return;
			}

			const deleteMatch = input.match(/^(?:delete|remove|rm|stop)\s+(\S+)\s*$/);
			if (deleteMatch) {
				const id = deleteMatch[1];
				if (scheduler.deleteTask(id)) {
					ctx.ui.notify(`Task ${id} deleted`, "info");
				} else {
					ctx.ui.notify(`Task ${id} not found. Use /loop list`, "error");
				}
				return;
			}

			if (input === "clear" || input === "clear all") {
				if (store.size() > 0 && ctx.hasUI) {
					const confirmed = await ctx.ui.confirm(
						"Delete all loop tasks?",
						`Delete ${store.size()} scheduled loop task(s)?`,
					);
					if (!confirmed) {
						ctx.ui.notify("Clear cancelled", "info");
						return;
					}
				}
				const count = scheduler.clearAll();
				updateStatus();
				ctx.ui.notify(`Deleted ${count} task(s)`, "info");
				return;
			}

			if (store.size() >= MAX_TASKS) {
				ctx.ui.notify(`Maximum ${MAX_TASKS} tasks. Use /loop delete <id> or /loop clear`, "error");
				return;
			}

			const parsed = parseLoopInput(input);
			if (!parsed || !parsed.prompt) {
				ctx.ui.notify("Could not parse. Usage: /loop [interval] <prompt>", "error");
				return;
			}

			const task = store.createFromParsed(parsed, true);
			store.add(task);
			scheduler.start();
			updateStatus();
			onTasksChanged();

			const nextRun = task.cron.nextRun();
			let msg = `Scheduled ${task.id} (${parsed.humanLabel})\n` +
				`Next: ${nextRun ? nextRun.toLocaleTimeString() : "—"}\n` +
				`Expires in ${RECURRING_EXPIRY_DAYS} days. /loop delete ${task.id} to cancel.`;

			if (parsed.rounded) {
				msg = `${parsed.rounded}\n\n${msg}`;
			}

			ctx.ui.notify(msg, "info");
			scheduler.sendInitialRun(task);
		},
	});
}

function showList(ctx: ExtensionContext, store: TaskStore): void {
	const tasks = store.list();
	if (tasks.length === 0) {
		ctx.ui.notify("No scheduled tasks", "info");
		return;
	}

	const lines = tasks.map((task) => {
		const next = task.cron.nextRun();
		const nextStr = next ? next.toLocaleTimeString() : "—";
		return `${task.id}  ${task.humanLabel.padEnd(6)}  fired ${String(task.fireCount).padStart(3)}x  next ${nextStr}\n  ${task.prompt}`;
	});

	ctx.ui.notify(`Scheduled tasks (${tasks.length}):\n\n${lines.join("\n\n")}`, "info");
}

function showTask(ctx: ExtensionContext, store: TaskStore, id: string): void {
	const task = store.get(id);
	if (!task) {
		ctx.ui.notify(`Task ${id} not found. Use /loop list`, "error");
		return;
	}

	const next = task.cron.nextRun();
	const lines = [
		`Task ${task.id}`,
		"",
		`Prompt: ${task.prompt}`,
		`Schedule: ${task.humanLabel}`,
		`Cron: ${task.cronExpr}`,
		`Recurring: ${task.recurring ? "yes" : "no"}`,
		`Fired: ${task.fireCount} time(s)`,
		`Created: ${new Date(task.createdAt).toLocaleString()}`,
		`Last fired: ${task.lastFiredAt ? new Date(task.lastFiredAt).toLocaleString() : "never"}`,
		`Expires: ${new Date(task.expiresAt).toLocaleString()}`,
		`Next: ${next ? next.toLocaleString() : "—"}`,
	];

	ctx.ui.notify(lines.join("\n"), "info");
}
