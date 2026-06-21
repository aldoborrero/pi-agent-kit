import { writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const GRIND_STRATEGIES = [
  { id: "minimal", label: "Minimal diff", instructions: "Prefer the smallest correct change. Reuse existing helpers and patterns. Avoid broad refactors unless absolutely necessary." },
  { id: "robust", label: "Robustness first", instructions: "Prioritize correctness and edge cases. Add or strengthen tests where needed." },
  { id: "simple", label: "Readability first", instructions: "Prefer simpler, clearer code and better naming. Avoid cleverness." },
  { id: "tests", label: "Tests-first", instructions: "Lead with tests or regression coverage when possible. Make the expected behavior explicit before or alongside implementation changes." },
  { id: "perf", label: "Performance-aware", instructions: "Be conservative about extra work in hot paths. Prefer low-overhead changes and mention tradeoffs." },
  { id: "cleanup", label: "Cleanup-biased", instructions: "Look for small adjacent cleanup opportunities that improve consistency without turning into a large refactor." },
];

const SPECIALIST_ROLES = [
  { id: "scholar", agent: "explore" },
  { id: "adversary", agent: "debug" },
  { id: "coverage", agent: "build" },
  { id: "profiler", agent: "explore" },
  { id: "refactor", agent: "build" },
  { id: "mutator", agent: "debug" },
];

const SPECIALIST_PROMPTS = {
  scholar: (task) => `You are the SCHOLAR specialist in a code grinder. Primary task/theme: ${task}. Scan the codebase for patterns, prior art, tricky edges. Write notes under .pi/workflows/artifacts/literature/. File backlog items under .pi/workflows/backlog/open/. Return a short summary.`,
  adversary: (task) => `You are the ADVERSARY specialist. Primary task/theme: ${task}. Look for edge cases, regressions, differential failures. Write findings under .pi/workflows/artifacts/adversarial/. File backlog items under .pi/workflows/backlog/open/. Return a concise summary.`,
  coverage: (task) => `You are the COVERAGE specialist. Primary task/theme: ${task}. Look for missing regression tests and edge-case coverage. Write notes under .pi/workflows/artifacts/coverage/. File backlog items under .pi/workflows/backlog/open/. Return a concise summary.`,
  profiler: (task) => `You are the PROFILER specialist. Primary task/theme: ${task}. Inspect hot paths and performance-sensitive areas. Write notes under .pi/workflows/artifacts/perf/. File backlog items under .pi/workflows/backlog/open/. Return a concise summary.`,
  refactor: (task) => `You are the REFACTOR specialist. Primary task/theme: ${task}. Look for dead code, helper extraction, consistency cleanups. Write notes under .pi/workflows/artifacts/refactor/. File backlog items under .pi/workflows/backlog/open/. Return a concise summary.`,
  mutator: (task) => `You are the MUTATOR specialist. Primary task/theme: ${task}. Search for nearby variants revealing hidden bugs. Write notes under .pi/workflows/artifacts/mutator/. File backlog items under .pi/workflows/backlog/open/. Return a concise summary.`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function parseGrindOptions(raw) {
  const parsed = parseArgsText(raw);
  if (typeof parsed === "string") {
    if (!parsed.trim()) throw new Error("/grind requires a task");
    return { task: parsed, candidates: 3, agent: "build", agentScope: "both", keepWorktrees: true, dryLimit: 2, triageAgent: "plan", reviewerAgent: "review", judgeAgent: "plan", metaAgent: "plan", autoMerge: true, autoReview: true, enableSpecialists: true };
  }
  if (!parsed || typeof parsed !== "object") throw new Error("/grind requires either a task string or an object like {task:'...', candidates:3}");
  const v = parsed;
  const task = typeof v.task === "string" ? v.task.trim() : "";
  if (!task) throw new Error("grind.task is required");
  return {
    task,
    candidates: typeof v.candidates === "number" ? Math.max(1, Math.min(6, Math.floor(v.candidates))) : 3,
    verify: typeof v.verify === "string" ? v.verify : undefined,
    agent: typeof v.agent === "string" ? v.agent : "build",
    triageAgent: typeof v.triageAgent === "string" ? v.triageAgent : "plan",
    reviewerAgent: typeof v.reviewerAgent === "string" ? v.reviewerAgent : "review",
    judgeAgent: typeof v.judgeAgent === "string" ? v.judgeAgent : "plan",
    metaAgent: typeof v.metaAgent === "string" ? v.metaAgent : "plan",
    agentScope: (v.agentScope === "project" || v.agentScope === "user" || v.agentScope === "both") ? v.agentScope : "both",
    baseRef: typeof v.baseRef === "string" ? v.baseRef : undefined,
    keepWorktrees: typeof v.keepWorktrees === "boolean" ? v.keepWorktrees : true,
    rounds: typeof v.rounds === "number" && Number.isFinite(v.rounds) ? Math.max(1, Math.floor(v.rounds)) : undefined,
    dryLimit: typeof v.dryLimit === "number" && Number.isFinite(v.dryLimit) ? Math.max(1, Math.floor(v.dryLimit)) : 2,
    autoMerge: typeof v.autoMerge === "boolean" ? v.autoMerge : true,
    autoReview: typeof v.autoReview === "boolean" ? v.autoReview : true,
    enableSpecialists: typeof v.enableSpecialists === "boolean" ? v.enableSpecialists : true,
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

function parseReviewVerdict(text) {
  const n = text.toLowerCase();
  if (n.includes("verdict: block") || n.includes("overall: block") || n.includes("blocker")) return "block";
  if (n.includes("verdict: pass") || n.includes("overall: pass")) return "pass";
  return "unknown";
}

function parseSelectedIds(output, ids, limit) {
  const matches = new Set();
  for (const id of ids) {
    const regex = new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_-])`, "m");
    if (regex.test(output)) matches.add(id);
  }
  return ids.filter(id => matches.has(id)).slice(0, limit);
}

function scoreCandidate(rec) {
  let score = 0;
  if (rec.exitCode === 0) score += 40; else score -= 40;
  if (rec.verify) score += rec.verify.exitCode === 0 ? 40 : -60;
  if (rec.review?.verdict === "pass") score += 30;
  if (rec.review?.verdict === "block") score -= 80;
  if (rec.commit) score += 10;
  if (rec.gitStatus?.trim()) score += 5;
  return score;
}

// ---------------------------------------------------------------------------
// Workflow spec
// ---------------------------------------------------------------------------

export default {
  name: "grind",
  description: "Parallel worktree grinder: create N isolated branches, dispatch subagents with distinct strategies, and summarize results.",

  parseInput(raw) { return { argsText: raw, options: parseGrindOptions(raw) }; },

  createRun(input) {
    return {
      title: `grind: ${input.options.task}`,
      summary: input.options.task,
      state: { phase: "execute", rounds: [], dryStreak: 0, specialistCursor: 0 },
      tags: ["grind"],
    };
  },

  async step(state, ctx) {
    const currentState = {
      phase: state.phase ?? "execute",
      rounds: Array.isArray(state.rounds) ? state.rounds : [],
      dryStreak: Number.isFinite(state.dryStreak) ? state.dryStreak : 0,
      specialistCursor: Number.isFinite(state.specialistCursor) ? state.specialistCursor : 0,
    };

    if (state.phase === "done") {
      const run = await ctx.store.getRun();
      const candidates = await ctx.candidates.list();
      return { kind: run.status === "failed" ? "failed" : "complete", state, summary: run.summary,
        ...(run.status === "failed" ? { error: run.error ?? "grind failed" } : { result: { status: run.status ?? "completed", rounds: currentState.rounds.length, merged: candidates.filter(c => c.merged).length } }) };
    }

    const repoRoot = ctx.cwd;
    const runId = ctx.runId;
    const manifest = await ctx.store.getRun();
    const argsValue = manifest.argsValue ?? {};
    const options = ("task" in argsValue) ? parseGrindOptions(JSON.stringify(argsValue)) : parseGrindOptions(manifest.argsText ?? "");

    // Dirty check
    let dirtyCheck = "";
    try { dirtyCheck = gitCmd(repoRoot, "status", "--porcelain"); } catch {}
    if (dirtyCheck.length > 0) {
      const proceed = await ctx.ui.confirm("Grind on dirty working tree?", "The repository has uncommitted changes. Continue anyway?");
      if (!proceed) throw new Error("Aborted by user because the working tree is dirty");
    }

    // Setup dirs
    [".pi/workflows/backlog/open", ".pi/workflows/backlog/in-progress", ".pi/workflows/backlog/done", ".pi/workflows/backlog/tried", ".pi/workflows/logs"].forEach(d => mkdirSync(join(repoRoot, d), { recursive: true }));
    const stopFile = join(repoRoot, ".pi/workflows/.grind-stop");
    let baseRef = options.baseRef;
    try { if (!baseRef) baseRef = gitCmd(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"); } catch { baseRef = "HEAD"; }
    if (!baseRef) baseRef = "HEAD";

    const logPath = join(repoRoot, ".pi/workflows/logs", `${runId}.log`);
    function logLine(line) { appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, "utf8"); }

    // Seed backlog if empty
    if (await ctx.backlog.count("open") === 0) {
      const item = await ctx.backlog.create(options.task, `Requested task: ${options.task}\n\nImplement this task in the repository. If too broad, choose the highest-leverage first slice.`, "task", { source: "user", priority: "high" });
      logLine(`seeded backlog with ${item.id}`);
    }

    logLine(`grind started: ${options.task}`);

    let candidates = await ctx.candidates.list();
    let rounds = currentState.rounds;
    let dryStreak = currentState.dryStreak;
    let specialistCursor = currentState.specialistCursor;
    const createdWorktrees = [];
    const artifactsBase = join(repoRoot, ".pi/workflows/runs", runId, "artifacts", "grind");
    mkdirSync(artifactsBase, { recursive: true });

    async function flush(patch) {
      await ctx.store.updateRun({
        ...patch,
        state: {
          phase: "execute",
          rounds,
          dryStreak,
          specialistCursor,
        },
      });
    }

    try {
      while (true) {
        if (existsSync(stopFile)) { await flush({ status: "stopped" }); break; }
        if (options.rounds !== undefined && rounds.length >= options.rounds) { await flush({ status: "completed" }); break; }

        // Pick items
        const openItems = await ctx.backlog.list("open");
        let picks = openItems.slice(0, options.candidates);
        if (openItems.length > 0) {
          const triagePrompt = [`You are the TRIAGE agent. Pick up to ${options.candidates} backlog items.`, `Primary task/theme: ${options.task}`, "Return ONLY the selected backlog IDs, one per line, with no prose.", "", "Open backlog:", ...openItems.map(i => `- ${i.id}: [priority=${i.metadata.priority}] [kind=${i.metadata.kind}] ${i.title}`)].join("\n");
          try {
            const triRes = await ctx.agents.run({ agent: options.triageAgent ?? "plan", task: triagePrompt, cwd: repoRoot, agentScope: options.agentScope ?? "both" });
            const pickedIds = parseSelectedIds(triRes.output || triRes.stdout, openItems.map(i => i.id), options.candidates);
            if (pickedIds.length > 0) picks = openItems.filter(i => pickedIds.includes(i.id)).slice(0, options.candidates);
          } catch {}
        }

        const roundNum = rounds.length + 1;
        const roundRec = { round: roundNum, startedAt: new Date().toISOString(), picks: picks.map(i => i.id), newBacklog: 0, dryStreakAfter: dryStreak, status: "running", candidates: [] };
        rounds.push(roundRec); await flush({});

        // Specialist
        if (options.enableSpecialists !== false) {
          const role = SPECIALIST_ROLES[specialistCursor % SPECIALIST_ROLES.length];
          const before = await ctx.backlog.count("open");
          const spRes = await ctx.agents.run({ agent: role.agent, task: SPECIALIST_PROMPTS[role.id](options.task), cwd: repoRoot, agentScope: options.agentScope ?? "both" });
          const after = await ctx.backlog.count("open");
          const spSum = summarizeText(spRes.output || spRes.stderr || spRes.stdout || "(no output)", 700);
          const specDir = join(repoRoot, ".pi/workflows/artifacts", role.id);
          mkdirSync(specDir, { recursive: true });
          const spPath = join(specDir, `${runId}-round-${String(roundNum).padStart(2, "0")}.md`);
          writeFileSync(spPath, `# ${role.id} — round ${roundNum}\n\n${spSum.trim()}\n`, "utf8");
          roundRec.specialist = { role: role.id, agent: role.agent, summary: `${spSum} [artifact: ${spPath}]`, importedBacklog: Math.max(0, after - before) };
          specialistCursor++; await flush({});
          logLine(`round ${roundNum}: specialist ${role.id} via ${role.agent} backlog+${roundRec.specialist.importedBacklog}`);
        }

        if (picks.length === 0) {
          dryStreak++;
          roundRec.status = existsSync(stopFile) ? "stopped" : "completed"; roundRec.endedAt = new Date().toISOString();
          roundRec.summary = "No picks this round."; roundRec.dryStreakAfter = dryStreak;
          const metaRes = await ctx.agents.run({ agent: options.metaAgent ?? "plan", task: `META round ${roundNum}: no picks. Theme: ${options.task}`, cwd: repoRoot, agentScope: options.agentScope ?? "both" });
          const metaSum = summarizeText(metaRes.output || metaRes.stderr || "(no output)", 700);
          mkdirSync(join(repoRoot, ".pi/workflows/artifacts/meta"), { recursive: true });
          const metaPath = join(repoRoot, ".pi/workflows/artifacts/meta", `${runId}-round-${String(roundNum).padStart(2, "0")}.md`);
          writeFileSync(metaPath, `# meta — round ${roundNum}\n\n${metaSum.trim()}\n`, "utf8");
          roundRec.meta = { agent: options.metaAgent ?? "plan", summary: `${metaSum} [artifact: ${metaPath}]` };
          await flush({ dryStreak }); logLine(`round ${roundNum}: dry streak ${dryStreak}/${options.dryLimit ?? 2}`);
          if (dryStreak >= (options.dryLimit ?? 2)) { await flush({ status: "completed" }); break; }
          continue;
        }

        const inProgressItems = await ctx.backlog.claim(picks.map(item => item.id), runId, roundNum);
        if (inProgressItems.length === 0) {
          roundRec.status = "completed";
          roundRec.endedAt = new Date().toISOString();
          roundRec.summary = "Picked items were claimed by another run.";
          await flush({});
          continue;
        }
        logLine(`round ${roundNum}: picks ${inProgressItems.map(i => i.id).join(", ")}`);
        const strategies = GRIND_STRATEGIES.slice(0, Math.max(1, Math.min(inProgressItems.length, GRIND_STRATEGIES.length)));

        // Run candidates in parallel
        const cResults = await Promise.all(inProgressItems.map(async (item, idx) => {
          const strat = strategies[idx % strategies.length];
          const slug = `${String(roundNum).padStart(2, "0")}-${String(idx + 1).padStart(2, "0")}-${strat.id}-${slugify(item.id, 24)}`;
          const branch = `grind/${slugify(runId, 24)}/${slug}`;
          const wtRoot = join(dirname(repoRoot), `${basename(repoRoot)}-workflows`, runId);
          mkdirSync(wtRoot, { recursive: true });
          const wtPath = join(wtRoot, slug);
          gitCmd(repoRoot, "worktree", "add", "-b", branch, wtPath, baseRef);
          createdWorktrees.push(wtPath);

          const prompt = [`You are candidate ${idx + 1} in round ${roundNum}. Strategy: ${strat.label}. ${strat.instructions}`, `Backlog: ${item.id} — ${item.title}`, "", item.body.trim(), "", "Work in this worktree/branch. Do NOT push.", options.verify ? `Verify with: ${options.verify}` : "Run the most relevant verification.", "File new backlog items under .pi/workflows/backlog/open/ for follow-ups.", "End with a concise summary."].join("\n");

          const ar = await ctx.agents.run({ agent: options.agent ?? "build", task: prompt, cwd: wtPath, agentScope: options.agentScope ?? "both" });
          writeFileSync(join(artifactsBase, `${slug}.stdout.log`), ar.stdout, "utf8");
          writeFileSync(join(artifactsBase, `${slug}.stderr.log`), ar.stderr, "utf8");

          let verifyRec;
          if (options.verify) {
            try { const { cmd, args } = parseVerifyCommand(options.verify); const vo = execFileSync(cmd, args, { cwd: wtPath, encoding: "utf-8", timeout: 30 * 60000 }); verifyRec = { command: options.verify, exitCode: 0, stdout: vo, stderr: "" }; }
            catch (e) { verifyRec = { command: options.verify, exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }; }
            writeFileSync(join(artifactsBase, `${slug}.verify.log`), `${verifyRec.stdout}\n${verifyRec.stderr}`.trim(), "utf8");
          }

          let commit;
          try { const st = gitCmd(wtPath, "status", "--porcelain"); if (st.length > 0) { gitCmd(wtPath, "add", "-A"); gitCmd(wtPath, "commit", "-m", `grind(${item.id}): ${item.title}`); commit = gitCmd(wtPath, "rev-parse", "HEAD"); } } catch {}

          const rev = await ctx.review.reviewCandidate({ worktree: wtPath, itemTitle: item.title, itemBody: item.body, candidateId: slug, candidateSummary: summarizeText(ar.output || ar.stderr || "(no output)", 700), agent: options.reviewerAgent ?? "review", agentScope: options.agentScope ?? "both" });
          const revRec = { agent: options.reviewerAgent ?? "review", verdict: parseReviewVerdict(rev.raw), summary: rev.summary, raw: rev.raw };

          let gs = "", ds = "";
          try { gs = gitCmd(wtPath, "status", "--short"); } catch {}
          try { ds = gitCmd(wtPath, "diff", "--stat"); } catch {}

          const accepted = ar.ok && (!verifyRec || verifyRec.exitCode === 0) && revRec.verdict !== "block";
          const nextItem = await ctx.backlog.move(item, accepted ? "done" : "tried", { owner: undefined, round: roundNum });
          await ctx.backlog.note(nextItem, [`Round: ${roundNum}`, `Candidate: ${slug}`, `Branch: ${branch}`, `Accepted: ${accepted ? "yes" : "no"}`, commit ? `Commit: ${commit}` : "Commit: none", verifyRec ? `Verify exit ${verifyRec.exitCode}` : "Verify: n/a"].join("\n"));

          const rec = { id: slug, label: strat.label, branch, worktree: wtPath, agent: options.agent ?? "build", backlogItemId: item.id, backlogItemTitle: item.title, round: roundNum, exitCode: ar.exitCode, verify: verifyRec, review: options.autoReview !== false ? revRec : undefined, gitStatus: gs, diffStat: ds, commit, summary: summarizeText(ar.output || ar.stderr || "(no output)", 600) };
          rec.score = scoreCandidate(rec);
          return { rec, accepted };
        }));

        const roundCands = cResults.map(r => r.rec);
        roundRec.candidates = roundCands;
        candidates.push(...roundCands);
        await Promise.all(roundCands.map((candidate) => ctx.candidates.upsert({
          id: candidate.id,
          runId,
          branch: candidate.branch,
          worktree: candidate.worktree,
          score: candidate.score,
          commit: candidate.commit,
          merged: candidate.merged,
          mergeError: candidate.mergeError,
          mergeCommit: candidate.mergeCommit,
          round: candidate.round,
          summary: candidate.summary,
          exitCode: candidate.exitCode,
          verifyExitCode: candidate.verify?.exitCode,
          reviewVerdict: candidate.review?.verdict,
        })));

        // Judge merge order
        const judged = await ctx.review.judgeCandidates({ repoRoot, task: options.task, candidates: roundCands.map(c => ({ id: c.id, score: c.score, exitCode: c.exitCode, verifyExitCode: c.verify?.exitCode, reviewVerdict: c.review?.verdict, summary: c.summary })), agent: options.judgeAgent ?? "plan", agentScope: options.agentScope ?? "both" });
        let mq = judged && judged.length > 0 ? judged.map(id => roundCands.find(c => c.id === id)).filter(Boolean) : [...roundCands].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        if (options.autoMerge !== false) {
          for (const c of mq) {
            if (!c.commit) { c.merged = false; c.mergeError = "no commit"; continue; }
            if (c.exitCode !== 0) { c.merged = false; c.mergeError = "agent failed"; continue; }
            if (c.verify && c.verify.exitCode !== 0) { c.merged = false; c.mergeError = "verify failed"; continue; }
            if (c.review?.verdict === "block") { c.merged = false; c.mergeError = "review blocked"; continue; }
            try {
              const cleanBefore = gitCmd(repoRoot, "status", "--porcelain");
              if (cleanBefore.length > 0) { c.merged = false; c.mergeError = "repo dirty"; continue; }
              try { execFileSync("git", ["-C", repoRoot, "cherry-pick", c.commit], { encoding: "utf-8", timeout: 600000 }); }
              catch (pe) { try { gitCmd(repoRoot, "cherry-pick", "--abort"); } catch {} c.merged = false; c.mergeError = "cherry-pick failed"; continue; }
              if (options.verify) {
                try { const { cmd, args } = parseVerifyCommand(options.verify); execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf-8", timeout: 30 * 60000 }); }
                catch { gitCmd(repoRoot, "revert", "--no-edit", "HEAD"); c.merged = false; c.mergeError = "post-merge verify failed"; continue; }
              }
              c.merged = true; c.mergeCommit = gitCmd(repoRoot, "rev-parse", "HEAD");
              logLine(`merge ${c.id}: ok ${c.mergeCommit}`);
            } catch (e) { try { gitCmd(repoRoot, "cherry-pick", "--abort"); } catch {} c.merged = false; c.mergeError = e.message ?? "merge failed"; }
            await ctx.candidates.upsert({
              id: c.id,
              runId,
              branch: c.branch,
              worktree: c.worktree,
              score: c.score,
              commit: c.commit,
              merged: c.merged,
              mergeError: c.mergeError,
              mergeCommit: c.mergeCommit,
              round: c.round,
              summary: c.summary,
              exitCode: c.exitCode,
              verifyExitCode: c.verify?.exitCode,
              reviewVerdict: c.review?.verdict,
            });
          }
        }

        roundRec.newBacklog = cResults.filter(r => r.accepted).length;
        dryStreak = 0;
        roundRec.status = existsSync(stopFile) ? "stopped" : "completed";
        roundRec.endedAt = new Date().toISOString();
        roundRec.summary = `accepted=${cResults.filter(r => r.accepted).length}/${cResults.length} merged=${roundCands.filter(c => c.merged).length}/${cResults.length}`;

        // Round meta
        const metaRes2 = await ctx.agents.run({ agent: options.metaAgent ?? "plan", task: `META round ${roundNum}: ${roundRec.summary}. Theme: ${options.task}. Candidates: ${roundCands.map(c => `${c.id} score=${c.score} merged=${c.merged}`).join("; ")}`, cwd: repoRoot, agentScope: options.agentScope ?? "both" });
        const metaSum2 = summarizeText(metaRes2.output || metaRes2.stderr || "(no output)", 700);
        mkdirSync(join(repoRoot, ".pi/workflows/artifacts/meta"), { recursive: true });
        const metaPath2 = join(repoRoot, ".pi/workflows/artifacts/meta", `${runId}-round-${String(roundNum).padStart(2, "0")}.md`);
        writeFileSync(metaPath2, `# meta — round ${roundNum}\n\n${metaSum2.trim()}\n`, "utf8");
        roundRec.meta = { agent: options.metaAgent ?? "plan", summary: `${metaSum2} [artifact: ${metaPath2}]` };
        await flush({});
        logLine(`round ${roundNum} done: ${roundRec.summary}`);

        if (existsSync(stopFile)) { await flush({ status: "stopped" }); break; }
      }

      // Finish
      const status = existsSync(stopFile) ? "stopped" : "completed";
      const oC = await ctx.backlog.count("open");
      const dC = await ctx.backlog.count("done");
      const tC = await ctx.backlog.count("tried");
      const summary = `Task: ${options.task}\nRounds: ${rounds.length}\nDry: ${dryStreak}\nOpen: ${oC}\nDone: ${dC}\nTried: ${tC}\nMerged: ${candidates.filter(c => c.merged).length}`;
      await flush({ status, endedAt: new Date().toISOString(), summary });
      ctx.ui.notify(`Grind finished: ${status}\nRun: ${runId}\nRounds: ${rounds.length}\nDone: ${dC}\nMerged: ${candidates.filter(c => c.merged).length}`, status === "completed" ? "info" : "warning");
      return {
        kind: "complete",
        state: { phase: "done", rounds, dryStreak, specialistCursor },
        summary,
        result: { status, rounds: rounds.length, merged: candidates.filter(c => c.merged).length },
      };
    } catch (err) {
      await flush({ status: "failed", endedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      if (!options.keepWorktrees) { for (const wt of createdWorktrees) { try { gitCmd(repoRoot, "worktree", "remove", "--force", wt); } catch {} } }
      try { rmSync(stopFile, { force: true }); } catch {}
    }
  },
};
