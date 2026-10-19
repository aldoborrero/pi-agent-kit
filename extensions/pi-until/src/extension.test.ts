import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type FauxProviderRegistration,
} from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import untilExtension from "./extension.ts";

/** What the faux model answers to the n-th loop prompt (1-based). */
type Reply = "continue" | "success" | "error";

type Harness = {
	/** Run a slash command and wait until Pi has fully settled. */
	run(command: string): Promise<void>;
	loopPrompts(): number;
	notifications: string[];
	loopState(): { active: boolean; loopCount?: number } | undefined;
	dispose(): Promise<void>;
};

let dir: string;
let faux: FauxProviderRegistration;
const savedMaxIterations = process.env.PI_UNTIL_MAX_ITERATIONS;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-until-test-"));
	faux = registerFauxProvider();
});

afterEach(() => {
	faux.unregister();
	rmSync(dir, { recursive: true, force: true });
	if (savedMaxIterations === undefined) delete process.env.PI_UNTIL_MAX_ITERATIONS;
	else process.env.PI_UNTIL_MAX_ITERATIONS = savedMaxIterations;
});

async function createHarness(replyTo: (iteration: number) => Reply): Promise<Harness> {
	const model = faux.getModel();
	let prompts = 0;
	faux.setResponses(
		Array.from({ length: 50 }, () => (context: { messages: { role: string }[] }) => {
			// The request after signal_loop_success only wraps the run up. Pi may
			// append a system message after the tool result, so skip those.
			const last = context.messages.findLast((message) => message.role !== "system");
			if (last?.role === "toolResult") return fauxAssistantMessage("done");
			prompts++;
			switch (replyTo(prompts)) {
				case "success":
					return fauxAssistantMessage([fauxToolCall("signal_loop_success", {})], { stopReason: "toolUse" });
				case "error":
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failure" });
				default:
					return fauxAssistantMessage(`still working (${prompts})`);
			}
		}),
	);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: model.api,
		models: [{ ...model }],
	});

	let settled: (() => void) | undefined;
	let failed: ((error: Error) => void) | undefined;
	const settleWatcher = (pi: ExtensionAPI) => {
		pi.on("agent_settled", () => settled?.());
	};

	const host = await createAgentSessionRuntime(
		async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: dir,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [untilExtension, settleWatcher],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd: dir, agentDir: dir, sessionManager: SessionManager.inMemory(dir) },
	);

	const notifications: string[] = [];
	const plain = (_color: string, text: string) => text;
	await host.session.bindExtensions({
		mode: "json",
		uiContext: {
			notify: (message: string) => notifications.push(message),
			setWidget: () => {},
			setStatus: () => {},
			theme: { fg: plain, bg: plain, bold: (text: string) => text },
		} as never,
		// An extension error would otherwise leave the run waiting forever.
		onError: (error) => failed?.(new Error(`${error.event}: ${error.error}`)),
	});

	return {
		async run(command) {
			const done = new Promise<void>((resolve, reject) => {
				settled = resolve;
				failed = reject;
			});
			await host.session.prompt(command);
			await done;
		},
		loopPrompts: () => prompts,
		notifications,
		loopState() {
			const entries = host.session.sessionManager.getEntries() as {
				type: string;
				customType?: string;
				data?: { active: boolean; loopCount?: number };
			}[];
			return entries.findLast((entry) => entry.type === "custom" && entry.customType === "loop-state")?.data;
		},
		dispose: () => host.dispose(),
	};
}

describe("/until", () => {
	test("repeats the prompt until the agent signals success", async () => {
		const harness = await createHarness((iteration) => (iteration === 3 ? "success" : "continue"));
		await harness.run("/until custom the marker file exists");

		expect(harness.loopPrompts()).toBe(3);
		expect(harness.loopState()).toEqual({ active: false });
		await harness.dispose();
	});

	test("stops at the iteration cap when success never comes", async () => {
		process.env.PI_UNTIL_MAX_ITERATIONS = "4";
		const harness = await createHarness(() => "continue");
		await harness.run("/until self");

		expect(harness.loopPrompts()).toBe(4);
		expect(harness.loopState()).toEqual({ active: false });
		expect(harness.notifications).toContain("/until stopped: reached 4 iterations without success");
		await harness.dispose();
	});

	test("stops instead of retrying when a run ends with an error", async () => {
		const harness = await createHarness((iteration) => (iteration === 2 ? "error" : "continue"));
		await harness.run("/until tests");

		expect(harness.loopPrompts()).toBe(2);
		expect(harness.loopState()).toEqual({ active: false });
		expect(harness.notifications).toContain("/until stopped: the last run ended with an error");
		await harness.dispose();
	});
});
