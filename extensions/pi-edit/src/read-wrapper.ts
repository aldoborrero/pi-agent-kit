/**
 * `read` tool wrapper — the read half of the hashline edit protocol.
 *
 * Replaces Pi's built-in `read` (deliberate, same contract: identical
 * TypeBox schema, identical output) and prepends the hashline snapshot
 * header `[displayPath#TAG]` to successful text reads. The tag comes from
 * the native EditStore and is what `edit`'s hashline payload anchors on —
 * the engine rejects payloads whose tag no longer matches (stale reads).
 *
 * Registered only when the native addon is available AND hashline mode is
 * enabled (PI_EDIT_HASHLINE / nativeEdit.hashline.enabled). Without the
 * wrapper, hashline mode has no anchor source and is not offered.
 */

import { isAbsolute, join } from "node:path";
import { createReadTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hashlineSnapshotTag } from "./native-engine.ts";

/** Resolve a read-tool path parameter to an absolute path. */
function absolutePathFor(path: string, cwd: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

/** Display path: relative to cwd when possible (keeps tags short/stable). */
function displayPathFor(path: string, cwd: string): string {
	const absolute = absolutePathFor(path, cwd);
	if (absolute === cwd || !cwd.startsWith("/")) return absolute;
	return absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
}

/**
 * Build the registered `read` tool definition: delegates to Pi's own read
 * implementation, then tags the output. Never throws for snapshot failures —
 * an untagged read is just a plain read.
 */
export function createHashlineReadDefinition(cwd: string) {
	const native = createReadTool(cwd);
	return {
		...native,
		async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const result = await native.execute(toolCallId, params, signal, onUpdate, ctx);
			const first = result.content[0];
			if (first?.type !== "text") return result;
			const absolute = absolutePathFor(params.path, ctx.cwd);
			const tag = hashlineSnapshotTag(absolute);
			if (!tag) return result;
			const header = `[${displayPathFor(params.path, ctx.cwd)}#${tag}]`;
			return {
				...result,
				content: [{ type: "text" as const, text: `${header}\n${first.text}` }, ...result.content.slice(1)],
			};
		},
	};
}