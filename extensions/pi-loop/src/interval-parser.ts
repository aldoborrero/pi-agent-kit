import type { ParsedInterval } from "./types";
import { HOURLY_TASK_MINUTE_OFFSET, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from "./constants";

const DEFAULT_CRON_EXPR = "*/10 * * * *";
const DEFAULT_HUMAN_LABEL = "every 10m";

/**
 * Parse "/loop <input>" into a cron expression and prompt.
 *
 * Priority:
 * 1. Leading token: "5m check something"
 * 2. Trailing "every" clause: "check something every 5m"
 * 3. Default: 10m, entire input is the prompt
 */
export function parseLoopInput(input: string): ParsedInterval | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const leadingMatch = trimmed.match(/^(\d+)\s*(s|m|h|d)\s+(.+)$/i);
	if (leadingMatch) {
		const [, num, unit, rest] = leadingMatch;
		if (rest.trim()) {
			return intervalToCron(parseInt(num, 10), unit.toLowerCase(), rest.trim());
		}
	}

	const trailingMatch = trimmed.match(
		/^(.+?)\s+every\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)\s*$/i,
	);
	if (trailingMatch) {
		const [, rest, num, unit] = trailingMatch;
		if (rest.trim()) {
			return intervalToCron(parseInt(num, 10), normalizeUnit(unit), rest.trim());
		}
	}

	return {
		cronExpr: DEFAULT_CRON_EXPR,
		humanLabel: DEFAULT_HUMAN_LABEL,
		prompt: trimmed,
	};
}

export function estimatePeriodMs(expr: string): number {
	const parts = expr.split(/\s+/);
	if (parts.length < 5) return MS_PER_MINUTE;
	const [minute, hour, dom] = parts;
	if (minute.startsWith("*/")) return parseInt(minute.slice(2), 10) * MS_PER_MINUTE;
	if (hour.startsWith("*/")) return parseInt(hour.slice(2), 10) * MS_PER_HOUR;
	if (dom.startsWith("*/")) return parseInt(dom.slice(2), 10) * MS_PER_DAY;
	if (hour === "*" && minute !== "*") return MS_PER_HOUR;
	if (hour !== "*") return MS_PER_DAY;
	return MS_PER_MINUTE;
}

function normalizeUnit(unit: string): string {
	const u = unit.toLowerCase();
	if (u === "s" || u === "sec" || u === "second" || u === "seconds") return "s";
	if (u === "m" || u === "min" || u === "minute" || u === "minutes") return "m";
	if (u === "h" || u === "hr" || u === "hour" || u === "hours") return "h";
	if (u === "d" || u === "day" || u === "days") return "d";
	return u;
}

function intervalToCron(value: number, unit: string, prompt: string): ParsedInterval {
	let rounded: string | undefined;

	switch (unit) {
		case "s": {
			const minutes = Math.max(1, Math.ceil(value / 60));
			rounded = value < 60 ? `Rounded ${value}s up to ${minutes}m (cron minimum is 1 minute)` : undefined;
			return minutesToCron(minutes, prompt, rounded);
		}
		case "m":
			return minutesToCron(value, prompt);
		case "h": {
			if (value <= 0) value = 1;
			if (value > 23) value = 24;
			const minute = HOURLY_TASK_MINUTE_OFFSET;
			if (24 % value !== 0) {
				const nearest = findNearestDivisor(value, 24);
				rounded = `Rounded ${value}h to ${nearest}h (must divide 24 evenly)`;
				return {
					cronExpr: `${minute} */${nearest} * * *`,
					humanLabel: `every ${nearest}h`,
					prompt,
					rounded,
				};
			}
			return {
				cronExpr: `${minute} */${value} * * *`,
				humanLabel: `every ${value}h`,
				prompt,
			};
		}
		case "d": {
			if (value <= 0) value = 1;
			return {
				cronExpr: `0 0 */${value} * *`,
				humanLabel: `every ${value}d`,
				prompt,
			};
		}
		default:
			return {
				cronExpr: DEFAULT_CRON_EXPR,
				humanLabel: DEFAULT_HUMAN_LABEL,
				prompt,
			};
	}
}

function minutesToCron(minutes: number, prompt: string, rounded?: string): ParsedInterval {
	if (minutes <= 0) minutes = 1;

	if (minutes <= 59) {
		if (60 % minutes !== 0) {
			const nearest = findNearestDivisor(minutes, 60);
			rounded = `Rounded ${minutes}m to ${nearest}m (must divide 60 evenly for consistent spacing)`;
			return {
				cronExpr: `*/${nearest} * * * *`,
				humanLabel: `every ${nearest}m`,
				prompt,
				rounded,
			};
		}
		return {
			cronExpr: `*/${minutes} * * * *`,
			humanLabel: `every ${minutes}m`,
			prompt,
			rounded,
		};
	}

	const roundedHours = Math.round(minutes / 60);
	const clampedHours = Math.max(1, Math.min(roundedHours, 24));
	const nearestHours = 24 % clampedHours !== 0 ? findNearestDivisor(clampedHours, 24) : clampedHours;
	if (nearestHours !== roundedHours) {
		rounded = `Rounded ${minutes}m to ${nearestHours}h`;
	}
	const minute = HOURLY_TASK_MINUTE_OFFSET;
	return {
		cronExpr: `${minute} */${nearestHours} * * *`,
		humanLabel: `every ${nearestHours}h`,
		prompt,
		rounded,
	};
}

function findNearestDivisor(value: number, max: number): number {
	let best = 1;
	let bestDist = Math.abs(value - 1);
	for (let i = 1; i <= max; i++) {
		if (max % i === 0 && Math.abs(value - i) < bestDist) {
			best = i;
			bestDist = Math.abs(value - i);
		}
	}
	return best;
}
