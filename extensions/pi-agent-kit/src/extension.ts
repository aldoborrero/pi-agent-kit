/**
 * @aldoborrero/pi-agent-kit — aggregator extension.
 *
 * Pi activates extensions per installed package via its `pi.extensions`
 * manifest; it does not activate npm dependencies automatically. The bundle
 * therefore imports each member package's extension factory and invokes it
 * against the same Pi host.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerAlias from "@aldoborrero/pi-alias/src/extension.ts";
import registerAstGrep from "@aldoborrero/pi-ast-grep/src/extension.ts";
import registerBitwarden from "@aldoborrero/pi-bitwarden/src/extension.ts";
import registerBtw from "@aldoborrero/pi-btw/src/extension.ts";
import registerCodex from "@aldoborrero/pi-codex/src/extension.ts";
import registerContext from "@aldoborrero/pi-context/src/extension.ts";
import registerDiff from "@aldoborrero/pi-diff/src/extension.ts";
import registerDirenv from "@aldoborrero/pi-direnv/src/extension.ts";
import registerEdit from "@aldoborrero/pi-edit/src/extension.ts";
import registerGithubSearch from "@aldoborrero/pi-github-search/src/extension.ts";
import registerFooter from "@aldoborrero/pi-footer/src/extension.ts";
import registerGitCheckpoint from "@aldoborrero/pi-git-checkpoint/src/extension.ts";
import registerInlineBash from "@aldoborrero/pi-inline-bash/src/extension.ts";
import registerLoop from "@aldoborrero/pi-loop/src/extension.ts";
import registerNotify from "@aldoborrero/pi-notify/src/extension.ts";
import registerQuestionnaire from "@aldoborrero/pi-questionnaire/src/extension.ts";
import registerSandbox from "@aldoborrero/pi-sandbox/src/extension.ts";
import registerSkills from "@aldoborrero/pi-skills/src/extension.ts";
import registerSubagent from "@aldoborrero/pi-subagent/src/extension.ts";
import registerSuggest from "@aldoborrero/pi-suggest/src/extension.ts";
import registerTelegram from "@aldoborrero/pi-telegram/src/extension.ts";
import registerTuicr from "@aldoborrero/pi-tuicr/src/extension.ts";
import registerUntil from "@aldoborrero/pi-until/src/extension.ts";
import registerVoice from "@aldoborrero/pi-voice/src/extension.ts";
import {
	createEffortState,
	createWorkflowStorage,
	createWorkflowTool,
	installResultDelivery,
	installTaskPanel,
	installWorkflowEditor,
	loadWorkflowSettings,
	registerAllSavedWorkflows,
	registerBuiltinWorkflows,
	registerEffortCommand,
	registerWorkflowCommands,
	registerWorkflowModelsCommand,
	saveWorkflowSettingsForCwd,
	WorkflowManager,
} from "@quintinshaw/pi-dynamic-workflows";
import { once } from "./once.ts";

function registerDynamicWorkflows(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const storage = createWorkflowStorage(cwd);
	const settings = loadWorkflowSettings({ cwd });
	const manager = new WorkflowManager({
		cwd,
		loadSavedWorkflow: (name) => storage.load(name)?.script,
		defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
		concurrency: settings.defaultConcurrency,
		defaultAgentRetries: settings.defaultAgentRetries,
	});

	const workflowTool = createWorkflowTool({ cwd, manager, storage });
	pi.registerTool(workflowTool);

	const effort = createEffortState();
	registerWorkflowCommands(pi, manager, { storage, cwd, effort });
	registerWorkflowModelsCommand(pi);
	registerBuiltinWorkflows(pi, { cwd });
	registerAllSavedWorkflows(pi, cwd, storage, manager);
	registerEffortCommand(pi, effort);

	let editorInstalled = false;
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		const active = pi.getActiveTools();
		if (!active.includes(workflowTool.name)) {
			pi.setActiveTools([...active, workflowTool.name]);
		}
		manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		try {
			manager.setSessionId(ctx.sessionManager?.getSessionId());
		} catch {
			// sessionManager may be unavailable in some contexts — fall back to global history.
		}
		installResultDelivery(pi, manager);
		installTaskPanel(pi, manager, ctx.ui, { storage, cwd, loadSettings: () => loadWorkflowSettings({ cwd }) });
		if (!editorInstalled) {
			installWorkflowEditor(pi, ctx.ui, effort, {
				settingsStore: {
					load: () => loadWorkflowSettings({ cwd }),
					save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
				},
			});
			editorInstalled = true;
		}
	});
}

type Factory = (pi: never) => void;

const MEMBERS: Factory[] = [
	registerAlias,
	registerAstGrep,
	registerBitwarden,
	registerBtw,
	registerCodex,
	registerContext,
	registerDiff,
	registerDirenv,
	registerEdit,
	registerFooter,
	registerGithubSearch,
	registerGitCheckpoint,
	registerInlineBash,
	registerLoop,
	registerNotify,
	registerQuestionnaire,
	registerSandbox,
	registerSkills,
	registerSubagent,
	registerSuggest,
	registerTelegram,
	registerTuicr,
	registerUntil,
	registerVoice,
	registerDynamicWorkflows as Factory,
];

export default function (pi: ExtensionAPI): void {
	once(pi, "pi-agent-kit", () => {
		for (const register of MEMBERS) {
			(register as (pi: ExtensionAPI) => void)(pi);
		}
	});
}
