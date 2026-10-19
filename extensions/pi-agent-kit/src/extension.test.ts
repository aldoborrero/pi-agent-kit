import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "./once.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bundle = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("external plugin replacements", () => {
	test("pins upstream packages and removes legacy bundle dependencies", () => {
		expect(bundle.dependencies["@juicesharp/rpiv-ask-user-question"]).toBe("2.12.0");
		expect(bundle.dependencies["pi-web-access"]).toBe("0.35.0");
		expect(bundle.dependencies["@bacnh85/pi-notify"]).toBe("0.1.8");
		for (const name of ["pi-questionnaire", "pi-web-tools", "pi-notify"]) {
			expect(bundle.dependencies[`@aldoborrero/${name}`]).toBeUndefined();
		}
	});

	test("loads the real bundle with the SDK without retired tools or notification flags", () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-kit-plugin-test-"));
		try {
			// A fresh Node process uses the SDK's real jiti loader and aliases, not
			// Bun's different module resolution. No session or model is started.
			const script = `
				import { loadExtensions } from './node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
				const result = await loadExtensions([process.cwd() + '/extensions/pi-agent-kit/src/extension.ts'], process.env.PI_CODING_AGENT_DIR);
				const extension = result.extensions[0];
				console.log(JSON.stringify({
					errors: result.errors,
					tools: [...(extension?.tools.keys() ?? [])],
					flags: [...(extension?.flags.keys() ?? [])],
					commands: [...(extension?.commands.keys() ?? [])],
					events: [...(extension?.handlers.keys() ?? [])],
				}));
				process.exit(result.errors.length ? 1 : 0);
			`;
			const result = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
				cwd: root,
				env: { ...process.env, PI_CODING_AGENT_DIR: scratch, XDG_CONFIG_HOME: scratch, PI_OFFLINE: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(result.stderr.toString()).toBe("");
			expect(result.exitCode).toBe(0);
			const registered = JSON.parse(result.stdout.toString().trim());
			expect(registered.errors).toEqual([]);
			for (const name of ["ask_user_question", "web_search", "fetch_content", "source_check", "get_search_content"]) {
				expect(registered.tools).toContain(name);
			}
			for (const name of ["questionnaire", "web_fetch"]) expect(registered.tools).not.toContain(name);
			expect(registered.flags).toContain("no-notify");
			expect(registered.flags).not.toContain("notify");
			expect(registered.commands).not.toContain("notify");
			for (const name of ["agent_settled", "ui_prompt_start"]) expect(registered.events).toContain(name);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 60_000);

	test("bundle guard registers once per host and again on a fresh host", () => {
		const host = {};
		let calls = 0;
		once(host, "pi-agent-kit", () => calls++);
		once(host, "pi-agent-kit", () => calls++);
		expect(calls).toBe(1);
		once({}, "pi-agent-kit", () => calls++);
		expect(calls).toBe(2);
	});
});
