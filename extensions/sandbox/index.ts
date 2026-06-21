/// <reference path="./node-shim.d.ts" />

/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/settings.json under key "sandbox" (global)
 * - <cwd>/.pi/settings.json under key "sandbox" (project-local)
 * - legacy fallback: ~/.pi/agent/sandbox.json and <cwd>/.pi/sandbox.json
 *
 * Example .pi/settings.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: false,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function normalizeConfig(raw: unknown): Partial<SandboxConfig> {
	if (!raw || typeof raw !== "object") return {};
	return raw as Partial<SandboxConfig>;
}

function readLegacyConfig(path: string): Partial<SandboxConfig> {
	if (!existsSync(path)) return {};
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (e) {
		console.error(`Warning: Could not parse ${path}: ${e}`);
		return {};
	}
}

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	try {
		const manager = SettingsManager.create(cwd);
		const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
		const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
		globalConfig = normalizeConfig(globalSettings.sandbox);
		projectConfig = normalizeConfig(projectSettings.sandbox);
	} catch {
		// fall through to legacy files only
	}

	if (Object.keys(globalConfig).length === 0) {
		globalConfig = readLegacyConfig(globalConfigPath);
	}
	if (Object.keys(projectConfig).length === 0) {
		projectConfig = readLegacyConfig(projectConfigPath);
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", (chunk) => onData(chunk));
				child.stderr?.on("data", (chunk) => onData(chunk));

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	let projectCwd = process.cwd();
	let cachedBash = createBashTool(projectCwd);
	let sandboxEnabled = false;
	let sandboxInitialized = false;
	let sandboxFooterState: "on" | "restricted" | "off" | "error" = "off";
		id: "pi-agent-kit.sandbox",
		label: "Sandbox",
		description: "Shows whether sandboxed bash execution is enabled for the current session.",
		defaults: {
			row: 1,
			position: 13,
			align: "right",
			fill: "none",
		},
		textColor: sandboxFooterState === "on"
			? "accent"
			: (sandboxFooterState === "restricted" ? "warning" : "error"),
		visible: () => sandboxFooterState !== "off",
		renderText: () => `sandbox:${sandboxFooterState}`,
	})).then((active) => {
		return active;
	});

	function updateSandboxStatus(ctx: ExtensionContext, status: "on" | "restricted" | "off" | "error"): void {
		sandboxFooterState = status;
			if (ctx.hasUI) {
				ctx.ui.setStatus("sandbox", undefined);
			}
			return;
		}
		if (!ctx.hasUI) return;
		if (status === "off") {
			ctx.ui.setStatus("sandbox", undefined);
			return;
		}
		const colors = createUiColors(ctx.ui.theme);
		const text = status === "on"
			? colors.primary("sandbox:on")
			: status === "restricted"
				? colors.warning("sandbox:restricted")
				: colors.danger("sandbox:error");
		ctx.ui.setStatus("sandbox", text);
	}

	pi.registerTool({
		...cachedBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return cachedBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(projectCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	pi.on("session_start", async (_event, ctx) => {
		projectCwd = ctx.cwd;
		cachedBash = createBashTool(projectCwd);
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			sandboxInitialized = false;
			updateSandboxStatus(ctx, "off");
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			sandboxInitialized = false;
			updateSandboxStatus(ctx, "off");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			sandboxInitialized = false;
			updateSandboxStatus(ctx, "restricted");
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			updateSandboxStatus(ctx, "on");
			ctx.ui.notify("Sandbox initialized", "info");
		} catch (err) {
			sandboxEnabled = false;
			sandboxInitialized = false;
			updateSandboxStatus(ctx, "error");
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	pi.registerCommand("sandbox", {
		description: "Toggle sandbox or show status (/sandbox, /sandbox on, /sandbox off)",
		getArgumentCompletions: (prefix: string) => {
			const values = ["on", "enable", "off", "disable"];
			const trimmed = prefix.trimStart().toLowerCase();
			if (!trimmed) return values.map((value) => ({ value, label: value }));
			const filtered = values.filter((value) => value.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			// /sandbox on
			if (arg === "on" || arg === "enable") {
				if (sandboxEnabled && sandboxInitialized) {
					ctx.ui.notify("Sandbox is already enabled", "info");
					return;
				}

				const platform = process.platform;
				if (platform !== "darwin" && platform !== "linux") {
					updateSandboxStatus(ctx, "restricted");
					ctx.ui.notify(`Sandbox not supported on ${platform}`, "error");
					return;
				}

				const config = loadConfig(ctx.cwd);
				try {
					const configExt = config as unknown as {
						ignoreViolations?: Record<string, string[]>;
						enableWeakerNestedSandbox?: boolean;
					};

					await SandboxManager.initialize({
						network: config.network,
						filesystem: config.filesystem,
						ignoreViolations: configExt.ignoreViolations,
						enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
					});

					sandboxEnabled = true;
					sandboxInitialized = true;

					updateSandboxStatus(ctx, "on");
					ctx.ui.notify("Sandbox enabled", "info");
				} catch (err) {
					sandboxEnabled = false;
					sandboxInitialized = false;
					updateSandboxStatus(ctx, "error");
					ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
				}
				return;
			}

			// /sandbox off
			if (arg === "off" || arg === "disable") {
				if (!sandboxEnabled) {
					ctx.ui.notify("Sandbox is already disabled", "info");
					return;
				}

				sandboxEnabled = false;
				if (sandboxInitialized) {
					try {
						await SandboxManager.reset();
					} catch {
						// Ignore cleanup errors
					}
					sandboxInitialized = false;
				}
				updateSandboxStatus(ctx, "off");
				ctx.ui.notify("Sandbox disabled", "info");
				return;
			}

			// /sandbox (no args) — toggle or show status
			if (!arg) {
				const config = loadConfig(ctx.cwd);
				const status = sandboxEnabled ? "ENABLED" : "DISABLED";
				const lines = [
					`Sandbox: ${status}`,
					"",
					"Network:",
					`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
					`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
					"",
					"Filesystem:",
					`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
					`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
					`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
					"",
					`Use /sandbox on or /sandbox off to toggle.`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify("Usage: /sandbox [on|off]", "error");
		},
	});
}
