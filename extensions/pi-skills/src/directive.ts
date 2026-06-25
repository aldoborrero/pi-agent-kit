/**
 * Pure directive logic for skill command interpolation — no pi-tui / runtime
 * deps, so it can be imported by both the skill loader (extension.ts) and
 * startup safety checks.
 *
 * A `!`cmd`` directive embeds live command output into a skill at load time.
 * Safety policy:
 *   - shell metacharacters → unsafe (chaining/expansion)
 *   - matches any dangerous command pattern → unsafe
 *   - otherwise → safe to run
 */

export interface CommandDirective {
	start: number;
	end: number;
	command: string;
}

// !`...` not preceded by a backslash; command is single-line, no backticks.
const DIRECTIVE_RE = /(^|[^\\])!`([^`\n]+)`/g;

/** Locate all !`cmd` directives with their source spans (escaped \!`…` skipped). */
export function findCommandDirectives(content: string): CommandDirective[] {
	const hits: CommandDirective[] = [];
	for (const m of content.matchAll(DIRECTIVE_RE)) {
		const lead = m[1] ?? "";
		const start = (m.index ?? 0) + lead.length; // skip the captured lead char
		hits.push({
			start,
			end: start + m[0].length - lead.length,
			command: m[2]!.trim(),
		});
	}
	return hits;
}

/** Replace the [start, end) slice of `s` with `text`. */
export function replaceSpan(
	s: string,
	start: number,
	end: number,
	text: string,
): string {
	return s.slice(0, start) + text + s.slice(end);
}

const SHELL_META_RE = /[;|&$`><(){}\n]/;

/** True when the command contains shell metacharacters (chaining/expansion). */
export function hasShellMeta(command: string): boolean {
	return SHELL_META_RE.test(command);
}

/** Minimal argv tokenizer: whitespace-split with single/double quote support. */
export function tokenizeCommand(command: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const m of command.matchAll(re)) {
		out.push(m[1] ?? m[2] ?? m[3] ?? "");
	}
	return out;
}

// ─── Dangerous command classifier ────────────────────────────────────────────

export interface ClassificationHit {
	severity: "critical" | "dangerous" | "risky";
	reason: string;
}

/**
 * Built-in dangerous command patterns. Since shell metacharacters are already
 * blocked (no pipes, redirects, chaining), these patterns catch standalone
 * commands that can cause irreversible damage.
 */
const DANGEROUS_PATTERNS: Array<{
	pattern: RegExp;
	severity: ClassificationHit["severity"];
	reason: string;
}> = [
	// Critical — irreversible system damage
	{
		pattern: /\brm\s+(-\w*[rf]\w*|--force|--recursive)\b/,
		severity: "critical",
		reason: "recursive or forced file deletion",
	},
	{
		pattern: /\bmkfs\b/,
		severity: "critical",
		reason: "filesystem formatting",
	},
	{
		pattern: /\bdd\b/,
		severity: "critical",
		reason: "raw disk operations",
	},
	{
		pattern: /\b(shutdown|reboot|halt|poweroff)\b/,
		severity: "critical",
		reason: "system power control",
	},
	{
		pattern: /\bkill\s+(-9\s+)?-1\b/,
		severity: "critical",
		reason: "kill all processes",
	},
	{
		pattern: /\bfdisk\b/,
		severity: "critical",
		reason: "disk partition manipulation",
	},
	{
		pattern: /\bwipe\b/,
		severity: "critical",
		reason: "secure disk wiping",
	},
	{
		pattern: /\bshred\b/,
		severity: "critical",
		reason: "secure file shredding",
	},

	// Dangerous — significant risk
	{
		pattern: /\bchmod\s+(-R\s+)?0?777\b/,
		severity: "dangerous",
		reason: "world-writable permissions",
	},
	{
		pattern: /\bchown\s+-R\b/,
		severity: "dangerous",
		reason: "recursive ownership change",
	},
	{
		pattern: /\b(systemctl|service)\s+(stop|disable|mask)\b/,
		severity: "dangerous",
		reason: "stopping/disabling system services",
	},
	{
		pattern: /\b(iptables|ufw)\s+(-F|--flush)\b/,
		severity: "dangerous",
		reason: "flushing firewall rules",
	},

	// Risky — could cause issues but not catastrophic
	{
		pattern: /\bgit\s+push\s+(-f|--force)\b/,
		severity: "risky",
		reason: "force-pushing overwrites remote history",
	},
	{
		pattern: /\bgit\s+reset\s+--hard\b/,
		severity: "risky",
		reason: "hard reset discards uncommitted changes",
	},
	{
		pattern: /\bgit\s+clean\s+(-\w*d\w*|--directory)\b/,
		severity: "risky",
		reason: "cleaning untracked files/directories",
	},
];

/**
 * Classify a single command against the safety policy.
 * Returns a reason string when the command is UNSAFE, or null when safe.
 */
export function directiveBlockReason(command: string): string | null {
	if (hasShellMeta(command)) {
		return "shell metacharacters not allowed in skill commands";
	}
	const hit = classify(command);
	if (hit) return `${hit.severity} — ${hit.reason}`;
	return null;
}

/** Classify a command against built-in dangerous command patterns. */
export function classify(command: string): ClassificationHit | null {
	for (const rule of DANGEROUS_PATTERNS) {
		if (rule.pattern.test(command)) {
			return { severity: rule.severity, reason: rule.reason };
		}
	}
	return null;
}

export interface UnsafeDirective {
	command: string;
	reason: string;
}

/** Return every unsafe directive found in a skill's content. */
export function scanUnsafeDirectives(content: string): UnsafeDirective[] {
	const unsafe: UnsafeDirective[] = [];
	for (const d of findCommandDirectives(content)) {
		const reason = directiveBlockReason(d.command);
		if (reason) unsafe.push({ command: d.command, reason });
	}
	return unsafe;
}
