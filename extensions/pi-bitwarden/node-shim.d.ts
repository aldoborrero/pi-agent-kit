declare module "node:child_process" {
	export function execSync(command: string, options?: { encoding?: string; stdio?: string | string[]; timeout?: number }): string;
	export function spawn(command: string, args?: string[], options?: { stdio?: string[] | string }): {
		stdout?: { on(event: string, cb: (chunk: Buffer | string) => void): void };
		stderr?: { on(event: string, cb: (chunk: Buffer | string) => void): void };
		on(event: string, cb: (...args: any[]) => void): void;
		kill(): void;
	};
}

declare interface Buffer {
	toString(encoding?: string): string;
}
