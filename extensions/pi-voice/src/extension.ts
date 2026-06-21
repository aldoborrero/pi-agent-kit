/**
 * Voice Extension — speech-to-text input for the coding agent.
 *
 * Records audio via microphone, transcribes with a cloud STT provider
 * (Groq / OpenAI) or a local daemon, and pastes or sends the result.
 *
 * Usage:
 *   Ctrl+Alt+V  — toggle recording
 *   /voice            — toggle recording
 *   /voice config     — open interactive settings panel
 *   /voice cancel     — cancel active recording
 *   /voice provider <auto|groq|openai|daemon>
 *   /voice lang <code>
 *   /voice mode <paste|send>
 *   /voice status     — show current configuration
 *
 * Config is persisted to ~/.pi/agent/settings.json under the voice key.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DynamicBorder, SettingsManager, getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { createProvider, detectProvider, type ProviderName, type STTProvider } from "./providers.js";
import { DaemonRecorder, type Recorder, SpawnRecorder } from "./recorder.js";

type State = "idle" | "recording" | "transcribing";

const LEVEL_BARS = "▁▃▅▇";
const LEVEL_METER_INTERVAL_MS = 100;
const MIN_AUDIO_LENGTH = 16000;

const LEGACY_CONFIG_FILE = join(homedir(), ".pi", "voice.json");
const VOICE_SETTINGS_KEY = "voice";

const PROVIDER_VALUES = ["auto", "groq", "openai", "daemon"] as const;
const LANG_VALUES = ["en", "fr", "de", "es", "it", "pt", "zh", "ja", "ko", "ru", "ar"] as const;
const MODE_VALUES = ["paste", "send"] as const;

type ProviderSetting = (typeof PROVIDER_VALUES)[number];

interface SavedConfig {
	provider?: ProviderName;
	lang: string;
	mode: "paste" | "send";
	shortcut?: string;
}

const DEFAULT_SHORTCUT = "ctrl+alt+v";

function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function normalizeSavedConfig(raw: unknown): Partial<SavedConfig> {
	if (!raw || typeof raw !== "object") return {};
	const config = raw as Partial<SavedConfig>;
	const normalized: Partial<SavedConfig> = {};
	if (config.provider === "auto" || config.provider === "groq" || config.provider === "openai" || config.provider === "daemon") {
		normalized.provider = config.provider;
	}
	if (typeof config.lang === "string" && config.lang.trim()) normalized.lang = config.lang.trim();
	if (config.mode === "paste" || config.mode === "send") normalized.mode = config.mode;
	if (typeof config.shortcut === "string" && config.shortcut.trim()) normalized.shortcut = config.shortcut.trim();
	return normalized;
}

function readLegacySavedConfigSync(): Partial<SavedConfig> {
	try {
		const raw = readFileSync(LEGACY_CONFIG_FILE, "utf8");
		return normalizeSavedConfig(JSON.parse(raw));
	} catch {
		return {};
	}
}

function loadSavedConfigSync(cwd: string = process.cwd()): Partial<SavedConfig> {
	try {
		const manager = SettingsManager.create(cwd);
		const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
		const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
		const projectConfig = normalizeSavedConfig(projectSettings[VOICE_SETTINGS_KEY]);
		const globalConfig = normalizeSavedConfig(globalSettings[VOICE_SETTINGS_KEY]);
		return { ...readLegacySavedConfigSync(), ...globalConfig, ...projectConfig };
	} catch {
		return readLegacySavedConfigSync();
	}
}

async function loadSavedConfig(cwd: string = process.cwd()): Promise<Partial<SavedConfig>> {
	return loadSavedConfigSync(cwd);
}

async function persistConfig(cwd: string, lang: string, mode: "paste" | "send", provider: ProviderName | null, shortcut: string): Promise<void> {
	try {
		const manager = SettingsManager.create(cwd);
		await manager.reload();
		const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
		const saved: SavedConfig = { lang, mode, shortcut };
		if (provider) saved.provider = provider;
		globalSettings[VOICE_SETTINGS_KEY] = saved;
		const internal = manager as unknown as {
			globalSettings: Record<string, unknown>;
			modifiedFields: Set<string>;
			save: () => void;
			flush: () => Promise<void>;
		};
		internal.globalSettings = globalSettings;
		internal.modifiedFields.add(VOICE_SETTINGS_KEY);
		internal.save();
		await internal.flush();
	} catch {
		// Non-critical
	}
}

export default function voiceExtension(pi: ExtensionAPI) {
	let state: State = "idle";
	let provider: STTProvider | null = null;
	let providerName: ProviderName | null = null;
	let recorder: Recorder | null = null;
	let levelInterval: ReturnType<typeof setInterval> | null = null;
	let hints = "";

	// Read shortcut synchronously — registerShortcut runs at load time
	const initConfig = loadSavedConfigSync(process.cwd());
	const activeShortcut = initConfig.shortcut ?? DEFAULT_SHORTCUT;

	const config = {
		lang: process.env.VOICE_LANG ?? "en",
		mode: (process.env.VOICE_MODE ?? "paste") as "paste" | "send",
		shortcut: activeShortcut,
	};

	// ─── Provider / Recorder init ───────────────────────────────────

	function initProvider(name?: ProviderName): void {
		if (name) {
			provider = createProvider(name);
			providerName = name;
		} else {
			const detected = detectProvider();
			if (detected) {
				provider = detected.provider;
				providerName = detected.name;
			} else {
				provider = null;
				providerName = null;
			}
		}

		if (providerName === "daemon") {
			recorder = new DaemonRecorder();
		} else {
			recorder = new SpawnRecorder();
		}
	}

	// ─── Status / UI helpers ────────────────────────────────────────

	function renderLevel(level: number): string {
		const clamped = Math.max(0, Math.min(1, level));
		const idx = Math.min(
			Math.floor(clamped * LEVEL_BARS.length),
			LEVEL_BARS.length - 1,
		);
		return LEVEL_BARS.slice(0, idx + 1);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const colors = createUiColors(ctx.ui.theme);

		switch (state) {
			case "idle":
				// Show provider name quietly in footer — no popup
				ctx.ui.setStatus(
					"voice",
					providerName ? colors.meta(`voice:${providerName}`) : undefined,
				);
				break;
			case "recording": {
				const bars = recorder?.hasLevel()
					? " " + renderLevel(recorder.getLevel())
					: "";
				ctx.ui.setStatus(
					"voice",
					colors.success("●") + " REC" + bars,
				);
				break;
			}
			case "transcribing":
				ctx.ui.setStatus(
					"voice",
					colors.warning("●") + " transcribing…",
				);
				break;
		}
	}

	function showError(ctx: ExtensionContext, msg: string): void {
		if (!ctx.hasUI) return;
		const colors = createUiColors(ctx.ui.theme);
		ctx.ui.setStatus("voice", colors.danger("●") + " " + msg);
		setTimeout(() => {
			if (state === "idle") {
				ctx.ui.setStatus("voice", undefined);
			}
		}, 3000);
		ctx.ui.notify(msg, "error");
	}

	function clearLevelInterval(): void {
		if (levelInterval) {
			clearInterval(levelInterval);
			levelInterval = null;
		}
	}

	// ─── Recording lifecycle ────────────────────────────────────────

	function startRecording(ctx: ExtensionContext): void {
		if (!provider || !recorder) {
			showError(ctx, "No STT provider. Set GROQ_API_KEY, OPENAI_API_KEY, or VOICE_DAEMON_URL — or run /voice config.");
			return;
		}

		state = "recording";
		updateStatus(ctx);

		try {
			recorder.start(() => {
				// onAutoStop callback — silence or max duration reached
				stopAndTranscribe(ctx);
			});
		} catch (err) {
			state = "idle";
			showError(ctx, `Recording failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		if (recorder.hasLevel()) {
			levelInterval = setInterval(() => {
				updateStatus(ctx);
			}, LEVEL_METER_INTERVAL_MS);
		}
	}

	async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
		if (state !== "recording" || !recorder || !provider) return;

		clearLevelInterval();
		state = "transcribing";
		updateStatus(ctx);

		try {
			const result = await recorder.stop();

			// Daemon path: transcription comes back directly
			if (result.transcription !== undefined) {
				if (!result.transcription) {
					showError(ctx, "No speech detected");
					state = "idle";
					updateStatus(ctx);
					return;
				}
				outputText(ctx, result.transcription);
				state = "idle";
				updateStatus(ctx);
				return;
			}

			// Cloud path: we have audio, send to provider
			if (!result.audio || result.audio.length < MIN_AUDIO_LENGTH) {
				showError(ctx, "Recording too short");
				state = "idle";
				updateStatus(ctx);
				return;
			}

			const text = await provider.transcribe(result.audio, config.lang, hints);
			if (!text) {
				showError(ctx, "No speech detected");
				state = "idle";
				updateStatus(ctx);
				return;
			}

			outputText(ctx, text);
		} catch (err) {
			showError(ctx, `Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		state = "idle";
		updateStatus(ctx);
	}

	function cancelRecording(ctx: ExtensionContext): void {
		clearLevelInterval();
		if (recorder) {
			recorder.cancel();
		}
		state = "idle";
		updateStatus(ctx);
	}

	function outputText(ctx: ExtensionContext, text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;

		if (config.mode === "send") {
			pi.sendUserMessage(trimmed);
		} else {
			if (ctx.hasUI) {
				ctx.ui.setEditorText(trimmed);
			}
		}
	}

	// ─── Toggle ─────────────────────────────────────────────────────

	function toggle(ctx: ExtensionContext): void {
		switch (state) {
			case "idle":
				startRecording(ctx);
				break;
			case "recording":
				stopAndTranscribe(ctx);
				break;
			case "transcribing":
				// Ignore — already processing
				break;
		}
	}

	// ─── Keyboard shortcut ──────────────────────────────────────────

	pi.registerShortcut(activeShortcut as Parameters<typeof pi.registerShortcut>[0], {
		description: "Toggle voice recording",
		handler: (ctx) => {
			toggle(ctx);
		},
	});

	// ─── Command ────────────────────────────────────────────────────

	pi.registerCommand("voice", {
		description: "Voice input — toggle recording or configure (config | cancel | status | provider | lang | mode)",

		getArgumentCompletions: (prefix: string) => {
			const subs = ["config", "cancel", "status", "provider", "lang", "mode", "shortcut"];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},

		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";

			if (!sub) {
				toggle(ctx);
				return;
			}

			switch (sub) {
				case "cancel":
					cancelRecording(ctx);
					if (ctx.hasUI) ctx.ui.notify("Recording cancelled", "info");
					break;

				// ─── Interactive config panel ────────────────────────────
				case "config": {
					const currentProvider: ProviderSetting = providerName ?? "auto";
					const langValues: string[] = LANG_VALUES.includes(config.lang as (typeof LANG_VALUES)[number])
						? [...LANG_VALUES]
						: [config.lang, ...LANG_VALUES];

					const items: SettingItem[] = [
						{
							id: "provider",
							label: "STT Provider",
							currentValue: currentProvider,
							values: [...PROVIDER_VALUES],
						},
						{
							id: "lang",
							label: "Language",
							currentValue: config.lang,
							values: langValues,
						},
						{
							id: "mode",
							label: "Output Mode",
							currentValue: config.mode,
							values: [...MODE_VALUES],
						},
					];

					await ctx.ui.custom((tui, theme, _kb, done) => {
						const colors = createUiColors(theme);
						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => colors.primary(s)));
						container.addChild(new Text(colors.primary(theme.bold(" Voice Settings")), 1, 0));

						const settingsList = new SettingsList(
							items,
							Math.min(items.length + 4, 12),
							getSettingsListTheme(),
							(id, newValue) => {
								if (id === "provider") {
									initProvider(newValue === "auto" ? undefined : (newValue as ProviderName));
								} else if (id === "lang") {
									config.lang = newValue;
								} else if (id === "mode") {
									config.mode = newValue as "paste" | "send";
								}
								updateStatus(ctx);
								persistConfig(ctx.cwd, config.lang, config.mode, providerName, config.shortcut).catch(() => {});
							},
							() => done(undefined),
						);

						container.addChild(settingsList);
						container.addChild(
							new Text(colors.subtle(" ↑↓ navigate  •  space/enter cycle  •  esc close"), 1, 0),
						);
						container.addChild(new DynamicBorder((s: string) => colors.primary(s)));

						return {
							render: (w) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data) => {
								settingsList.handleInput?.(data);
								tui.requestRender();
							},
						};
					});
					break;
				}

				// ─── Inline setters (kept for backward compat / scripting) ──
				case "provider": {
					const name = parts[1]?.toLowerCase();
					if (name === "auto") {
						initProvider();
						updateStatus(ctx);
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName, config.shortcut);
						if (ctx.hasUI) ctx.ui.notify(`Voice provider: auto-detect → ${providerName ?? "none"}`, "info");
					} else if (name === "groq" || name === "openai" || name === "daemon") {
						initProvider(name);
						updateStatus(ctx);
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName, config.shortcut);
						if (ctx.hasUI) ctx.ui.notify(`Voice provider: ${name}`, "info");
					} else {
						if (ctx.hasUI) ctx.ui.notify("Usage: /voice provider <auto|groq|openai|daemon>", "error");
					}
					break;
				}

				case "lang": {
					const code = parts[1];
					if (code) {
						config.lang = code;
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName, config.shortcut);
						if (ctx.hasUI) ctx.ui.notify(`Voice language: ${code}`, "info");
					} else {
						if (ctx.hasUI) ctx.ui.notify(`Voice language: ${config.lang}`, "info");
					}
					break;
				}

				case "mode": {
					const mode = parts[1]?.toLowerCase();
					if (mode === "paste" || mode === "send") {
						config.mode = mode;
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName, config.shortcut);
						if (ctx.hasUI) ctx.ui.notify(`Voice mode: ${mode}`, "info");
					} else {
						if (ctx.hasUI) ctx.ui.notify("Usage: /voice mode <paste|send>", "error");
					}
					break;
				}

				case "shortcut": {
					const key = parts.slice(1).join("+").toLowerCase();
					if (key) {
						config.shortcut = key;
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName, config.shortcut);
						if (ctx.hasUI) ctx.ui.notify(`Voice shortcut: ${key}\nRun /reload for it to take effect.`, "info");
					} else {
						if (ctx.hasUI) ctx.ui.notify(`Voice shortcut: ${config.shortcut}\nUsage: /voice shortcut <key> (e.g. ctrl+alt+v)`, "info");
					}
					break;
				}

				case "status": {
					const lines = [
						`Provider : ${providerName ?? "none (run /voice config)"}`,
						`Language : ${config.lang}`,
						`Mode     : ${config.mode}`,
						`Shortcut : ${config.shortcut} (active: ${activeShortcut})`,
						`State    : ${state}`,
						`Recorder : ${recorder?.constructor.name ?? "none"}`,
						`Config   : ${getSettingsPath()}#${VOICE_SETTINGS_KEY}`,
					];
					if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				default:
					if (ctx.hasUI) {
						ctx.ui.notify(
							"Usage: /voice [config | cancel | status | provider <name> | lang <code> | mode <paste|send>]",
							"error",
						);
					}
					break;
			}
		},
	});

	// ─── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Load persisted config (takes priority over env vars)
		const saved = await loadSavedConfig(ctx.cwd);
		if (saved.lang) config.lang = saved.lang;
		if (saved.mode) config.mode = saved.mode;
		if (saved.shortcut) config.shortcut = saved.shortcut;

		// Build hints from project context
		try {
			const nameResult = await pi.exec("bash", [
				"-c",
				"cat package.json 2>/dev/null | grep '\"name\"' | head -1 | sed 's/.*\"name\".*\"\\(.*\\)\".*/\\1/'",
			]);
			const branchResult = await pi.exec("bash", ["-c", "git rev-parse --abbrev-ref HEAD 2>/dev/null"]);
			const parts: string[] = [];
			if (nameResult.stdout?.trim()) parts.push(nameResult.stdout.trim());
			if (branchResult.stdout?.trim()) parts.push(branchResult.stdout.trim());
			if (parts.length > 0) hints = parts.join(" ");
		} catch {
			// Non-critical — hints are optional
		}

		// Init provider: prefer persisted choice, fall back to env-var auto-detect
		initProvider(saved.provider);

		// Show provider quietly in footer — no popup
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state === "recording") cancelRecording(ctx);
		clearLevelInterval();
	});
}
