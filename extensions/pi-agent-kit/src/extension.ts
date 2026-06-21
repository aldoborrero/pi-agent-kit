/**
 * @aldoborrero/pi-agent-kit — aggregator extension.
 *
 * Imports and activates every individual pi-* extension factory.
 * One `pi install @aldoborrero/pi-agent-kit` boots all of them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAstGrep from "../../pi-ast-grep/src/extension.ts";
import registerBitwarden from "../../pi-bitwarden/src/extension.ts";
import registerBtw from "../../pi-btw/src/extension.ts";
import registerCodex from "../../pi-codex/src/extension.ts";
import registerContext from "../../pi-context/src/extension.ts";
import registerDiff from "../../pi-diff/src/extension.ts";
import registerDirenv from "../../pi-direnv/src/extension.ts";
import registerExit from "../../pi-exit/src/extension.ts";
import registerFooter from "../../pi-footer/src/extension.ts";
import registerGitCheckpoint from "../../pi-git-checkpoint/src/extension.ts";
import registerGithubSearch from "../../pi-github-search/src/extension.ts";
import registerInlineBash from "../../pi-inline-bash/src/extension.ts";
import registerLoop from "../../pi-loop/src/extension.ts";
import registerNotify from "../../pi-notify/src/extension.ts";
import registerQuestionnaire from "../../pi-questionnaire/src/extension.ts";
import registerSandbox from "../../pi-sandbox/src/extension.ts";
import registerSubagent from "../../pi-subagent/src/extension.ts";
import registerSuggest from "../../pi-suggest/src/extension.ts";
import registerTuicr from "../../pi-tuicr/src/extension.ts";
import registerUntil from "../../pi-until/src/extension.ts";
import registerVoice from "../../pi-voice/src/extension.ts";
import registerWalkie from "../../pi-walkie/src/extension.ts";
import registerWebTools from "../../pi-web-tools/src/extension.ts";
import registerWorkflows from "../../pi-workflows/src/extension.ts";

type Factory = (pi: never) => void;

const MEMBERS: Factory[] = [
  registerAstGrep,
  registerBitwarden,
  registerBtw,
  registerCodex,
  registerContext,
  registerDiff,
  registerDirenv,
  registerExit,
  registerFooter,
  registerGitCheckpoint,
  registerGithubSearch,
  registerInlineBash,
  registerLoop,
  registerNotify,
  registerQuestionnaire,
  registerSandbox,
  registerSubagent,
  registerSuggest,
  registerTuicr,
  registerUntil,
  registerVoice,
  registerWalkie,
  registerWebTools,
  registerWorkflows,
];

export default function (pi: ExtensionAPI): void {
  for (const register of MEMBERS) {
    (register as (pi: ExtensionAPI) => void)(pi);
  }
}