declare module "node:fs" {
	export function readFileSync(path: string, encoding: string): string;
}

declare module "node:fs/promises" {
	export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	export function writeFile(path: string, data: string, encoding: string): Promise<void>;
}

declare module "node:path" {
	export function dirname(path: string): string;
	export function join(...parts: string[]): string;
}

declare const process: {
	env: Record<string, string | undefined>;
};
