/**
 * @aldoborrero/pi-agent-kit — aggregator extension.
 *
 * Pi activates extensions per installed package via its `pi.extensions`
 * manifest; it does not activate npm dependencies automatically. The bundle
 * therefore imports each member package's extension factory and invokes it
 * against the same Pi host.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAlias from "@aldoborrero/pi-alias/src/extension.ts";
import registerAstGrep from "@aldoborrero/pi-ast-grep/src/extension.ts";
import registerBitwarden from "@aldoborrero/pi-bitwarden/src/extension.ts";
import registerBtw from "@aldoborrero/pi-btw/src/extension.ts";
import registerCodex from "@aldoborrero/pi-codex/src/extension.ts";
import registerContext from "@aldoborrero/pi-context/src/extension.ts";
import registerDiff from "@aldoborrero/pi-diff/src/extension.ts";
import registerDirenv from "@aldoborrero/pi-direnv/src/extension.ts";
import registerEdit from "@aldoborrero/pi-edit/src/extension.ts";
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
import registerWorkflows from "@aldoborrero/pi-workflows/src/extension.ts";
import { once } from "./once.ts";

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
	registerWorkflows,
];

export default function (pi: ExtensionAPI): void {
	once(pi, "pi-agent-kit", () => {
		for (const register of MEMBERS) {
			(register as (pi: ExtensionAPI) => void)(pi);
		}
	});
}
