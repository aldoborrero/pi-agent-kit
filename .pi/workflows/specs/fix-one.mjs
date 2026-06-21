import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";

function slugify(input, max = 48) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "run";
}

function summarizeText(text, max = 400) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? compact.slice(0, max) + "\u2026" : compact;
}

function parseLooseObject(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new Error("Not an object literal");
  if (trimmed.length > 32 * 1024) throw new Error("Input too large");
  let normalized = trimmed;
  normalized = normalized.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
  normalized = normalized.replace(/\s*:\s*'((?:[^'\\]|\\.)*?)'/g, (_, inner) => {
    const unescaped = inner.replace(/\\'/g, "'");
    const escaped = unescaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `: "${escaped}"`;
  });
  return JSON.parse(normalized);
}

function parseArgsText(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try { return parseLooseObject(trimmed); } catch { /* fall */ }
    try { return JSON.parse(trimmed); } catch { /* fall */ }
  }
  return trimmed;
}

function parseFixOneOptions(raw) {
  const parsed = parseArgsText(raw);
  if (typeof parsed === "string") {
    const task = parsed.trim();
    if (!task) throw new Error("fix-one task is required");
    return { task, agent: "build", reviewerAgent: "review", autoMerge: true, agentScope: "both" };
  }
  if (!parsed || typeof parsed !== "object") throw new Error("/workflow run fix-one requires either a task string or an object like {task:'...', verify:'bun test'}");
  const v = parsed;
  const task = typeof v.task === "string" ? v.task.trim() : "";
  if (!task) throw new Error("fix-one.task is required");
  return {
    task,
    verify: typeof v.verify === "string" ? v.verify : undefined,
    agent: typeof v.agent === "string" ? v.agent : "build",
    reviewerAgent: typeof v.reviewerAgent === "string" ? v.reviewerAgent : "review",
    baseRef: typeof v.baseRef === "string" ? v.baseRef : undefined,
    autoMerge: typeof v.autoMerge === "boolean" ? v.autoMerge : true,
    agentScope: (v.agentScope === "project" || v.agentScope === "user" || v.agentScope === "both") ? v.agentScope : "both",
  };
}

function gitCmd(repoRoot, ...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf-8", timeout: 60000 }).trim();
}

function parseVerifyCommand(command) {
  const verify = command.trim();
  const shellMeta = /[|;&`$><(){}!\\"'\n\r]/;
  if (shellMeta.test(verify)) {
    throw new Error(`verify command contains unsafe shell metacharacters: ${JSON.stringify(verify)}. Only simple commands are supported.`);
  }
  const [cmd, ...args] = verify.split(/\s+/);
  if (!cmd) throw new Error("verify command is empty");
  return { cmd, args };
}

export default {
  name: "fix-one",
  description: "Single-candidate harness: creates one backlog item, one worktree, one review, optional auto-merge.",

  parseInput(raw) {
    return parseFixOneOptions(raw);
  },

  createRun(input) {
    return {
      title: `fix-one: ${input.task}`,
      summary: input.task,
      tags: ["example", "single-candidate"],
      state: { phase: "execute" },
    };
  },

  async step(state, ctx) {
    if (state.phase === "done") {
      const run = await ctx.store.getRun();
      return {
        kind: run.status === "failed" ? "failed" : "complete",
        state,
        summary: run.summary,
        ...(run.status === "failed" ? { error: run.error ?? "fix-one failed" } : { result: run.result }),
      };
    }

    const repoRoot = ctx.cwd;
    const runId = ctx.runId;
    const manifest = await ctx.store.getRun();
    const opts = manifest.argsValue;

    // Ensure dirs
    [".pi/workflows/backlog/open", ".pi/workflows/backlog/in-progress", ".pi/workflows/backlog/done",
     ".pi/workflows/backlog/tried", ".pi/workflows/logs"].forEach(d => mkdirSync(join(repoRoot, d), { recursive: true }));

    let baseRef = opts.baseRef;
    try { if (!baseRef) baseRef = gitCmd(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"); } catch { baseRef = "HEAD"; }
    if (!baseRef) baseRef = "HEAD";

    // Seed backlog
    const backlogItem = await ctx.backlog.create(opts.task, `Requested task: ${opts.task}\n\nImplement this task as a single focused change. Keep scope tight.`, "task", { source: "fix-one", priority: "high" });
    const claimed = await ctx.backlog.move(backlogItem, "in-progress", { owner: runId, round: 1 });

    const candidateId = `fix-one-${slugify(claimed.id, 32)}`;
    const branch = `fix-one/${slugify(runId, 24)}/${slugify(claimed.id, 24)}`;
    const worktree = await ctx.worktrees.create(candidateId, branch, baseRef);

    const prompt = [
      "You are running a single-candidate workflow harness.",
      `Task: ${claimed.title}`,
      "", claimed.body.trim(), "",
      "Work only in the current worktree. Keep the change focused.",
      opts.verify ? `Before finishing, run this verification command: ${opts.verify}` : "Before finishing, run the most relevant verification.",
      "Do not push.",
      "End with a short summary of the change, remaining risk, and verification steps.",
    ].join("\n");

    // Run agent
    const agentResult = await ctx.agents.run({ agent: opts.agent ?? "build", task: prompt, cwd: worktree.path, agentScope: opts.agentScope ?? "both" });
    const artifactsBase = join(repoRoot, ".pi/workflows/runs", runId, "artifacts", "fix-one");
    mkdirSync(artifactsBase, { recursive: true });
    writeFileSync(join(artifactsBase, `${candidateId}.stdout.log`), agentResult.stdout, "utf8");
    writeFileSync(join(artifactsBase, `${candidateId}.stderr.log`), agentResult.stderr, "utf8");

    // Verify
    let verifyRecord;
    if (opts.verify) {
      try {
        const { cmd, args } = parseVerifyCommand(opts.verify);
        const vo = execFileSync(cmd, args, { cwd: worktree.path, encoding: "utf-8", timeout: 30 * 60000 });
        verifyRecord = { command: opts.verify, exitCode: 0, stdout: vo, stderr: "" };
      } catch (e) {
        verifyRecord = { command: opts.verify, exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
      writeFileSync(join(artifactsBase, `${candidateId}.verify.log`), `${verifyRecord.stdout}\n${verifyRecord.stderr}`.trim(), "utf8");
    }

    // Commit
    const commit = await ctx.merge.commitIfNeeded(worktree.path, `fix-one(${claimed.id}): ${claimed.title}`);

    // Review
    const reviewRaw = await ctx.review.reviewCandidate({
      worktree: worktree.path, itemTitle: claimed.title, itemBody: claimed.body,
      candidateId, candidateSummary: summarizeText(agentResult.output || agentResult.stderr || "(no output)", 700),
      agent: opts.reviewerAgent ?? "review", agentScope: opts.agentScope ?? "both",
    });

    const accepted = agentResult.ok && (!verifyRecord || verifyRecord.exitCode === 0) && parseReviewVerdict(reviewRaw.raw) !== "block";

    // Merge
    let merged = false;
    let mergeError;
    if (accepted && opts.autoMerge !== false) {
      const merge = await ctx.merge.mergeCandidate({ repoRoot, commit, verify: opts.verify });
      merged = merge.merged; mergeError = merge.mergeError;
    }

    const finalStatus = accepted && (opts.autoMerge === false || merged) ? "done" : "tried";
    const finalBacklog = await ctx.backlog.move(claimed, finalStatus, { owner: undefined, round: 1 });
    await ctx.backlog.note(finalBacklog, [
      "Workflow: fix-one", `Branch: ${branch}`, `Worktree: ${worktree.path}`,
      `Accepted: ${accepted ? "yes" : "no"}`, `Final status: ${finalStatus}`, `Merged: ${merged ? "yes" : "no"}`,
      commit ? `Commit: ${commit}` : "Commit: none", opts.verify ? `Verify: ${opts.verify} (exit ${verifyRecord?.exitCode ?? "n/a"})` : "Verify: n/a",
      `Review verdict: ${reviewRaw.verdict}`, mergeError ? `Merge error: ${mergeError}` : undefined,
    ].filter(Boolean).join("\n"));

    const summary = `task=${opts.task} accepted=${accepted ? "yes" : "no"} status=${finalStatus} merged=${merged ? "yes" : "no"} review=${reviewRaw.verdict} branch=${branch}`;
    await ctx.store.updateRun({ summary, result: { merged, branch, worktree: worktree.path, review: reviewRaw.verdict } });

    return { kind: "complete", state: { phase: "done" }, summary, result: { merged, branch, worktree: worktree.path, review: reviewRaw.verdict } };
  },
};

function parseReviewVerdict(text) {
  const n = text.toLowerCase();
  if (n.includes("verdict: block") || n.includes("overall: block") || n.includes("blocker")) return "block";
  if (n.includes("verdict: pass") || n.includes("overall: pass")) return "pass";
  return "unknown";
}
