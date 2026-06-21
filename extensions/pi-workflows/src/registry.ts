import type { WorkflowSpec } from "./api.js";

export type RegisteredWorkflow = { kind: "step"; spec: WorkflowSpec };

export function stepWorkflow(spec: WorkflowSpec): RegisteredWorkflow {
  return { kind: "step", spec };
}

export function getWorkflowName(workflow: RegisteredWorkflow): string {
  return workflow.spec.name;
}

export function getWorkflowDescription(workflow: RegisteredWorkflow): string {
  return workflow.spec.description;
}

export function createWorkflowRegistry(initial: RegisteredWorkflow[] = []) {
  const items = new Map<string, RegisteredWorkflow>();

  for (const workflow of initial) {
    items.set(getWorkflowName(workflow).toLowerCase(), workflow);
  }

  return {
    register(workflow: RegisteredWorkflow): void {
      items.set(getWorkflowName(workflow).toLowerCase(), workflow);
    },
    get(name: string): RegisteredWorkflow | undefined {
      return items.get(name.trim().toLowerCase());
    },
    list(): RegisteredWorkflow[] {
      return [...items.values()].sort((a, b) => getWorkflowName(a).localeCompare(getWorkflowName(b)));
    },
  };
}
