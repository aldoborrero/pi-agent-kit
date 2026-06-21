import { Worker } from "node:worker_threads";
import { parse, type Node } from "acorn";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { discoverAgents } from "../subagent/agents.js";

const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_ARGS_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_LOGS = 100;
const MAX_PHASES = 50;
const MAX_TEXT_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

export interface DynamicWorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail?: string }>;
}

export interface DynamicWorkflowAgentOptions {
  label?: string;
  phase?: string;
  agent?: string;
  agentScope?: "user" | "project" | "both";
  signal?: AbortSignal;
}

export interface DynamicWorkflowAgentRunner {
  run(
    prompt: string,
    options: Required<Pick<DynamicWorkflowAgentOptions, "label" | "agent" | "agentScope">> &
      Pick<DynamicWorkflowAgentOptions, "phase" | "signal">,
  ): Promise<string>;
}

export interface DynamicWorkflowSnapshot {
  name: string;
  description: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: Array<{
    id: number;
    label: string;
    phase?: string;
    status: "running" | "done" | "error" | "aborted";
    preview?: string;
  }>;
  result?: unknown;
  durationMs?: number;
}

export interface DynamicWorkflowRunResult {
  meta: DynamicWorkflowMeta;
  result: unknown;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  snapshot: DynamicWorkflowSnapshot;
}

export interface DynamicWorkflowRunOptions {
  args?: unknown;
  cwd: string;
  signal?: AbortSignal;
  agent: DynamicWorkflowAgentRunner;
  defaultAgent?: string;
  agentScope?: "user" | "project" | "both";
  concurrency?: number;
  maxAgents?: number;
  tokenBudget?: number | null;
  timeoutMs?: number;
  onSnapshot?: (snapshot: DynamicWorkflowSnapshot) => void;
}

const workflowScriptParams = Type.Object({
  script: Type.String({
    maxLength: MAX_SCRIPT_BYTES,
    description: [
      "Raw JavaScript workflow script with no Markdown fences.",
      "First statement must be: export const meta = { name: 'short_name', description: 'what it does' }.",
      "Use phase(title), agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), log(message), args, cwd, and budget.",
      "The script must call agent() at least once.",
    ].join(" "),
  }),
  args: Type.Optional(Type.Any({ description: "Optional JSON value exposed to the workflow script as global args." })),
  concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 8, description: "Max concurrent agent calls. Default: 4." })),
  maxAgents: Type.Optional(Type.Number({ minimum: 1, maximum: 24, description: "Hard cap on total agent calls. Default: 12." })),
  tokenBudget: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000_000, description: "Approximate output-token budget across agents." })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: MAX_TIMEOUT_MS, description: "Hard workflow wall-clock timeout. Default: 10 minutes." })),
  agent: Type.Optional(Type.String({ description: "Default agent name for agent() calls. Default: scout." })),
  agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
    description: "Agent source scope. Defaults to user. Project/both requires explicit confirmation.",
  })),
});

type WorkflowScriptParams = Static<typeof workflowScriptParams>;
type AnyNode = Node & { [key: string]: any; start: number; end: number };

type WorkerRequest = {
  type: "agent";
  id: number;
  prompt: string;
  options: DynamicWorkflowAgentOptions;
} | {
  type: "phase";
  title: string;
} | {
  type: "log";
  message: string;
} | {
  type: "done";
  result: unknown;
} | {
  type: "error";
  error: string;
};

type ParentResponse = {
  type: "agent-result";
  id: number;
  ok: true;
  output: string;
  spent: number;
} | {
  type: "agent-result";
  id: number;
  ok: false;
  error: string;
  spent?: number;
};

export function parseDynamicWorkflowScript(script: string): { meta: DynamicWorkflowMeta; body: string } {
  const text = normalizeWorkflowScript(script);
  enforceByteLimit("workflow script", text, MAX_SCRIPT_BYTES);
  const ast = parse(text, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("workflow script must start with `export const meta = { name, description }`");
  }
  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" || declaration.declarations.length !== 1) {
    throw new Error("meta export must be `export const meta = ...`");
  }
  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta" || !declarator.init) {
    throw new Error("meta export must declare exactly `meta`");
  }

  const meta = evaluateLiteral(declarator.init, "meta");
  validateDynamicWorkflowMeta(meta);
  validateWorkflowAst(ast, first);
  return {
    meta,
    body: text.slice(0, first.start) + text.slice(first.end),
  };
}

export async function runDynamicWorkflow(script: string, options: DynamicWorkflowRunOptions): Promise<DynamicWorkflowRunResult> {
  const startedAt = Date.now();
  const { meta, body } = parseDynamicWorkflowScript(script);
  const args = cloneJsonValue(options.args, "workflow args", MAX_ARGS_BYTES);
  const maxAgents = clampInt(options.maxAgents ?? 12, 1, 24);
  const concurrency = clampInt(options.concurrency ?? 4, 1, 8);
  const timeoutMs = clampInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const tokenBudget = options.tokenBudget ?? null;
  const limiter = createLimiter(concurrency);
  const activeAgents = new Set<Promise<void>>();
  const internalAbort = new AbortController();
  const agentSignal = combineSignals(options.signal, internalAbort.signal);
  let agentCount = 0;
  let spent = 0;
  let settled = false;
  let timedOut = false;

  const snapshot: DynamicWorkflowSnapshot = {
    name: meta.name,
    description: meta.description,
    phases: [],
    logs: [],
    agents: [],
  };
  const emit = () => {
    try {
      options.onSnapshot?.(structuredClone(snapshot));
    } catch {
      // Progress rendering must not change workflow execution.
    }
  };

  const worker = new Worker(DYNAMIC_WORKER_SOURCE, {
    eval: true,
    workerData: { body, args, cwd: options.cwd, tokenBudget },
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  });

  let removeAbortListener: (() => void) | undefined;
  const resultPromise = new Promise<unknown>((resolve, reject) => {
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    worker.on("message", (message: WorkerRequest) => {
      if (settled) return;
      if (message.type === "phase") {
        if (snapshot.phases.length >= MAX_PHASES && !snapshot.phases.includes(message.title)) {
          fail(new Error(`workflow script exceeded phase limit (${MAX_PHASES})`));
          return;
        }
        const title = boundedText(message.title, "phase title");
        snapshot.currentPhase = title;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
        emit();
        return;
      }
      if (message.type === "log") {
        if (snapshot.logs.length >= MAX_LOGS) {
          fail(new Error(`workflow script exceeded log limit (${MAX_LOGS})`));
          return;
        }
        snapshot.logs.push(boundedText(message.message, "log message"));
        emit();
        return;
      }
      if (message.type === "agent") {
        const task = handleAgentRequest(message);
        activeAgents.add(task);
        task.finally(() => activeAgents.delete(task));
        return;
      }
      if (message.type === "done") {
        try {
          const result = cloneJsonValue(message.result, "workflow result", MAX_RESULT_BYTES);
          settled = true;
          resolve(result);
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (message.type === "error") fail(new Error(message.error));
    });

    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!settled) fail(new Error(`workflow worker exited before completion (${code})`));
    });

    async function handleAgentRequest(message: Extract<WorkerRequest, { type: "agent" }>): Promise<void> {
      const send = (response: ParentResponse) => {
        if (!settled) worker.postMessage(response);
      };
      try {
        if (agentCount >= maxAgents) throw new Error(`workflow script exceeded maxAgents (${maxAgents})`);
        if (tokenBudget !== null && spent >= tokenBudget) throw new Error("workflow script token budget exhausted");
        enforceAgentScope(options.agentScope ?? "user", message.options.agentScope);
        const prompt = boundedText(message.prompt, "agent prompt", MAX_PROMPT_BYTES);
        const id = ++agentCount;
        const phase = message.options.phase ? boundedText(message.options.phase, "agent phase") : snapshot.currentPhase;
        const label = boundedText(message.options.label?.trim() || `${phase ?? "agent"} ${id}`, "agent label");
        const agentName = boundedText(message.options.agent?.trim() || options.defaultAgent || "scout", "agent name");
        const agentScope = message.options.agentScope ?? options.agentScope ?? "user";
        snapshot.agents.push({ id: message.id, label, phase, status: "running" });
        emit();

        await limiter(async () => {
          if (agentSignal.aborted) throw new Error("workflow script aborted");
          const output = await options.agent.run(prompt, { label, phase, agent: agentName, agentScope, signal: agentSignal });
          enforceByteLimit("agent output", output, MAX_RESULT_BYTES);
          spent += estimateTokens(output);
          if (tokenBudget !== null && spent > tokenBudget) {
            throw new Error(`workflow script token budget exhausted (${spent}/${tokenBudget})`);
          }
          const entry = snapshot.agents.find((item) => item.id === message.id);
          if (entry) {
            entry.status = "done";
            entry.preview = preview(output);
          }
          emit();
          send({ type: "agent-result", id: message.id, ok: true, output, spent });
        });
      } catch (error) {
        const entry = snapshot.agents.find((item) => item.id === message.id);
        if (entry) {
          entry.status = agentSignal.aborted ? "aborted" : "error";
          entry.preview = errorMessage(error);
        }
        emit();
        send({ type: "agent-result", id: message.id, ok: false, error: errorMessage(error), spent });
      }
    }
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    internalAbort.abort();
    void worker.terminate();
  }, timeoutMs);
  const onAbort = () => {
    internalAbort.abort();
    void worker.terminate();
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else {
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    }
  }

  try {
    const result = await resultPromise;
    snapshot.result = result;
    snapshot.durationMs = Date.now() - startedAt;
    emit();
    return {
      meta,
      result,
      logs: snapshot.logs,
      phases: snapshot.phases,
      agentCount,
      durationMs: snapshot.durationMs,
      snapshot,
    };
  } catch (error) {
    if (options.signal?.aborted) throw new Error("workflow script aborted");
    if (timedOut) throw new Error(`workflow script timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
    removeAbortListener?.();
    internalAbort.abort();
    await worker.terminate().catch(() => undefined);
    await Promise.allSettled([...activeAgents]);
  }
}

export function createDynamicWorkflowTool(
  agentRunner: (
    cwd: string,
    agent: string,
    prompt: string,
    signal: AbortSignal | undefined,
    agentScope: "user" | "project" | "both",
  ) => Promise<string>,
): ToolDefinition<typeof workflowScriptParams, DynamicWorkflowSnapshot> {
  return {
    name: "workflow_script",
    label: "Workflow Script",
    description: "Execute a bounded JavaScript workflow that fans work out to subagents with agent(), parallel(), and pipeline().",
    promptSnippet: "Run a bounded dynamic JavaScript workflow for explicit fan-out or multi-agent orchestration.",
    promptGuidelines: [
      "Use workflow_script only when the user explicitly asks for a workflow, fan-out, multi-agent review, broad audit, or parallel exploration.",
      "Pass raw JavaScript in script, without Markdown fences. The first statement must be `export const meta = { name: 'short_name', description: '...' }`.",
      "Use phase(title) to group progress, agent(prompt, { label }) for subagent calls, parallel([...functions]) for fan-out, and pipeline(items, ...stages) for staged fan-out.",
      "Do not use workflow_script for one quick file read or a single simple edit.",
      "Workflow scripts cannot import modules, access host APIs, use dynamic property access, constructors, classes, eval(), or Function().",
      "Every workflow_script must call agent() at least once and return a compact JSON-serializable result.",
    ],
    parameters: workflowScriptParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") throw new Error("workflow_script requires an object argument");
      const value = args as WorkflowScriptParams;
      return { ...value, script: normalizeWorkflowScript(value.script) };
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      parseDynamicWorkflowScript(params.script);
      const agentScope = params.agentScope ?? "user";
      await confirmProjectAgentScope(ctx, agentScope);
      const result = await runDynamicWorkflow(params.script, {
        cwd: ctx.cwd,
        args: params.args,
        signal,
        concurrency: params.concurrency,
        maxAgents: params.maxAgents,
        tokenBudget: params.tokenBudget,
        timeoutMs: params.timeoutMs,
        defaultAgent: params.agent,
        agentScope,
        agent: {
          run: async (prompt, options) => agentRunner(ctx.cwd, options.agent, prompt, options.signal, options.agentScope),
        },
        onSnapshot(snapshot) {
          onUpdate?.({
            content: [{ type: "text", text: formatDynamicWorkflowSnapshot(snapshot) }],
            details: snapshot,
          });
        },
      });

      return {
        content: [{
          type: "text",
          text: `Workflow script ${result.meta.name} completed with ${result.agentCount} agent(s).\n\n${JSON.stringify(result.result, null, 2)}`,
        }],
        details: result.snapshot,
      };
    },
  };
}

export function formatDynamicWorkflowSnapshot(snapshot: DynamicWorkflowSnapshot): string {
  const lines = [`Workflow: ${snapshot.name} (${snapshot.agents.filter((a) => a.status === "done").length}/${snapshot.agents.length} done)`];
  for (const phaseTitle of snapshot.phases) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phaseTitle);
    lines.push(`  ${phaseTitle} ${agents.filter((a) => a.status === "done").length}/${agents.length}`);
    for (const agent of agents) lines.push(`    #${agent.id} ${agent.status} ${agent.label}`);
  }
  for (const agent of snapshot.agents.filter((item) => !item.phase)) {
    lines.push(`  #${agent.id} ${agent.status} ${agent.label}`);
  }
  if (snapshot.logs.length > 0) lines.push(`  log: ${snapshot.logs[snapshot.logs.length - 1]}`);
  return lines.join("\n");
}

async function confirmProjectAgentScope(ctx: ExtensionContext, scope: "user" | "project" | "both"): Promise<void> {
  if (scope === "user") return;
  if (!ctx.hasUI) throw new Error("project-local agents require interactive confirmation");
  const discovery = discoverAgents(ctx.cwd, scope);
  const projectAgents = discovery.agents.filter((agent) => agent.source === "project");
  if (projectAgents.length === 0) {
    if (scope === "project") throw new Error("no project-local agents were found");
    return;
  }
  const names = projectAgents.map((agent) => agent.name).sort().join(", ");
  const ok = await ctx.ui.confirm(
    "Run project-local workflow agents?",
    `Agents available from ${discovery.projectAgentsDir ?? ".pi/agents"}:\n${names}\n\nProject agents are repository-controlled.`,
  );
  if (!ok) throw new Error("project-local workflow agents were not approved");
}

function normalizeWorkflowScript(script: string): string {
  if (typeof script !== "string") throw new Error("script must be a string");
  const trimmed = script.trim();
  const fence = trimmed.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const result: Record<string, unknown> = {};
      for (const property of node.properties as AnyNode[]) {
        if (property.type !== "Property" || property.computed || property.kind !== "init" || property.method) {
          throw new Error(`only plain literal properties are allowed in ${path}`);
        }
        const key = literalPropertyKey(property.key as AnyNode, path);
        if (isDangerousProperty(key)) throw new Error(`reserved key '${key}' is unavailable in ${path}`);
        result[key] = evaluateLiteral(property.value as AnyNode, `${path}.${key}`);
      }
      return result;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element || element.type === "SpreadElement") throw new Error(`sparse arrays and spreads are unavailable in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation is unavailable in ${path}`);
      return node.quasis.map((part: AnyNode) => part.value.cooked ?? part.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative numeric unary values are allowed in ${path}`);
    default:
      throw new Error(`non-literal ${node.type} is unavailable in ${path}`);
  }
}

function literalPropertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  throw new Error(`unsupported property key in ${path}`);
}

function validateWorkflowAst(root: AnyNode, metaNode: AnyNode): void {
  for (const statement of root.body as AnyNode[]) {
    if (statement === metaNode) continue;
    walkAst(statement, (node, parent) => {
      if (node.type === "ImportDeclaration" || node.type === "ImportExpression" || node.type === "MetaProperty") {
        throw new Error(`${node.type} is unavailable in workflow scripts`);
      }
      if (node.type === "NewExpression" || node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        throw new Error(`${node.type} is unavailable in workflow scripts`);
      }
      if (node.type === "ThisExpression") throw new Error("this is unavailable in workflow scripts");
      if (node.type === "Identifier" && FORBIDDEN_IDENTIFIERS.has(node.name) && isIdentifierReference(node, parent)) {
        throw new Error(`${node.name} is unavailable in workflow scripts`);
      }
      if (node.type === "MemberExpression") {
        const property = staticPropertyName(node);
        if (property && isDangerousProperty(property)) throw new Error(`${property} access is unavailable in workflow scripts`);
        if (node.computed && property === undefined) throw new Error("dynamic property access is unavailable in workflow scripts");
        if (isForbiddenMathRandom(node)) throw new Error("Math.random() is unavailable in workflow scripts");
        if (node.object?.type === "Identifier" && node.object.name === "process" && property !== "cwd") {
          throw new Error(`process.${property ?? "unknown"} is unavailable in workflow scripts`);
        }
      }
      validateBindingPatterns(node);
    });
  }
}

function validateBindingPatterns(node: AnyNode): void {
  switch (node.type) {
    case "VariableDeclarator":
      validateBindingPattern(node.id as AnyNode);
      break;
    case "AssignmentExpression":
      if (node.left?.type === "ObjectPattern" || node.left?.type === "ArrayPattern") {
        validateBindingPattern(node.left as AnyNode);
      }
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      for (const parameter of node.params as AnyNode[]) validateBindingPattern(parameter);
      break;
    case "ForInStatement":
    case "ForOfStatement":
      if (node.left?.type === "ObjectPattern" || node.left?.type === "ArrayPattern") {
        validateBindingPattern(node.left as AnyNode);
      }
      break;
    case "CatchClause":
      if (node.param) validateBindingPattern(node.param as AnyNode);
      break;
  }
}

function validateBindingPattern(pattern: AnyNode): void {
  switch (pattern.type) {
    case "Identifier":
      if (FORBIDDEN_IDENTIFIERS.has(pattern.name)) throw new Error(`${pattern.name} binding is unavailable in workflow scripts`);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties as AnyNode[]) {
        if (property.type === "RestElement") {
          validateBindingPattern(property.argument as AnyNode);
          continue;
        }
        if (property.type !== "Property") throw new Error("unsupported object binding pattern");
        const key = property.computed
          ? staticString(property.key as AnyNode)
          : literalPropertyKey(property.key as AnyNode, "binding pattern");
        if (key === undefined) throw new Error("dynamic destructuring keys are unavailable in workflow scripts");
        if (isDangerousProperty(key)) throw new Error(`${key} destructuring is unavailable in workflow scripts`);
        validateBindingPattern(property.value as AnyNode);
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements as Array<AnyNode | null>) {
        if (element) validateBindingPattern(element);
      }
      return;
    case "AssignmentPattern":
      validateBindingPattern(pattern.left as AnyNode);
      return;
    case "RestElement":
      validateBindingPattern(pattern.argument as AnyNode);
      return;
    case "MemberExpression":
      throw new Error("member-expression binding targets are unavailable in workflow scripts");
    default:
      throw new Error(`unsupported binding pattern ${pattern.type}`);
  }
}

const FORBIDDEN_IDENTIFIERS = new Set([
  "Date", "Function", "Object", "Proxy", "Reflect", "WebAssembly", "XMLHttpRequest", "WebSocket",
  "eval", "fetch", "global", "globalThis", "module", "require",
]);

function isIdentifierReference(node: AnyNode, parent: AnyNode | undefined): boolean {
  if (!parent) return true;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") &&
      (parent.id === node || parent.params.includes(node))) return false;
  return true;
}

function staticPropertyName(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticString(node.property as AnyNode | undefined);
}

function staticString(node: AnyNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((part: AnyNode) => part.value.cooked ?? part.value.raw).join("");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left as AnyNode);
    const right = staticString(node.right as AnyNode);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function isForbiddenMathRandom(node: AnyNode): boolean {
  return node.object?.type === "Identifier" && node.object.name === "Math" && staticPropertyName(node) === "random";
}

function isDangerousProperty(name: string): boolean {
  return name === "__proto__" || name === "constructor" || name === "prototype";
}

function walkAst(root: AnyNode, visit: (node: AnyNode, parent?: AnyNode) => void): void {
  const walk = (node: AnyNode, parent?: AnyNode) => {
    visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (isAstNode(child)) walk(child, node);
      } else if (isAstNode(value)) {
        walk(value, node);
      }
    }
  };
  walk(root);
}

function isAstNode(value: unknown): value is AnyNode {
  return Boolean(value && typeof value === "object" && typeof (value as AnyNode).type === "string");
}

function validateDynamicWorkflowMeta(meta: unknown): asserts meta is DynamicWorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as DynamicWorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) throw new Error("meta.description must be a non-empty string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof phase.title !== "string" || !phase.title.trim()) {
        throw new Error("each meta phase must have a non-empty title string");
      }
    }
  }
}

function enforceAgentScope(allowed: "user" | "project" | "both", requested?: "user" | "project" | "both"): void {
  const actual = requested ?? allowed;
  if (allowed === "user" && actual !== "user") throw new Error("workflow script cannot widen agentScope beyond user");
  if (allowed === "project" && actual !== "project") throw new Error("workflow script cannot widen agentScope beyond project");
}

function cloneJsonValue(value: unknown, label: string, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable: ${errorMessage(error)}`);
  }
  if (json === undefined) throw new Error(`${label} must be JSON-serializable`);
  enforceByteLimit(label, json, maxBytes);
  return JSON.parse(json);
}

function boundedText(value: unknown, label: string, maxBytes = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  enforceByteLimit(label, value, maxBytes);
  return value;
}

function enforceByteLimit(label: string, value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DYNAMIC_WORKER_SOURCE = String.raw`
const vm = require("node:vm");
const { parentPort, workerData } = require("node:worker_threads");

let currentPhase;
let requestId = 0;
let agentCount = 0;
let spent = 0;
const pending = new Map();

const send = (message) => parentPort.postMessage(message);
const agent = (prompt, options = {}) => {
  if (typeof prompt !== "string" || !prompt.trim()) return Promise.reject(new TypeError("agent prompt must be a non-empty string"));
  const id = ++requestId;
  agentCount++;
  send({ type: "agent", id, prompt, options: { ...options, phase: options.phase ?? currentPhase } });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const parallel = (thunks) => {
  if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("parallel() expects an array of functions");
  }
  return Promise.all(thunks.map((thunk) => thunk()));
};
const pipeline = (items, ...stages) => {
  if (!Array.isArray(items) || stages.some((stage) => typeof stage !== "function")) {
    throw new TypeError("pipeline() expects an array and function stages");
  }
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) value = await stage(value, item, index);
    return value;
  }));
};
const phase = (title) => {
  if (typeof title !== "string" || !title.trim()) throw new TypeError("phase title must be a non-empty string");
  currentPhase = title;
  send({ type: "phase", title });
};
const log = (message) => send({ type: "log", message: String(message) });

parentPort.on("message", (message) => {
  if (message.type !== "agent-result") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) {
    spent = message.spent;
    request.resolve(message.output);
  }
  else {
    if (typeof message.spent === "number") spent = message.spent;
    request.reject(new Error(message.error));
  }
});

const context = vm.createContext({
  agent,
  parallel,
  pipeline,
  phase,
  log,
  args: workerData.args,
  cwd: workerData.cwd,
  process: Object.freeze({ cwd: () => workerData.cwd }),
  budget: Object.freeze({
    total: workerData.tokenBudget,
    spent: () => spent,
    remaining: () => workerData.tokenBudget == null ? Infinity : Math.max(0, workerData.tokenBudget - spent),
  }),
  console: Object.freeze({ log, info: log, warn: log, error: log }),
  JSON,
  Math: Object.freeze(Object.assign(Object.create(Math), { random: undefined })),
  Array,
  Object,
  String,
  Number,
  Boolean,
  Set,
  Map,
  Promise,
}, { codeGeneration: { strings: false, wasm: false } });

(async () => {
  try {
    const result = await new vm.Script("(async () => {\n" + workerData.body + "\n})()", {
      filename: "workflow_script.js",
    }).runInContext(context, { timeout: 1000 });
    if (agentCount === 0) throw new Error("workflow scripts must call agent() at least once");
    if (pending.size > 0) throw new Error("workflow script has unawaited agent calls");
    send({ type: "done", result });
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
})();
`;
