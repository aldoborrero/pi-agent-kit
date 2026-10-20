import { describe, expect, test } from "bun:test";
import { loadNatives } from "@aldoborrero/pi-natives/src/natives.ts";
import { NativeRecorder, buildWavHeader, computeRms, pcmFloat32ToS16Le } from "./recorder.ts";

describe("pcmFloat32ToS16Le", () => {
	test("converts known values with clamping", () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5]);
		const buf = pcmFloat32ToS16Le(samples);
		expect(buf.length).toBe(samples.length * 2);
		expect(buf.readInt16LE(0 * 2)).toBe(0);
		expect(buf.readInt16LE(1 * 2)).toBe(Math.round(0.5 * 0x7fff));
		expect(buf.readInt16LE(2 * 2)).toBe(Math.round(-0.5 * 0x7fff));
		expect(buf.readInt16LE(3 * 2)).toBe(0x7fff); // +1 clamps to max
		expect(buf.readInt16LE(4 * 2)).toBe(-0x7fff + 1 === 0 ? 0 : Math.round(-1 * 0x7fff)); // -1
		expect(buf.readInt16LE(5 * 2)).toBe(0x7fff); // +1.5 clamps
		expect(buf.readInt16LE(6 * 2)).toBe(Math.round(-1 * 0x7fff)); // -1.5 clamps
	});

	test("round-trips through the WAV header packaging", () => {
		const samples = new Float32Array(1600); // 100 ms at 16 kHz
		for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000);
		const raw = pcmFloat32ToS16Le(samples);
		const wav = Buffer.concat([buildWavHeader(raw.length), raw]);
		// RIFF header sanity: same contract SpawnRecorder produces
		expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
		expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
		expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
		expect(wav.readUInt32LE(40)).toBe(raw.length); // data size
		expect(wav.length).toBe(44 + raw.length);
	});

	test("empty input yields empty raw buffer", () => {
		expect(pcmFloat32ToS16Le(new Float32Array(0)).length).toBe(0);
	});
});

describe("NativeRecorder", () => {
	test("isAvailable mirrors natives availability", async () => {
		const natives = await loadNatives();
		const recorder = new NativeRecorder(natives);
		expect(await recorder.isAvailable()).toBe(natives !== null);
	});

	test("start without natives throws a clear error", () => {
		const recorder = new NativeRecorder(null);
		expect(() => recorder.start(() => {})).toThrow(/Native audio unavailable/);
	});

	test("stop() after start-less state produces a valid WAV header", async () => {
		const natives = await loadNatives();
		const recorder = new NativeRecorder(natives);
		const result = await recorder.stop();
		expect(result.audio.length).toBe(44);
		expect(result.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
	});

	test("RMS metering works on converted chunks", () => {
		const loud = pcmFloat32ToS16Le(new Float32Array(160).fill(0.9));
		const quiet = pcmFloat32ToS16Le(new Float32Array(160).fill(0.001));
		expect(computeRms(loud)).toBeGreaterThan(computeRms(quiet));
	});
});