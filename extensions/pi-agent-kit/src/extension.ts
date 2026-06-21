/**
 * @aldoborrero/pi-agent-kit — aggregator extension.
 *
 * Imports and activates every individual pi-* extension factory.
 * One `pi install @aldoborrero/pi-agent-kit` boots all of them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAstGrep from "../../extensions/pi-ast-grep/src/extension.ts";
import registerBitwarden from "../../extensions/pi-bitwarden/src/extension.ts";
import registerBtw from "../../extensions/pi-btw/src/extension.ts";
import registerCodex from "../../extensions/pi-codex/src/extension.ts";
import registerContext from "../../extensions/pi-context/src/extension.ts";
import registerDiff from "../../extensions/pi-diff/src/extension.ts";
import registerDirenv from "../../extensions/pi-direnv/src/extension.ts";
import registerExit from "../../extensions/pi-exit/src/extension.ts";
import registerFooter from "../../extensions/pi-footer/src/extension.ts";
import registerGitCheckpoint from "../../extensions/pi-git-checkpoint/src/extension.ts";
import registerGithubSearch from "../../extensions/pi-github-search/src/extension.ts";
import registerInlineBash from "../../extensions/pi-inline-bash/src/extension.ts";
import registerLoop from "../../extensions/pi-loop/src/extension.ts";
import registerNotify from "../../extensions/pi-notify/src/extension.ts";
import registerQuestionnaire from "../../extensions/pi-questionnaire/src/extension.ts";
import registerSandbox from "../../extensions/pi-sandbox/src/extension.ts";
import registerSubagent from "../../extensions/pi-subagent/src/extension.ts";
import registerSuggest from "../../extensions/pi-suggest/src/extension.ts";
import registerTuicr from "../../extensions/pi-tuicr/src/extension.ts";
import registerUntil from "../../extensions/pi-until/src/extension.ts";
import registerVoice from "../../extensions/pi-voice/src/extension.ts";
import registerWalkie from "../../extensions/pi-walkie/src/extension.ts";
import registerWebTools from "../../extensions/pi-web-tools/src/extension.ts";
import registerWorkflows from "../../extensions/pi-workflows/src/extension.ts";

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