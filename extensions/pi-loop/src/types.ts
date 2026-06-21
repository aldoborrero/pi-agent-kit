import type { Cron } from "croner";

export interface ParsedInterval {
	cronExpr: string;
	humanLabel: string;
	prompt: string;
	rounded?: string;
}

export interface StoredCronTask {
	id: string;
	prompt: string;
	cronExpr: string;
	recurring: boolean;
	humanLabel: string;
	createdAt: number;
	expiresAt: number;
	lastFiredAt?: number;
}

export interface RuntimeCronTask extends StoredCronTask {
	cron: Cron;
	nextFireAt: number;
	jitterMs: number;
	fireCount: number;
}
