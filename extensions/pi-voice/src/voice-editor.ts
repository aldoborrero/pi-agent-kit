/**
 * VoiceEditor — CustomEditor with walkie-talkie style hold-Space-to-record.
 *
 * Adapted from the pi-whisper-voice state machine by kengbailey, with
 * our multi-provider architecture.
 *
 * Behaviour:
 *   - Tap Space (quick press + release): inserts a single space character.
 *   - Hold Space (press + hold past threshold): recording starts.
 *     The space is NOT inserted on press — it's only inserted on release
 *     if the hold threshold was not reached. This avoids the insert-then-delete
 *     pattern that can lose a space if recording fails to start.
 *   - Recording stays active while Space is held down.
 *   - Release Space: stops recording → transcribes → inserts text at cursor.
 *   - Escape during recording: cancels.
 *   - If the user was typing recently (within typingCooldownMs), Space is
 *     treated as normal input, not a hold candidate.
 *
 * Requires Kitty keyboard protocol for key-release detection. Without it,
 * all input passes through untouched so normal typing never breaks.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";


// ─── Timing constants ──────────────────────────────────────────────

/** How long the user must hold Space before recording starts (ms). */
const HOLD_THRESHOLD_MS = 1200;

/** Space pressed within this window after other typing is normal input. */
const TYPING_COOLDOWN_MS = 400;

// ─── VoiceEditor ───────────────────────────────────────────────────

export interface VoiceEditorCallbacks {
	/** Called when the user holds Space long enough to start recording. */
	onStartRecording: () => boolean;
	/** Called when the user releases Space to stop recording. */
	onStopRecording: () => void;
	/** Called when recording is cancelled (e.g. Escape). */
	onCancelRecording: () => void;
}

export class VoiceEditor extends CustomEditor {
	private callbacks: VoiceEditorCallbacks | null = null;

	// ── Space-hold state ──
	/** Timestamp of the last non-space typing, for cooldown detection. */
	private lastTypingTime = 0;
	/** Space is currently held down (press received, no release yet). */
	private spaceDownAt = 0;
	/** Timer that fires when the hold threshold is reached. */
	private holdTimer: ReturnType<typeof setTimeout> | null = null;

	/** Whether recording is currently active (space held past threshold). */
	private recordingActive = false;

	/** Set callbacks for recording lifecycle. */
	setCallbacks(callbacks: VoiceEditorCallbacks): void {
		this.callbacks = callbacks;
	}

	/** Whether the editor is currently in recording mode. */
	isRecording(): boolean {
		return this.recordingActive;
	}

	/**
	 * Insert transcribed text at the cursor position.
	 */
	insertTranscription(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;

		this.insertTextAtCursor(trimmed);
		this.tui.requestRender();
	}

	// ─── Input handling ────────────────────────────────────────────

	override handleInput(data: string): void {
		// ── Key release events are never text input. Consume them. ──
		if (isKeyRelease(data)) {
			if (isKittyProtocolActive() && matchesKey(data, "space")) {
				this.onSpaceRelease();
			}
			return;
		}

		// ── Without Kitty protocol, hold-to-talk is not safe. ──
		// Pass all input through untouched so normal SPACE typing works.
		if (!isKittyProtocolActive()) {
			super.handleInput(data);
			return;
		}

		// ── Recording active: only Escape cancels, release stops ──
		if (this.recordingActive) {
			if (matchesKey(data, "escape")) {
				this.cancelRecording();
				return;
			}
			if (matchesKey(data, "space")) {
				// Key repeat while recording — ignore (keep recording)
				if (isKeyRepeat(data)) return;
				// A new press while recording shouldn't happen (we haven't
				// received a release), but if it does, ignore it.
				return;
			}
			// Ignore other keys during recording
			return;
		}

		// ── Track non-space typing for cooldown ──
		const printable = this.decodePrintable(data);
		if (printable && printable !== " ") {
			this.lastTypingTime = Date.now();
		}

		// ── Ignore space repeats while a hold is pending ──
		if (isKeyRepeat(data)) {
			if (matchesKey(data, "space") && this.spaceDownAt > 0) return;
			super.handleInput(data);
			return;
		}

		// ── Space hold detection ──
		if (matchesKey(data, "space")) {
			this.onSpacePress(data);
			return;
		}

		// ── Non-space key while holding space: commit pending space, pass through ──
		if (this.spaceDownAt > 0) {
			this.cancelPendingSpace();
			// Insert the pending space as ordinary input
			super.handleInput(" ");
		}

		super.handleInput(data);
	}

	// ─── Space-hold state machine ──────────────────────────────────

	private onSpacePress(data: string): void {
		// Already tracking a space press — ignore
		if (this.spaceDownAt > 0) return;

		const now = Date.now();

		// Typing cooldown: if user typed recently, treat space as normal input
		if (now - this.lastTypingTime < TYPING_COOLDOWN_MS) {
			super.handleInput(data);
			return;
		}

		// Start tracking the hold. Do NOT insert the space yet — it will be
		// inserted on release if the hold threshold was not reached.
		this.spaceDownAt = now;
		this.holdTimer = setTimeout(() => {
			this.holdTimer = null;
			if (this.spaceDownAt > 0) {
				void this.triggerRecording();
			}
		}, HOLD_THRESHOLD_MS);
	}

	private onSpaceRelease(): void {
		if (this.spaceDownAt <= 0 && !this.recordingActive) return;

		const heldMs = this.spaceDownAt > 0 ? Date.now() - this.spaceDownAt : 0;
		this.spaceDownAt = 0;
		this.clearHoldTimer();

		// Released before threshold: ordinary single space tap.
		if (!this.recordingActive && heldMs < HOLD_THRESHOLD_MS) {
			super.handleInput(" ");
			return;
		}

		// Recording is active: stop and transcribe
		if (this.recordingActive) {
			this.stopRecording();
			return;
		}
	}

	// ─── Recording lifecycle ───────────────────────────────────────

	/**
	 * Called when the hold threshold is reached. Enters recording mode.
	 * If start fails, aborts recording mode immediately.
	 */
	private async triggerRecording(): Promise<void> {
		this.recordingActive = true;
		this.tui.requestRender();

		// If start fails, abort recording mode immediately
		if (this.callbacks && !this.callbacks.onStartRecording()) {
			this.forceClearRecording();
		}
	}

	/** Clear all recording/hold state without triggering callbacks. */
	forceClearRecording(): void {
		this.recordingActive = false;
		this.spaceDownAt = 0;
		this.clearHoldTimer();
		this.tui.requestRender();
	}

	/** Stop recording (Space released). Calls onStopRecording callback. */
	private stopRecording(): void {
		this.recordingActive = false;
		this.spaceDownAt = 0;
		this.clearHoldTimer();
		this.tui.requestRender();

		this.callbacks?.onStopRecording();
	}

	/** Cancel recording (Escape pressed). Calls onCancelRecording callback. */
	private cancelRecording(): void {
		this.recordingActive = false;
		this.spaceDownAt = 0;
		this.clearHoldTimer();
		this.tui.requestRender();

		this.callbacks?.onCancelRecording();
	}

	// ─── Helpers ───────────────────────────────────────────────────

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
		// Raw terminal printable input
		if (data.length === 1 && data.charCodeAt(0) >= 32) return data;
		// Kitty CSI-u printable decoder
		return decodeKittyPrintable(data);
	}

	// ─── Rendering ─────────────────────────────────────────────────

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// Show recording indicator in the bottom border
		if (this.recordingActive) {
			const label = " \x1b[31m● REC\x1b[0m ";
			const last = lines.length - 1;
			if (visibleWidth(lines[last]!) >= visibleWidth(label)) {
				lines[last] = truncateToWidth(lines[last]!, width - visibleWidth(label), "") + label;
			}
		}

		return lines;
	}

	// ─── Cleanup ───────────────────────────────────────────────────

	dispose(): void {
		this.recordingActive = false;
		this.spaceDownAt = 0;
		this.clearHoldTimer();
	}
}
