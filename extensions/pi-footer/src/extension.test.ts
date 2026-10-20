import { describe, expect, test } from "bun:test";
import { createUiColors } from "@aldoborrero/pi-common";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type FooterState,
	latestCacheHitRate,
	renderFooter,
	resolveContextUsage,
	resolveRoutedModel,
	sumSessionUsage,
} from "./extension.ts";

// Colours are irrelevant to layout: render plain text.
const colors = createUiColors({ fg: (_color: string, text: string) => text } as never);

const usage = (input: number, output: number, cost: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { total: cost },
});

function footerState(overrides: Partial<FooterState> = {}): FooterState {
	return {
		workspace: {
			shortCwd: "~/projects/service",
			branch: "main",
			git: { dirty: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 },
		},
		context: { tokens: 33_000, window: 272_000, percent: 12 },
		model: { id: "gpt-6.1-sol", thinking: "high" },
		session: { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
		cost: { totalUsd: 0 },
		statuses: [],
		customLeft: [],
		customRight: [],
		...overrides,
	};
}

const status = (key: string, text: string) => ({ key, raw: text, text, priority: "info" as const });
const render = (
	state: FooterState,
	width: number,
	statusLine: "auto" | "always" = "auto",
	tokenVisibility: "on" | "off" = "off",
) => renderFooter(state, width, colors, { tokenVisibility, liveTps: null, statusLine });

describe("sumSessionUsage", () => {
	test("counts everything the session paid for, not only finished assistant messages", () => {
		const totals = sumSessionUsage([
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", usage: usage(100, 10, 0.01) } },
			// Aborted responses and tool-result usage are billed too.
			{ type: "message", message: { role: "assistant", usage: usage(200, 20, 0.02) } },
			{ type: "message", message: { role: "toolResult", usage: usage(50, 5, 0.005) } },
			{ type: "usage", usage: usage(1000, 0, 0.1) },
			{ type: "compaction", usage: usage(3000, 300, 0.3) },
			{ type: "branch_summary", usage: usage(400, 40, 0.04) },
			{ type: "compaction" },
			{ type: "custom" },
		]);

		expect(totals.input).toBe(4750);
		expect(totals.output).toBe(375);
		expect(totals.cost).toBeCloseTo(0.475);
	});
});

describe("latestCacheHitRate", () => {
	const cached = (input: number, cacheRead: number, cacheWrite: number) => ({
		type: "message",
		message: { role: "assistant", usage: { input, output: 5, cacheRead, cacheWrite, cost: { total: 0 } } },
	});

	test("is the cached share of the latest prompt", () => {
		expect(latestCacheHitRate([cached(1000, 0, 0), cached(100, 600, 300)])).toBe(60);
	});

	test("is undefined before any response or for an empty prompt", () => {
		expect(latestCacheHitRate([{ type: "message", message: { role: "user" } }])).toBeUndefined();
		expect(latestCacheHitRate([cached(0, 0, 0)])).toBeUndefined();
	});
});

describe("resolveRoutedModel", () => {
	const reply = (model: string, stopReason = "stop", thinkingLevel?: string) => ({
		type: "message",
		message: { role: "assistant", model, stopReason, thinkingLevel },
	});

	test("names the physical model behind the latest usable response of a virtual model", () => {
		const branch = [reply("gpt-5.6-luna", "stop", "medium"), reply("gpt-6.1-sol", "error")];

		expect(resolveRoutedModel({ api: "pi-virtual" }, branch)).toEqual({ id: "gpt-5.6-luna", thinking: "medium" });
	});

	test("does not apply to physical models or before the first response", () => {
		expect(resolveRoutedModel({ api: "openai-responses" }, [reply("gpt-6.1-sol")])).toBeUndefined();
		expect(resolveRoutedModel({ api: "pi-virtual" }, [])).toBeUndefined();
	});
});

describe("resolveContextUsage", () => {
	const staleBranch = [{ type: "message", message: { role: "assistant", usage: usage(200_000, 1000, 1) } }];

	test("reports usage as unknown after compaction instead of the pre-compaction size", () => {
		const context = resolveContextUsage({
			getContextUsage: () => ({ tokens: null, contextWindow: 272_000, percent: null }),
			sessionManager: { getBranch: () => staleBranch },
		});

		expect(context).toEqual({ tokens: null, window: 272_000, percent: null });
	});

	test("uses Pi's own figures when it has them", () => {
		const context = resolveContextUsage({
			getContextUsage: () => ({ tokens: 27_200, contextWindow: 272_000, percent: 10 }),
			sessionManager: { getBranch: () => staleBranch },
		});

		expect(context).toEqual({ tokens: 27_200, window: 272_000, percent: 10 });
	});

	test("estimates from the last response when Pi cannot report usage", () => {
		const context = resolveContextUsage({
			sessionManager: { getBranch: () => staleBranch },
			model: { contextWindow: 402_000 },
		});

		expect(context.tokens).toBe(201_000);
		expect(context.percent).toBe(50);
	});
});

describe("renderFooter", () => {
	test("keeps a status inline when it fits", () => {
		const lines = render(footerState({ statuses: [status("vault", "vault:locked")] }), 120);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("vault:locked");
	});

	test("moves statuses to a second line rather than hiding them", () => {
		const statuses = [status("vault", "vault:locked"), status("rewind", "6 points / 1 snapshots")];
		const state = footerState({
			workspace: { ...footerState().workspace, branch: "feature/a-rather-long-branch-name" },
			statuses,
		});

		for (const width of [110, 80, 56]) {
			const lines = render(state, width);
			expect(lines).toHaveLength(2);
			expect(lines[1]).toContain("vault:locked");
			expect(lines[1]).toContain("6 points / 1 snapshots");
			expect(lines[1]).not.toContain("+");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("keeps the same height while a turn streams and after it ends", () => {
		const state = footerState({
			session: { totals: { input: 22_000, output: 17_000, cacheRead: 26_000, cacheWrite: 22_000, cost: 0 } },
			statuses: [status("vault", "vault:locked"), status("rewind", "6 points / 1 snapshots")],
		});

		for (const width of [200, 170, 150, 130, 120, 100]) {
			const streaming = renderFooter(state, width, colors, {
				tokenVisibility: "on",
				liveTps: "42 t/s",
				statusLine: "auto",
			});
			expect(render(state, width)).toHaveLength(streaming.length);
		}
	});

	test("puts statuses on their own line when asked to, even if they would fit", () => {
		const lines = render(footerState({ statuses: [status("vault", "vault:locked")] }), 120, "always");

		expect(lines).toHaveLength(2);
		expect(lines[0]).not.toContain("vault:locked");
		expect(lines[1]).toContain("vault:locked");
	});

	test("stays on one line without statuses", () => {
		expect(render(footerState(), 120)).toHaveLength(1);
		expect(render(footerState(), 120, "always")).toHaveLength(1);
	});

	test("shows the whole branch name when there is room", () => {
		const state = footerState({
			workspace: { ...footerState().workspace, branch: "feature/a-rather-long-branch-name" },
		});

		expect(render(state, 150)[0]).toContain("feature/a-rather-long-branch-name");
	});

	test("shortens the branch before dropping the git markers", () => {
		const state = footerState({
			workspace: {
				shortCwd: "~/projects/service",
				branch: "feature/a-rather-long-branch-name*",
				git: { dirty: true, staged: 1, unstaged: 2, untracked: 3, ahead: 0, behind: 0 },
			},
		});
		const [line] = render(state, 78);

		expect(line).not.toContain("feature/a-rather-long-branch-name");
		expect(line).toContain("…");
		expect(line).toContain("+1 ✗2 ?3");
		expect(visibleWidth(line)).toBeLessThanOrEqual(78);
	});

	describe("details taken from Pi's own footer", () => {
		const detailed = footerState({
			autoCompact: true,
			model: {
				id: "auto",
				thinking: "high",
				provider: "openai-codex",
				routed: { id: "gpt-5.6-luna", thinking: "medium" },
			},
			session: {
				totals: { input: 22_000, output: 17_000, cacheRead: 26_000, cacheWrite: 22_000, cost: 1.5 },
				cacheHitRate: 58.4,
			},
			cost: { totalUsd: 1.5, subscription: true },
		});

		test("show in the widest layout", () => {
			const [line] = render(detailed, 170, "auto", "on");

			expect(line).toContain("12% 33k/272k (auto)");
			expect(line).toContain("R26k W22k CH58%");
			expect(line).toContain("$1.50 (sub)");
			expect(line).toContain("(openai-codex) auto · high → gpt-5.6-luna · med");
		});

		test("give way to the essentials when the terminal is narrower", () => {
			const [line] = render(detailed, 100, "auto", "on");

			expect(line).not.toContain("(auto)");
			expect(line).not.toContain("(openai-codex)");
			expect(line).toContain("→ gpt-5.6-luna");
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		});

		test("mark a subscription even before anything was spent", () => {
			const state = footerState({ cost: { totalUsd: 0, subscription: true } });

			expect(render(state, 150)[0]).toContain("$0.00 (sub)");
			expect(render(footerState(), 150)[0]).not.toContain("$");
		});

		test("say nothing about compaction when it is off or unknown", () => {
			expect(render(footerState({ autoCompact: false }), 150)[0]).not.toContain("(auto)");
			expect(render(footerState(), 150)[0]).not.toContain("(auto)");
		});
	});

	test("shows unknown context usage as a question mark", () => {
		const [line] = render(footerState({ context: { tokens: null, window: 272_000, percent: null } }), 120);

		expect(line).toContain("?/272k");
		expect(line).not.toContain("%");
	});
});
