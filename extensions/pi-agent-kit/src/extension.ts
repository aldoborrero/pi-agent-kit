/**
 * @aldoborrero/pi-agent-kit — aggregator extension.
 *
 * Pi activates extensions per installed package via its `pi.extensions`
 * manifest; it does not activate npm dependencies automatically. The bundle
 * therefore imports each member package's extension factory and invokes it
 * against the same Pi host.
 *
 * `@quintinshaw/pi-dynamic-workflows` and `@bacnh85/pi-subagent` are the
 * exceptions: the root manifest lists their own extension entries in
 * `pi.extensions` and Pi loads them next to this aggregator. The workflow
 * engine's package exports do not expose its entry for import at all.
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
import registerLoop from "@aldoborrero/pi-loop/src/extension.ts";
import registerNotify from "@bacnh85/pi-notify/extensions/index.js";
import registerAskUserQuestion from "@juicesharp/rpiv-ask-user-question";
import registerSandbox from "@aldoborrero/pi-sandbox/src/extension.ts";
import registerSuggest from "@aldoborrero/pi-suggest/src/extension.ts";
import registerTuicr from "@aldoborrero/pi-tuicr/src/extension.ts";
import registerUntil from "@aldoborrero/pi-until/src/extension.ts";
import registerVoice from "@aldoborrero/pi-voice/src/extension.ts";
import registerWebAccess from "pi-web-access/dist/index.js";
import registerRewind from "pi-rewind-hook/index.ts";
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
	registerLoop,
	registerNotify,
	registerAskUserQuestion,
	registerSandbox,
	registerSuggest,
	registerTuicr,
	registerUntil,
	registerVoice,
	registerWebAccess,
	registerRewind as Factory,
];

export default function (pi: ExtensionAPI): void {
	// Inside herdr, @bacnh85/pi-subagent runs every delegation as a full `pi`
	// process in a visible pane instead of in-process. Its `subagent.herdr`
	// setting is read from `ctx.settings`, which Pi does not provide, so this env
	// guard is the only switch that takes effect. Default to the in-process
	// runner; export PI_SUBAGENT_HERDR=auto before starting pi to opt back in.
	process.env.PI_SUBAGENT_HERDR ??= "off";

	once(pi, "pi-agent-kit", () => {
		for (const register of MEMBERS) {
			(register as (pi: ExtensionAPI) => void)(pi);
		}
	});
}
