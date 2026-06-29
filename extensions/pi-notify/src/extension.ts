/**
 * Pi Notify Extension
 *
 * Sends native terminal notifications when Pi is waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 *
 * Each agent-completion notification includes:
 * - Title: "Pi · <project-name>" so you know which project finished
 * - Body: first sentence of the last assistant message, or a stats summary
 *         (elapsed time · turn count · files changed)
 *
 * Configuration:
 * - CLI flag --no-notify  disables notifications at startup
 * - /notify               toggles notifications on/off during a session
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { once } from "./once.ts";

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

const TITLE_MAX_CHARS = 80;
const BODY_MAX_CHARS = 240;
const NOTIFICATION_COOLDOWN_MS = 2_000;
const QUESTION_DEDUP_MS = 2_000;

const lastNotificationAt = new Map<string, number>();

/** Strip characters that can break OSC escape sequences and trim noisy output. */
function sanitize(s: string, maxChars = BODY_MAX_CHARS): string {
	const cleaned = s
		.replace(/[\x00-\x1f\x7f;]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(0, maxChars - 1))}…` : cleaned;
}

function escapePowerShellSingleQuoted(s: string): string {
	return s.replace(/'/g, "''");
}

function windowsToastScript(title: string, body: string): string {
	const escapedTitle = escapePowerShellSingleQuoted(title);
	const escapedBody = escapePowerShellSingleQuoted(body);
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText02`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escapedTitle}')) > $null`,
		`$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('${escapedBody}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${escapedTitle}').Show(${toast})`,
	].join("; ");
}

function tmuxPassthrough(sequence: string): string {
	return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function sourcePaneTty(): string | undefined {
	try {
		if (!process.env.TMUX_PANE) return undefined;
		const tty = execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{pane_tty}"], { encoding: "utf8" }).trim();
		return tty || undefined;
	} catch {
		return undefined;
	}
}

function sourceTmuxSession(): string | undefined {
	try {
		if (!process.env.TMUX_PANE) return undefined;
		const session = execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{session_name}"], { encoding: "utf8" }).trim();
		return session || undefined;
	} catch {
		return undefined;
	}
}

function tmuxClientTtys(): string[] {
	try {
		if (!process.env.TMUX) return [];
		const session = sourceTmuxSession();
		const args = ["list-clients"];
		if (session) args.push("-t", session);
		args.push("-F", "#{client_tty}");
		const output = execFileSync("tmux", args, { encoding: "utf8" });
		return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
	} catch {
		return [];
	}
}

function writeRawToPaths(paths: string[], output: string): boolean {
	let wrote = false;
	for (const ttyPath of paths) {
		try {
			writeFileSync(ttyPath, output, "utf8");
			wrote = true;
		} catch {
			// Best effort: try remaining paths.
		}
	}
	return wrote;
}

function writeToTerminal(output: string): void {
	const tty = sourcePaneTty();
	try {
		writeFileSync(tty ?? "/dev/tty", output, "utf8");
		return;
	} catch {
		// Fall through to stdout best-effort.
	}

	try {
		if (process.stdout.isTTY) process.stdout.write(output);
	} catch {
		// Notifications are best-effort only.
	}
}

function writeTerminalSequence(sequence: string): void {
	if (process.env.TMUX && writeRawToPaths(tmuxClientTtys(), sequence)) return;
	const output = process.env.TMUX ? tmuxPassthrough(sequence) : sequence;
	writeToTerminal(output);
}

function notifyOSC777(title: string, body: string): void {
	writeTerminalSequence(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part.
	writeTerminalSequence(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	writeTerminalSequence(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], () => undefined);
}

function notify(title: string, body: string, key = "default", cooldownMs = NOTIFICATION_COOLDOWN_MS): void {
	const now = Date.now();
	const last = lastNotificationAt.get(key) ?? 0;
	if (cooldownMs > 0 && now - last < cooldownMs) return;
	lastNotificationAt.set(key, now);

	const safeTitle = sanitize(title, TITLE_MAX_CHARS) || "Pi";
	const safeBody = sanitize(body, BODY_MAX_CHARS) || "Ready for input";

	if (process.env.WT_SESSION) {
		notifyWindows(safeTitle, safeBody);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(safeTitle, safeBody);
	} else {
		notifyOSC777(safeTitle, safeBody);
	}
}

function questionTitle(input: unknown): string {
	if (!input || typeof input !== "object") return "Question";
	const request = input as { header?: unknown; question?: unknown };
	if (typeof request.header === "string" && request.header.trim()) return request.header.trim();
	if (typeof request.question === "string" && request.question.trim()) return request.question.trim();
	return "Question";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	once(pi, "pi-notify", () => {
		let enabled = true;
		let agentStartTime: number | null = null;
		let turnCount = 0;
		let filesChanged = 0;

		// CLI flag: --no-notify disables notifications at startup.
		pi.registerFlag("notify", {
			description: "Enable desktop notifications when the agent waits for input (default: on)",
			type: "boolean",
			default: true,
		});

		function updateStatus(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;
			// Only show when off — on is the expected state.
			const colors = createUiColors(ctx.ui.theme);
			ctx.ui.setStatus("notify", enabled ? undefined : colors.warning("󰂚 off"));
		}

		pi.on("session_start", async (_event, ctx) => {
			enabled = pi.getFlag("notify") !== false;
			updateStatus(ctx);
		});

		// /notify — toggle on/off during a session.
		pi.registerCommand("notify", {
			description: "Toggle desktop notifications on/off",
			handler: async (_args, ctx) => {
				enabled = !enabled;
				updateStatus(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(
						enabled ? "Desktop notifications enabled" : "Desktop notifications disabled",
						"info",
					);
				}
			},
		});

		pi.on("agent_start", async () => {
			agentStartTime = Date.now();
			turnCount = 0;
			filesChanged = 0;
		});

		pi.on("turn_start", async (event) => {
			// turnIndex is 0-based, so we store the count as index + 1.
			turnCount = event.turnIndex + 1;
		});

		pi.on("tool_call", async (event: any, ctx) => {
			if (!enabled || event?.toolName !== "question") return undefined;
			const projectName = path.basename(ctx.cwd) || ctx.cwd;
			const title = questionTitle(event.input);
			const key = `question:${event.input?.id ?? event.toolCallId ?? title}`;
			notify(`Pi · ${projectName}`, `Input required: ${title}`, key, QUESTION_DEDUP_MS);
			return undefined;
		});

		pi.on("tool_result", async (event) => {
			const name = (event as any).toolName as string;
			if ((name === "edit" || name === "write") && !event.isError) {
				filesChanged++;
			}
		});

		pi.on("agent_end", async (event, ctx) => {
			if (!enabled) return;

			const projectName = path.basename(ctx.cwd) || ctx.cwd;
			const elapsedSec = agentStartTime !== null ? Math.round((Date.now() - agentStartTime) / 1000) : null;

			// Build a short snippet from the last assistant message that has text content.
			let snippet = "";
			const reversed = [...event.messages].reverse();
			for (const msg of reversed) {
				const m = msg as any;
				if (m.role !== "assistant") continue;
				const text = ((m.content ?? []) as any[])
					.filter((c) => c.type === "text")
					.map((c) => (c.text ?? "") as string)
					.join(" ")
					.trim();
				if (text) {
					// Take the first sentence (up to 80 chars).
					snippet = text.split(/[.!?\n]/)[0].trim().slice(0, 80);
					break;
				}
			}

			// Build the stats summary.
			const stats: string[] = [];
			if (elapsedSec !== null) stats.push(`${elapsedSec}s`);
			if (turnCount > 0) stats.push(`${turnCount} turn${turnCount !== 1 ? "s" : ""}`);
			if (filesChanged > 0) stats.push(`${filesChanged} file${filesChanged !== 1 ? "s" : ""}`);
			const statsSummary = stats.join(" · ");

			const title = `Pi · ${projectName}`;
			let body: string;
			if (snippet) {
				body = statsSummary ? `${snippet} (${statsSummary})` : snippet;
			} else {
				body = statsSummary || "Ready for input";
			}

			notify(title, body, "agent-end");
		});
	});
}
