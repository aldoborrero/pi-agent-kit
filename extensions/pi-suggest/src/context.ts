/**
 * Suggestion context gathering: repository state and workspace shape for
 * the suggestion payload. Everything is best-effort — any failure returns
 * null and the payload falls back to conversation-only context.
 */

import { loadNatives } from "@aldoborrero/pi-natives/src/natives.ts";

export interface SuggestGitContext {
	/** Branch or working-copy label; null when it could not be resolved. */
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
	/** First porcelain lines, e.g. " M src/x.ts" (bounded sample). */
	changedSample: string[];
	totalChanged: number;
}

const MAX_CHANGED_SAMPLE = 12;

/** Repository state through the native VcsRepo handle (git and jj). */
export async function gatherGitContext(cwd: string): Promise<SuggestGitContext | null> {
	const natives = await loadNatives();
	if (!natives?.vcsDiscover) return null;
	try {
		const repo = natives.vcsDiscover(cwd);
		if (!repo) return null;

		const summary = await repo.statusSummary();
		const totalChanged = summary.staged + summary.unstaged + summary.untracked;

		let changedSample: string[] = [];
		if (totalChanged > 0) {
			const porcelain = await repo.statusPorcelain({});
			changedSample = porcelain
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.slice(0, MAX_CHANGED_SAMPLE);
		}

		const branch = (await repo.asGit()?.currentBranch()) ?? (await repo.label()) ?? null;
		return {
			branch,
			staged: summary.staged,
			unstaged: summary.unstaged,
			untracked: summary.untracked,
			changedSample,
			totalChanged,
		};
	} catch {
		return null;
	}
}

/** Top-level workspace names (bounded) — helps the model name real modules. */
export async function buildWorkspaceSummary(cwd: string, maxEntries = 20): Promise<string | null> {
	const natives = await loadNatives();
	if (!natives?.listWorkspace) return null;
	try {
		const result = await natives.listWorkspace({ path: cwd, maxDepth: 1 });
		const names = result.entries
			.map((entry) => entry.path)
			.slice(0, maxEntries)
			.join(", ");
		if (!names) return null;
		return result.truncated ? `${names}, …` : names;
	} catch {
		return null;
	}
}
