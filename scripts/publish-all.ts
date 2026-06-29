#!/usr/bin/env bun
/**
 * Publish all public workspace packages whose name@version is not on npm yet.
 *
 * This is intentionally idempotent for monorepo releases:
 * - reads package.json files from root workspaces (extensions/*)
 * - skips private packages
 * - checks the npm registry before publishing
 * - publishes only missing versions
 *
 * Usage:
 *   bun run publish:all
 *   bun run publish:dry
 *   PUBLISH_CONCURRENCY=4 bun run publish:all
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

interface PackageJson {
	name?: string;
	version?: string;
	private?: boolean;
	workspaces?: string[];
}

interface PackageInfo {
	dir: string;
	name: string;
	version: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = readPackageJson(join(root, "package.json"));
const concurrency = Math.max(1, Number(process.env.PUBLISH_CONCURRENCY ?? "6"));
const dryRun = process.argv.includes("--dry-run");
const publishFlags = ["--access", "public"];

if (dryRun) publishFlags.push("--dry-run");
if (process.env.NPM_CONFIG_PROVENANCE === "true") publishFlags.push("--provenance");

function readPackageJson(path: string): PackageJson {
	return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function workspacePackageDirs(pattern: string): string[] {
	// This repo currently uses simple one-level workspace globs such as
	// "extensions/*". Keep this deliberately small and explicit so the publish
	// script is predictable in CI.
	if (!pattern.endsWith("/*")) return [];
	const base = join(root, pattern.slice(0, -2));
	if (!existsSync(base)) return [];
	return readdirSync(base, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(base, entry.name))
		.filter((dir) => existsSync(join(dir, "package.json")));
}

function collectPackages(): PackageInfo[] {
	const dirs = new Set<string>();
	for (const workspace of rootPackage.workspaces ?? []) {
		for (const dir of workspacePackageDirs(workspace)) dirs.add(dir);
	}

	const packages: PackageInfo[] = [];
	for (const dir of [...dirs].sort()) {
		const pkg = readPackageJson(join(dir, "package.json"));
		if (pkg.private) continue;
		if (!pkg.name || !pkg.version) continue;
		packages.push({ dir, name: pkg.name, version: pkg.version });
	}
	return packages;
}

async function isPublished(name: string, version: string): Promise<boolean> {
	try {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
		return response.ok;
	} catch {
		// Network failures should not silently skip a package. Let npm publish be
		// the source of truth in the publish phase.
		return false;
	}
}

async function publishOne(pkg: PackageInfo): Promise<"published" | "skipped-race" | "failed"> {
	try {
		const result = await $`npm publish ${publishFlags}`.cwd(pkg.dir).quiet();
		if (dryRun) process.stdout.write(result.stdout.toString());
		console.log(`✔ ${dryRun ? "would publish" : "published"}: ${pkg.name}@${pkg.version}`);
		return "published";
	} catch (error) {
		const err = error as { stdout?: Buffer | string; stderr?: Buffer | string };
		const output = `${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}`;
		if (output.includes("cannot publish over") || output.includes("EPUBLISHCONFLICT")) {
			console.log(`↷ skip (already published by another run): ${pkg.name}@${pkg.version}`);
			return "skipped-race";
		}
		if (output.includes("EOTP") || output.includes("one-time password") || output.includes("E401") || output.includes("Unauthorized")) {
			console.error("\n✖ npm authentication failed.");
			console.error("Use npm trusted publishing or provide an automation token via NODE_AUTH_TOKEN/NPM_TOKEN.\n");
		}
		console.error(`✖ failed: ${pkg.name}@${pkg.version}`);
		console.error(output);
		return "failed";
	}
}

const packages = collectPackages();

if (dryRun) console.log("[dry-run mode]");
console.log(`Found ${packages.length} public workspace package(s). Checking npm registry...`);

const published = await Promise.all(packages.map((pkg) => isPublished(pkg.name, pkg.version)));
const toSkip = packages.filter((_, index) => published[index]);
const toPublish = packages.filter((_, index) => !published[index]);

for (const pkg of toSkip) console.log(`↷ skip (already published): ${pkg.name}@${pkg.version}`);

if (toPublish.length === 0) {
	console.log("\nAll package versions are already published. Nothing to do.");
	process.exit(0);
}

console.log(`\n${dryRun ? "Would publish" : "Publishing"} ${toPublish.length} package(s) with concurrency=${concurrency}:`);
for (const pkg of toPublish) console.log(`  - ${pkg.name}@${pkg.version}`);
console.log("");

let publishedCount = 0;
let skippedRaceCount = 0;
let failedCount = 0;

for (let index = 0; index < toPublish.length; index += concurrency) {
	const batch = toPublish.slice(index, index + concurrency);
	const results = await Promise.all(batch.map(publishOne));
	for (const result of results) {
		if (result === "published") publishedCount += 1;
		else if (result === "skipped-race") skippedRaceCount += 1;
		else failedCount += 1;
	}
}

console.log(`\nPublish summary: ${publishedCount} ${dryRun ? "would publish" : "published"}, ${toSkip.length + skippedRaceCount} skipped, ${failedCount} failed.`);
if (failedCount > 0) process.exit(1);
