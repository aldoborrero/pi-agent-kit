import { spawn, execSync, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

const SILENCE_THRESHOLD = 0.01;
const SILENCE_DURATION_MS = 2000;
const MAX_DURATION_MS = 60000;

export interface RecordingResult {
	audio: Buffer | null;
	transcription?: string;
}

export interface Recorder {
	start(onAutoStop: () => void): void;
	stop(): Promise<RecordingResult>;
	cancel(): void;
	getLevel(): number;
	hasLevel(): boolean;
	isAvailable(): Promise<boolean>;
}

export function buildWavHeader(dataLength: number): Buffer {
	const header = Buffer.alloc(44);
	const sampleRate = 16000;
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataLength, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // subchunk1 size
	header.writeUInt16LE(1, 20); // PCM format
	header.writeUInt16LE(numChannels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataLength, 40);

	return header;
}

export function computeRms(chunk: Buffer): number {
	const sampleCount = Math.floor(chunk.length / 2);
	if (sampleCount === 0) return 0;

	let sumSquares = 0;
	for (let i = 0; i < sampleCount; i++) {
		const sample = chunk.readInt16LE(i * 2);
		const normalized = sample / 32768;
		sumSquares += normalized * normalized;
	}

	return Math.sqrt(sumSquares / sampleCount);
}

function which(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

interface DetectedRecorder {
	command: string;
	args: string[];
}

function detectRecorder(): DetectedRecorder | null {
	const os = platform();

	if (os === "linux") {
		if (which("arecord")) {
			return {
				command: "arecord",
				args: ["-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"],
			};
		}
		if (which("rec")) {
			return {
				command: "rec",
				args: ["-r", "16000", "-c", "1", "-b", "16", "-e", "signed", "-t", "raw", "-"],
			};
		}
		if (which("ffmpeg")) {
			return {
				command: "ffmpeg",
				args: ["-f", "alsa", "-i", "default", "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
			};
		}
	} else if (os === "darwin") {
		if (which("rec")) {
			return {
				command: "rec",
				args: ["-r", "16000", "-c", "1", "-b", "16", "-e", "signed", "-t", "raw", "-"],
			};
		}
		if (which("ffmpeg")) {
			return {
				command: "ffmpeg",
				args: ["-f", "avfoundation", "-i", ":default", "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
			};
		}
	}

	return null;
}

export class SpawnRecorder implements Recorder {
	private process: ChildProcess | null = null;
	private chunks: Buffer[] = [];
	private latestRms = 0;
	private silenceStart: number | null = null;
	private recordingStart: number | null = null;
	private detected: DetectedRecorder | null = null;

	start(onAutoStop: () => void): void {
		this.detected = detectRecorder();
		if (!this.detected) {
			throw new Error("No recording tool found. Install arecord, sox (rec), or ffmpeg.");
		}

		this.chunks = [];
		this.latestRms = 0;
		this.silenceStart = null;
		this.recordingStart = Date.now();

		this.process = spawn(this.detected.command, this.detected.args, {
			stdio: ["ignore", "pipe", "ignore"],
		});

		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.chunks.push(chunk);
			this.latestRms = computeRms(chunk);

			const now = Date.now();

			// Silence detection
			if (this.latestRms < SILENCE_THRESHOLD) {
				if (this.silenceStart === null) {
					this.silenceStart = now;
				} else if (now - this.silenceStart >= SILENCE_DURATION_MS) {
					this.killProcess();
					onAutoStop();
					return;
				}
			} else {
				this.silenceStart = null;
			}

			// Max duration enforcement
			if (this.recordingStart && now - this.recordingStart >= MAX_DURATION_MS) {
				this.killProcess();
				onAutoStop();
			}
		});
	}

	async stop(): Promise<RecordingResult> {
		this.killProcess();

		const rawData = Buffer.concat(this.chunks);
		const header = buildWavHeader(rawData.length);
		const audio = Buffer.concat([header, rawData]);

		this.chunks = [];
		return { audio };
	}

	cancel(): void {
		if (this.process) {
			this.process.kill("SIGTERM");
			setTimeout(() => {
				if (this.process && !this.process.killed) {
					this.process.kill("SIGKILL");
				}
			}, 500);
			this.process = null;
		}
		this.chunks = [];
	}

	getLevel(): number {
		return this.latestRms;
	}

	hasLevel(): boolean {
		return true;
	}

	async isAvailable(): Promise<boolean> {
		return detectRecorder() !== null;
	}

	private killProcess(): void {
		if (this.process) {
			this.process.kill("SIGTERM");
			this.process = null;
		}
	}
}

export class DaemonRecorder implements Recorder {
	private readonly baseUrl: string;

	constructor() {
		this.baseUrl = process.env.VOICE_DAEMON_URL ?? "http://localhost:8765";
	}

	start(_onAutoStop: () => void): void {
		fetch(`${this.baseUrl}/record/start`, { method: "POST" }).catch(() => {
			// Silently ignore — caller will detect failure on stop()
		});
	}

	async stop(): Promise<RecordingResult> {
		try {
			const response = await fetch(`${this.baseUrl}/record/stop`, {
				method: "POST",
			});
			const data = (await response.json()) as { text?: string };
			return { audio: null, transcription: data.text };
		} catch {
			return { audio: null };
		}
	}

	cancel(): void {
		fetch(`${this.baseUrl}/record/stop`, { method: "POST" }).catch(() => {
			// Discard result
		});
	}

	getLevel(): number {
		return 0;
	}

	hasLevel(): boolean {
		return false;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2000);
			const response = await fetch(`${this.baseUrl}/health`, {
				signal: controller.signal,
			});
			clearTimeout(timeout);
			return response.ok;
		} catch {
			return false;
		}
	}
}
