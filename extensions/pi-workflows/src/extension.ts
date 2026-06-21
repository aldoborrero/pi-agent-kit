// Extension entry point — re-exports the workflow orchestration engine.
// See also: engine.ts (runner, storage, core types)
//           loader.ts (spec discovery, registry)
//           grinder.ts (domain: backlog, worktrees, agents, CLI commands)

export { default } from "./grinder.js";
