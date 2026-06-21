/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 *
 * Each notification includes:
 * - Title: "Pi · <project-name>" so you know which project finished
 * - Body: first sentence of the last assistant message, or a stats summary
 *         (elapsed time · turn count · files changed)
 *
 * Configuration:
 * - CLI flag --no-notify  disables notifications at startup
 * - /notify               toggles notifications on/off during a session
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { createUiColors } from "@aldoborrero/pi-common";

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

/** Strip characters that can break OSC escape sequences. */
function sanitize(s: string): string {
	return s.replace(/[\x00-\x1f\x7f;]/g, " ").trim();
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${sanitize(title)};${sanitize(body)}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${sanitize(title)}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${sanitize(body)}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("child_process");
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(sanitize(title), sanitize(body))]);
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let agentStartTime: number | null = null;
	let turnCount = 0;
	let filesChanged = 0;

	// CLI flag: --no-notify disables notifications at startup.
	pi.registerFlag("notify", {
		description: "Enable desktop notifications when the agent finishes (default: on)",
		type: "boolean",
		default: true,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// Only show when off — on is the expected state
		const colors = createUiColors(ctx.ui.theme);
		ctx.ui.setStatus(
			"notify",
			enabled
				? undefined
				: colors.warning("notify:off"),
		);
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
		// turnIndex is 0-based, so we store the count as index + 1
		turnCount = event.turnIndex + 1;
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

		notify(title, body);
	});
}
