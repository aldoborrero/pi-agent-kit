/**
 * Voice Extension — speech-to-text input for the coding agent.
 *
 * Records audio via microphone, transcribes with a cloud STT provider
 * (Groq / OpenAI) or a local daemon, and pastes or sends the result.
 *
 * Usage:
 *   Hold Space        — hold to record, release to stop & transcribe (requires Kitty keyboard protocol)
 *   /voice            — toggle recording
 *   /voice config     — open interactive settings panel
 *   /voice cancel     — cancel active recording
 *   /voice provider <auto|groq|openai|daemon>
 *   /voice lang <code>
 *   /voice mode <paste|send>
 *   /voice status     — show current configuration
 *
 * When recording is triggered by holding Space, the transcribed text is
 * inserted at the cursor position for review.
 *
 * Config is persisted to ~/.pi/agent/settings.json under the voice key.
 */

import { join } from "node:path";
import { DynamicBorder, SettingsManager, getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUiColors, registerEditorDecorator } from "@aldoborrero/pi-common";
import { Container, type SettingItem, SettingsList, Text, isKittyProtocolActive } from "@earendil-works/pi-tui";
import { createProvider, detectProvider, type ProviderName, type STTProvider } from "./providers.js";
import { DaemonRecorder, type Recorder, SpawnRecorder, NativeRecorder } from "./recorder.js";
import { loadNatives } from "@aldoborrero/pi-natives/src/natives.ts";

const natives = await loadNatives();
import { VoiceEditor } from "./voice-editor.js";
import { once } from "./once.ts";

type State = "idle" | "starting" | "recording" | "transcribing";

const LEVEL_BARS = "▁▃▅▇";
const LEVEL_METER_INTERVAL_MS = 100;
const MIN_AUDIO_LENGTH = 16000;

const VOICE_SETTINGS_KEY = "voice";

const PROVIDER_VALUES = ["auto", "groq", "openai", "daemon"] as const;
const LANG_VALUES = ["en", "fr", "de", "es", "it", "pt", "zh", "ja", "ko", "ru", "ar"] as const;
const MODE_VALUES = ["paste", "send"] as const;

type ProviderSetting = (typeof PROVIDER_VALUES)[number];

interface SavedConfig {
	provider?: ProviderName | "auto";
	lang: string;
	mode: "paste" | "send";
}

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
	return normalized;
}

async function loadSavedConfig(cwd: string = process.cwd()): Promise<Partial<SavedConfig>> {
	try {
		const manager = SettingsManager.create(cwd);
		const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
		const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
		const projectConfig = normalizeSavedConfig(projectSettings[VOICE_SETTINGS_KEY]);
		const globalConfig = normalizeSavedConfig(globalSettings[VOICE_SETTINGS_KEY]);
		return { ...globalConfig, ...projectConfig };
	} catch {
		return {};
	}
}

async function persistConfig(cwd: string, lang: string, mode: "paste" | "send", provider: ProviderName | null): Promise<void> {
	try {
		const manager = SettingsManager.create(cwd);
		await manager.reload();
		const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
		const saved: SavedConfig = { lang, mode };
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
  once(pi, "pi-voice", () => {
	let state: State = "idle";
	let provider: STTProvider | null = null;
	let providerName: ProviderName | null = null;
	let recorder: Recorder | null = null;
	let levelInterval: ReturnType<typeof setInterval> | null = null;
	let hints = "";

	// ─── Voice editor integration ──────────────────────────────────
	let voiceEditor: VoiceEditor | null = null;
	let currentCtx: ExtensionContext | null = null;
	let unregisterEditorDecorator: (() => void) | undefined;
	/** Tracks whether recording was triggered by the editor (space-hold). */
	let editorInitiatedRecording = false;

	const config = {
		lang: process.env.VOICE_LANG ?? "en",
		mode: (process.env.VOICE_MODE ?? "paste") as "paste" | "send",
	};

	// ─── Provider / Recorder init ───────────────────────────────────

	function initProvider(name?: ProviderName | "auto"): void {
		if (name && name !== "auto") {
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
			// Native microphone capture first — no arecord/sox/ffmpeg needed;
			// falls back to external recorders when the addon is unavailable.
			recorder = new NativeRecorder(natives);
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

	function holdSpaceAvailable(): boolean {
		return isKittyProtocolActive();
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const colors = createUiColors(ctx.ui.theme);

		switch (state) {
			case "idle":
				// Show provider name quietly in footer — no popup
				ctx.ui.setStatus(
					"voice",
					providerName ? colors.meta(`󰍬 ${providerName}`) : undefined,
				);
				break;
			case "starting":
			state = "recording";
			updateStatus(ctx);
			break;
			case "recording": {
				const bars = recorder?.hasLevel()
					? " " + renderLevel(recorder.getLevel())
					: "";
				ctx.ui.setStatus(
					"voice",
					colors.success("󰍬") + " REC" + bars,
				);
				break;
			}
			case "transcribing":
				ctx.ui.setStatus(
					"voice",
					colors.warning("󰍬") + " transcribing…",
				);
				break;
		}
	}

	function showError(ctx: ExtensionContext, msg: string): void {
		if (!ctx.hasUI) return;
		const colors = createUiColors(ctx.ui.theme);
		ctx.ui.setStatus("voice", colors.danger("󰍬") + " " + msg);
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

	function startRecording(ctx: ExtensionContext): boolean {
		if (!provider || !recorder) {
			showError(ctx, "No STT provider. Set GROQ_API_KEY, OPENAI_API_KEY, or VOICE_DAEMON_URL — or run /voice config.");
			return false;
		}

		state = "starting";
		updateStatus(ctx);

		try {
			recorder.start(() => {
				// onAutoStop callback — silence or max duration reached
				stopAndTranscribe(ctx);
			});
		} catch (err) {
			// Native mic capture can fail at system level (e.g. NixOS without
			// libpulse/libasound on the dynamic-loader path). External
			// binaries are a legitimate second chance before giving up.
			if (recorder instanceof NativeRecorder) {
				const fallback = new SpawnRecorder();
				try {
					fallback.start(() => {
						stopAndTranscribe(ctx);
					});
				} catch (fallbackErr) {
					state = "idle";
					showError(ctx, `Recording failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
					return false;
				}
				recorder = fallback;
				showError(ctx, "Native mic capture failed — using external recorder (arecord/sox/ffmpeg).");
			} else {
				state = "idle";
				showError(ctx, `Recording failed: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		}

		// Recorder started successfully — transition to recording
		state = "recording";
		updateStatus(ctx);

		if (recorder.hasLevel()) {
			levelInterval = setInterval(() => {
				updateStatus(ctx);
			}, LEVEL_METER_INTERVAL_MS);
		}
		return true;
	}

	async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
		if ((state !== "recording" && state !== "starting") || !recorder || !provider) return;

		// Sync editor state — recorder may auto-stop without editor knowing
		voiceEditor?.forceClearRecording();

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
		editorInitiatedRecording = false;
		updateStatus(ctx);
	}

	function cancelRecording(ctx: ExtensionContext): void {
		// Sync editor state
		voiceEditor?.forceClearRecording();

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

		// Editor-initiated recording: insert at cursor for review
		if (editorInitiatedRecording && voiceEditor) {
			voiceEditor.insertTranscription(trimmed);
			return;
		}

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
			case "starting":
			case "recording":
				stopAndTranscribe(ctx);
				break;
			case "transcribing":
				// Ignore — already processing
				break;
		}
	}

	// ─── Command ────────────────────────────────────────────────────

	pi.registerCommand("voice", {
		description: "Voice input — toggle recording or configure (config | cancel | status | provider | lang | mode)",

		getArgumentCompletions: (prefix: string) => {
			const subs = ["config", "cancel", "status", "provider", "lang", "mode"];
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
								persistConfig(ctx.cwd, config.lang, config.mode, providerName).catch(() => {});
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
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName);
						if (ctx.hasUI) ctx.ui.notify(`Voice provider: auto-detect → ${providerName ?? "none"}`, "info");
					} else if (name === "groq" || name === "openai" || name === "daemon") {
						initProvider(name);
						updateStatus(ctx);
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName);
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
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName);
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
						await persistConfig(ctx.cwd, config.lang, config.mode, providerName);
						if (ctx.hasUI) ctx.ui.notify(`Voice mode: ${mode}`, "info");
					} else {
						if (ctx.hasUI) ctx.ui.notify("Usage: /voice mode <paste|send>", "error");
					}
					break;
				}

				case "status": {
					const lines = [
						`Provider   : ${providerName ?? "none (run /voice config)"}`,
						`Language   : ${config.lang}`,
						`Mode       : ${config.mode}`,
						`State      : ${state}`,
						`Recorder   : ${recorder?.constructor.name ?? "none"}`,
						`Hold Space : ${holdSpaceAvailable() ? "available" : "unavailable (terminal is not sending key-release events)"}`,
						`Config     : ${getSettingsPath()}#${VOICE_SETTINGS_KEY}`,
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
		currentCtx = ctx;

		// Load persisted config (takes priority over env vars)
		const saved = await loadSavedConfig(ctx.cwd);
		if (saved.lang) config.lang = saved.lang;
		if (saved.mode) config.mode = saved.mode;

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

		// ── Register editor decorator. pi-common composes this with other editor extensions. ──
		unregisterEditorDecorator?.();
		unregisterEditorDecorator = registerEditorDecorator(ctx, "pi-voice", (inner, tui) => {
			voiceEditor = new VoiceEditor(inner, tui);

			voiceEditor.setCallbacks({
				onStartRecording: () => {
					editorInitiatedRecording = true;
					if (currentCtx) return startRecording(currentCtx);
					return false;
				},
				onStopRecording: () => {
					if (currentCtx) stopAndTranscribe(currentCtx);
				},
				onCancelRecording: () => {
					editorInitiatedRecording = false;
					if (currentCtx) cancelRecording(currentCtx);
					if (currentCtx?.hasUI) currentCtx.ui.notify("Recording cancelled", "info");
				},
			});

			return voiceEditor;
		}, { order: 20 });

		// Show provider quietly in footer — no popup
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state === "recording") cancelRecording(ctx);
		clearLevelInterval();

		// Dispose voice wrapper and unregister from the shared editor registry.
		unregisterEditorDecorator?.();
		unregisterEditorDecorator = undefined;
		voiceEditor?.dispose?.();
		voiceEditor = null;
		currentCtx = null;
		editorInitiatedRecording = false;
	});

  });
}
