export interface TranscribeOptions {
	/** MIME type of the audio blob (default: "audio/wav") */
	mimeType?: string;
	/** Filename sent to the API (default: "recording.wav") */
	filename?: string;
}

export interface STTProvider {
	transcribe(audio: Buffer, lang: string, hints: string, opts?: TranscribeOptions): Promise<string>;
	isAvailable(): Promise<boolean>;
}

export class GroqProvider implements STTProvider {
	private apiKey: string;

	constructor() {
		this.apiKey = process.env.GROQ_API_KEY ?? "";
	}

	async transcribe(audio: Buffer, lang: string, hints: string, opts?: TranscribeOptions): Promise<string> {
		const mimeType = opts?.mimeType ?? "audio/wav";
		const filename = opts?.filename ?? "recording.wav";
		const form = new FormData();
		form.append("file", new Blob([audio], { type: mimeType }), filename);
		form.append("model", "whisper-large-v3");
		form.append("language", lang);
		form.append("prompt", hints);

		const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
			method: "POST",
			headers: { Authorization: `Bearer ${this.apiKey}` },
			body: form,
			signal: AbortSignal.timeout(15000),
		});

		if (!res.ok) {
			throw new Error(`Groq STT failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as { text: string };
		return data.text;
	}

	async isAvailable(): Promise<boolean> {
		return !!process.env.GROQ_API_KEY;
	}
}

export class OpenAIProvider implements STTProvider {
	private apiKey: string;

	constructor() {
		this.apiKey = process.env.OPENAI_API_KEY ?? "";
	}

	async transcribe(audio: Buffer, lang: string, hints: string, opts?: TranscribeOptions): Promise<string> {
		const mimeType = opts?.mimeType ?? "audio/wav";
		const filename = opts?.filename ?? "recording.wav";
		const form = new FormData();
		form.append("file", new Blob([audio], { type: mimeType }), filename);
		form.append("model", "whisper-1");
		form.append("language", lang);
		form.append("prompt", hints);

		const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: { Authorization: `Bearer ${this.apiKey}` },
			body: form,
			signal: AbortSignal.timeout(15000),
		});

		if (!res.ok) {
			throw new Error(`OpenAI STT failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as { text: string };
		return data.text;
	}

	async isAvailable(): Promise<boolean> {
		return !!process.env.OPENAI_API_KEY;
	}
}

export class DaemonProvider implements STTProvider {
	private baseUrl: string;

	constructor() {
		this.baseUrl = process.env.VOICE_DAEMON_URL ?? "http://localhost:8765";
	}

	async transcribe(audio: Buffer, lang: string, _hints: string, opts?: TranscribeOptions): Promise<string> {
		const mimeType = opts?.mimeType ?? "audio/wav";
		const filename = opts?.filename ?? "recording.wav";

		const form = new FormData();
		form.append("file", new Blob([audio], { type: mimeType }), filename);

		const url = new URL(`${this.baseUrl}/transcribe`);
		url.searchParams.set("language", lang);

		const res = await fetch(url.toString(), {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(30000),
		});

		if (!res.ok) {
			throw new Error(`Daemon transcribe failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as { text?: string; transcription?: string };
		return data.text ?? data.transcription ?? "";
	}

	async isAvailable(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/health`, {
				signal: AbortSignal.timeout(2000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}
}

export type ProviderName = "groq" | "openai" | "daemon";

export function createProvider(name: ProviderName): STTProvider {
	switch (name) {
		case "groq":
			return new GroqProvider();
		case "openai":
			return new OpenAIProvider();
		case "daemon":
			return new DaemonProvider();
	}
}

export function detectProvider(): { name: ProviderName; provider: STTProvider } | null {
	if (process.env.VOICE_DAEMON_URL) {
		return { name: "daemon", provider: new DaemonProvider() };
	}
	if (process.env.GROQ_API_KEY) {
		return { name: "groq", provider: new GroqProvider() };
	}
	if (process.env.OPENAI_API_KEY) {
		return { name: "openai", provider: new OpenAIProvider() };
	}
	return null;
}
