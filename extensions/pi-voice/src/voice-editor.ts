/**
 * VoiceEditor — editor wrapper/decorator with hold-Space-to-record.
 *
 * This does not replace the base editor implementation. Instead it wraps an
 * existing EditorComponent and intercepts only the Space hold/release state
 * machine, delegating all normal editing behavior to the wrapped editor.
 * This lets pi-voice coexist with other editor extensions (e.g. Oracle).
 */

import {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type AutocompleteProvider,
	type EditorComponent,
	type TUI,
} from "@earendil-works/pi-tui";

/** How long the user must hold Space before recording starts (ms). */
const HOLD_THRESHOLD_MS = 1200;

/** Space pressed within this window after other typing is normal input. */
const TYPING_COOLDOWN_MS = 400;

export interface VoiceEditorCallbacks {
	/** Called when the user holds Space long enough to start recording. */
	onStartRecording: () => boolean;
	/** Called when the user releases Space to stop recording. */
	onStopRecording: () => void;
	/** Called when recording is cancelled (e.g. Escape). */
	onCancelRecording: () => void;
}

export class VoiceEditor implements EditorComponent {
	private callbacks: VoiceEditorCallbacks | null = null;
	private lastTypingTime = 0;
	private spaceDownAt = 0;
	private holdTimer: ReturnType<typeof setTimeout> | null = null;
	private recordingActive = false;

	// Expose CustomEditor's duck-typed app-keybinding surface so the host can wire
	// global actions even though this editor is now a wrapper.
	public actionHandlers: Map<string, () => void> = new Map();
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(
		private readonly inner: EditorComponent,
		private readonly tui: TUI,
	) {}

	// ─── EditorComponent plumbing / delegation ──────────────────────

	get wantsKeyRelease(): boolean {
		return isKittyProtocolActive() || this.inner.wantsKeyRelease === true;
	}

	get focused(): boolean {
		return (this.inner as unknown as { focused?: boolean }).focused ?? false;
	}

	set focused(value: boolean) {
		(this.inner as unknown as { focused?: boolean }).focused = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.inner.onSubmit;
	}

	set onSubmit(handler: ((text: string) => void) | undefined) {
		this.inner.onSubmit = handler;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.inner.onChange;
	}

	set onChange(handler: ((text: string) => void) | undefined) {
		this.inner.onChange = handler;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.inner.borderColor;
	}

	set borderColor(fn: ((str: string) => string) | undefined) {
		this.inner.borderColor = fn;
	}

	getText(): string {
		return this.inner.getText();
	}

	getExpandedText(): string {
		return this.inner.getExpandedText?.() ?? this.inner.getText();
	}

	setText(text: string): void {
		this.inner.setText(text);
	}

	addToHistory(text: string): void {
		this.inner.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		if (this.inner.insertTextAtCursor) {
			this.inner.insertTextAtCursor(text);
			return;
		}
		// Fallback for a custom editor that does not expose cursor insertion.
		this.inner.setText(`${this.inner.getText()}${text}`);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.inner.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.inner.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.inner.setAutocompleteMaxVisible?.(maxVisible);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	isShowingAutocomplete(): boolean {
		return (this.inner as unknown as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() ?? false;
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (lines.length === 0) return lines;

		if (this.recordingActive) {
			const label = " \x1b[31m● REC\x1b[0m ";
			const last = lines.length - 1;
			if (visibleWidth(lines[last]!) >= visibleWidth(label)) {
				lines[last] = truncateToWidth(lines[last]!, width - visibleWidth(label), "") + label;
			}
		}

		return lines;
	}

	// ─── Voice lifecycle API ────────────────────────────────────────

	setCallbacks(callbacks: VoiceEditorCallbacks): void {
		this.callbacks = callbacks;
	}

	isRecording(): boolean {
		return this.recordingActive;
	}

	insertTranscription(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.insertTextAtCursor(trimmed);
		this.tui.requestRender();
	}

	/** Clear recording/hold state without triggering callbacks. */
	forceClearRecording(): void {
		this.recordingActive = false;
		this.spaceDownAt = 0;
		this.clearHoldTimer();
		this.tui.requestRender();
	}

	dispose(): void {
		this.forceClearRecording();
		(this.inner as unknown as { dispose?: () => void }).dispose?.();
	}

	// ─── Input interception ─────────────────────────────────────────

	handleInput(data: string): void {
		this.syncCustomEditorHooks();

		// Release events are never text input. Consume Space release for voice;
		// forward other release events only if the wrapped editor requested them.
		if (isKeyRelease(data)) {
			if (isKittyProtocolActive() && matchesKey(data, "space")) {
				this.onSpaceRelease();
				return;
			}
			if (this.inner.wantsKeyRelease) this.inner.handleInput(data);
			return;
		}

		// Without Kitty protocol, hold-to-talk is not safe. Preserve the wrapped
		// editor exactly.
		if (!isKittyProtocolActive()) {
			this.inner.handleInput(data);
			return;
		}

		if (this.recordingActive) {
			if (matchesKey(data, "escape")) {
				this.cancelRecording();
				return;
			}
			if (matchesKey(data, "space")) return;
			return;
		}

		const printable = this.decodePrintable(data);
		if (printable && printable !== " ") {
			this.lastTypingTime = Date.now();
		}

		if (isKeyRepeat(data)) {
			if (matchesKey(data, "space") && this.spaceDownAt > 0) return;
			this.inner.handleInput(data);
			return;
		}

		if (matchesKey(data, "space")) {
			this.onSpacePress(data);
			return;
		}

		if (this.spaceDownAt > 0) {
			this.cancelPendingSpace();
			this.inner.handleInput(" ");
		}

		this.inner.handleInput(data);
	}

	private onSpacePress(data: string): void {
		if (this.spaceDownAt > 0) return;

		const now = Date.now();
		if (now - this.lastTypingTime < TYPING_COOLDOWN_MS) {
			this.inner.handleInput(data);
			return;
		}

		this.spaceDownAt = now;
		this.holdTimer = setTimeout(() => {
			this.holdTimer = null;
			if (this.spaceDownAt > 0) void this.triggerRecording();
		}, HOLD_THRESHOLD_MS);
	}

	private onSpaceRelease(): void {
		if (this.spaceDownAt <= 0 && !this.recordingActive) return;

		const heldMs = this.spaceDownAt > 0 ? Date.now() - this.spaceDownAt : 0;
		this.spaceDownAt = 0;
		this.clearHoldTimer();

		if (!this.recordingActive && heldMs < HOLD_THRESHOLD_MS) {
			this.inner.handleInput(" ");
			return;
		}

		if (this.recordingActive) this.stopRecording();
	}

	private async triggerRecording(): Promise<void> {
		this.recordingActive = true;
		this.tui.requestRender();

		if (this.callbacks && !this.callbacks.onStartRecording()) {
			this.forceClearRecording();
		}
	}

	private stopRecording(): void {
		this.recordingActive = false;
		this.spaceDownAt = 0;
		this.clearHoldTimer();
		this.tui.requestRender();
		this.callbacks?.onStopRecording();
	}

	private cancelRecording(): void {
		this.recordingActive = false;
		this.spaceDownAt = 0;
		this.clearHoldTimer();
		this.tui.requestRender();
		this.callbacks?.onCancelRecording();
	}

	private cancelPendingSpace(): void {
		this.spaceDownAt = 0;
		this.clearHoldTimer();
	}

	private clearHoldTimer(): void {
		if (this.holdTimer) {
			clearTimeout(this.holdTimer);
			this.holdTimer = null;
		}
	}

	private decodePrintable(data: string): string | undefined {
		if (data.length === 1 && data.charCodeAt(0) >= 32) return data;
		return decodeKittyPrintable(data);
	}

	private syncCustomEditorHooks(): void {
		const custom = this.inner as unknown as {
			actionHandlers?: Map<string, () => void>;
			onEscape?: () => void;
			onCtrlD?: () => void;
			onPasteImage?: () => void;
			onExtensionShortcut?: (data: string) => boolean;
		};

		if (custom.actionHandlers instanceof Map) {
			for (const [action, handler] of this.actionHandlers) {
				custom.actionHandlers.set(action, handler);
			}
		}
		if (this.onEscape) custom.onEscape = this.onEscape;
		if (this.onCtrlD) custom.onCtrlD = this.onCtrlD;
		if (this.onPasteImage) custom.onPasteImage = this.onPasteImage;
		if (this.onExtensionShortcut) custom.onExtensionShortcut = this.onExtensionShortcut;
	}
}
