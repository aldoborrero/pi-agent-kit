import assert from "node:assert/strict";
import test from "node:test";
import {
  createDynamicWorkflowTool,
  parseDynamicWorkflowScript,
  runDynamicWorkflow,
  type DynamicWorkflowAgentRunner,
} from "../dynamic.js";

const fakeAgent: DynamicWorkflowAgentRunner = {
  async run(prompt, options) {
    return `${options.label}:${prompt}`;
  },
};

test("parseDynamicWorkflowScript accepts literal metadata and strips export", () => {
  const parsed = parseDynamicWorkflowScript(`
export const meta = {
  name: 'audit',
  description: 'Audit the repo',
  phases: [{ title: 'Scan' }]
}

phase('Scan')
return { ok: true }
`);

  assert.equal(parsed.meta.name, "audit");
  assert.equal(parsed.meta.description, "Audit the repo");
  assert.equal(parsed.meta.phases?.[0]?.title, "Scan");
  assert.doesNotMatch(parsed.body, /export const meta/);
});

test("parseDynamicWorkflowScript rejects direct unsafe runtime APIs", () => {
  for (const expression of [
    "Date.now()",
    "new Date()",
    "Math.random()",
    "require('node:fs')",
    "import('node:fs')",
    "fetch('https://example.com')",
    "eval('1')",
    "agent.constructor('return process')()",
  ]) {
    assert.throws(
      () => parseDynamicWorkflowScript(`export const meta = { name: 'bad', description: 'bad' }\nreturn ${expression}`),
      /unavailable|direct filesystem\/network/,
      expression,
    );
  }
});

test("parseDynamicWorkflowScript rejects executable metadata", () => {
  for (const meta of [
    "{ get name() { return 'bad' }, description: 'bad' }",
    "{ name() { return 'bad' }, description: 'bad' }",
    "{ ['name']: 'bad', description: 'bad' }",
    "{ __proto__: {}, name: 'bad', description: 'bad' }",
    "{ name: 'bad', description: `${this.constructor.constructor('return process.version')()}` }",
  ]) {
    assert.throws(
      () => parseDynamicWorkflowScript(`export const meta = ${meta}\nreturn agent('x')`),
      /meta|methods|computed|reserved/,
      meta,
    );
  }
});

test("parseDynamicWorkflowScript rejects computed constructor access and nondeterministic aliases", () => {
  for (const body of [
    "return agent['con' + 'structor']('return process')()",
    "return Reflect.get(agent, 'constructor')('return process')()",
    "return Object.getPrototypeOf(agent).constructor('return process')()",
    "const clock = Date; return clock.now()",
    "return `${Date.now()}`",
  ]) {
    assert.throws(
      () => parseDynamicWorkflowScript(`export const meta = { name: 'bad', description: 'bad' }\n${body}`),
      /unavailable/,
      body,
    );
  }
});

test("parseDynamicWorkflowScript rejects dangerous destructuring patterns", () => {
  for (const body of [
    "const { constructor: F } = agent; return F('return process')()",
    "let F; ({ prototype: F } = agent); return F",
    "const { nested: { __proto__: p } } = { nested: agent }; return p",
    "const { ['con' + 'structor']: F } = agent; return F('return process')()",
    "const read = ({ constructor: F }) => F; return read(agent)",
    "for (const { prototype: p } of [agent]) return p",
  ]) {
    assert.throws(
      () => parseDynamicWorkflowScript(`export const meta = { name: 'bad', description: 'bad' }\n${body}`),
      /destructuring|dynamic destructuring/,
      body,
    );
  }
});

test("parseDynamicWorkflowScript allows the safe cwd shim", () => {
  assert.doesNotThrow(() => parseDynamicWorkflowScript(`
export const meta = { name: 'cwd', description: 'Read cwd' }
await agent('scan')
return { cwd, processCwd: process.cwd() }
`));
});

test("parseDynamicWorkflowScript allows forbidden API names inside prompts", () => {
  const parsed = parseDynamicWorkflowScript(`
export const meta = {
  name: 'mentions',
  description: 'Catalog Date.now and fs usage'
}

return agent('Find Date.now(), Math.random(), require(), and fs mentions.', { label: 'mentions' })
`);

  assert.match(parsed.body, /Date\.now/);
});

test("runDynamicWorkflow supports phases, parallel agents, and compact result", async () => {
  const result = await runDynamicWorkflow(`
export const meta = { name: 'fanout', description: 'Fan out work' }

phase('Scan')
const results = await parallel([
  () => agent('api', { label: 'scan api' }),
  () => agent('ui', { label: 'scan ui' }),
])
return { results }
`, {
    cwd: process.cwd(),
    agent: fakeAgent,
    concurrency: 2,
  });

  assert.equal(result.meta.name, "fanout");
  assert.equal(result.agentCount, 2);
  assert.deepEqual(result.phases, ["Scan"]);
  assert.deepEqual((result.result as { results: string[] }).results, ["scan api:api", "scan ui:ui"]);
});

test("runDynamicWorkflow rejects workflows without agent calls", async () => {
  await assert.rejects(
    () => runDynamicWorkflow(
      "export const meta = { name: 'empty', description: 'No agents' }\nreturn { ok: true }",
      { cwd: process.cwd(), agent: fakeAgent },
    ),
    /must call agent/,
  );
});

test("runDynamicWorkflow enforces maxAgents before concurrent calls queue", async () => {
  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'bounded', description: 'Bound concurrent fan-out' }

return parallel([
  () => agent('one'),
  () => agent('two'),
  () => agent('three'),
])
`, {
      cwd: process.cwd(),
      agent: fakeAgent,
      concurrency: 1,
      maxAgents: 2,
    }),
    /exceeded maxAgents/,
  );
});

test("runDynamicWorkflow rejects unawaited agent promises", async () => {
  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'promise_leak', description: 'Leaks a promise' }

const output = agent('scan', { label: 'scan' })
return { output }
`, {
      cwd: process.cwd(),
      agent: fakeAgent,
    }),
    /unawaited agent calls/,
  );
});

test("runDynamicWorkflow terminates asynchronous infinite loops", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'hang', description: 'Hang after an await' }

await Promise.resolve()
while (true) {}
`, {
      cwd: process.cwd(),
      agent: fakeAgent,
      timeoutMs: 1_000,
    }),
    /timed out/,
  );
  assert.ok(Date.now() - startedAt < 3_000);
});

test("runDynamicWorkflow aborts pending agents when the workflow times out", async () => {
  let observedAbort = false;
  const blockingAgent: DynamicWorkflowAgentRunner = {
    run(_prompt, options) {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  };

  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'blocked', description: 'Blocked agent' }
return await agent('wait forever')
`, {
      cwd: process.cwd(),
      agent: blockingAgent,
      timeoutMs: 1_000,
    }),
    /timed out/,
  );
  assert.equal(observedAbort, true);
});

test("runDynamicWorkflow rejects non-JSON results", async () => {
  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'bigint', description: 'Return BigInt' }
await agent('scan')
return 1n
`, {
      cwd: process.cwd(),
      agent: fakeAgent,
    }),
    /JSON-serializable/,
  );
});

test("runDynamicWorkflow propagates agent failures", async () => {
  const failedAgent: DynamicWorkflowAgentRunner = {
    async run() {
      throw new Error("agent process failed");
    },
  };
  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'failure', description: 'Agent failure' }
return await agent('fail')
`, {
      cwd: process.cwd(),
      agent: failedAgent,
    }),
    /agent process failed/,
  );
});

test("runDynamicWorkflow enforces token and log limits", async () => {
  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'budget', description: 'Token budget' }
return await agent('produce output')
`, {
      cwd: process.cwd(),
      agent: fakeAgent,
      tokenBudget: 1,
    }),
    /token budget exhausted/,
  );

  await assert.rejects(
    () => runDynamicWorkflow(`
export const meta = { name: 'logs', description: 'Log flood' }
for (let i = 0; i < 101; i++) log('line ' + i)
return await agent('scan')
`, {
      cwd: process.cwd(),
      agent: fakeAgent,
    }),
    /log limit/,
  );
});

test("runDynamicWorkflow ignores progress-renderer failures", async () => {
  const result = await runDynamicWorkflow(`
export const meta = { name: 'updates', description: 'Update failures' }
phase('Scan')
return await agent('scan')
`, {
    cwd: process.cwd(),
    agent: fakeAgent,
    onSnapshot() {
      throw new Error("renderer failed");
    },
  });
  assert.equal(result.result, "Scan 1:scan");
});

test("workflow_script defaults to user agents and rejects unconfirmed project scope without UI", async () => {
  const tool = createDynamicWorkflowTool(async () => "ok");
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    ui: {},
  } as any;

  await assert.rejects(
    () => tool.execute("tool-1", {
      script: "export const meta = { name: 'scope', description: 'scope' }\nreturn await agent('scan')",
      agentScope: "both",
    }, undefined, undefined, context),
    /interactive confirmation/,
  );
});
