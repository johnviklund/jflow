import { readProjectState } from "../project/state.js";
import {
  resolveAction,
  type ResolutionContext,
  type UnmetPrerequisite,
  type WorkflowState,
} from "./resolve.js";

export interface ActionStatus {
  readonly name: string;
  readonly status: "eligible" | "blocked";
  readonly unmet: readonly UnmetPrerequisite[];
}

/**
 * What `status` tells the developer: how the project was read, the workflow
 * state, and which actions could run now. A record that cannot be read yields
 * only the problem; no state or eligibility is reported in its place.
 */
export type StatusReport =
  | {
      readonly project: "uninitialized" | "initialized";
      readonly state: WorkflowState;
      readonly actions: readonly ActionStatus[];
    }
  | { readonly project: "malformed"; readonly path: string; readonly problem: string };

/**
 * Runs the always-available `status` action against a project directory
 * (SPEC.md D25). It reads project files only and writes nothing.
 */
export function runStatus(root: string, context: ResolutionContext): StatusReport {
  const read = readProjectState(root);
  if (read.kind === "malformed") {
    return { project: "malformed", path: read.path, problem: read.message };
  }

  const actions = context.workflowPackage.actions.map((action): ActionStatus => {
    const resolution = resolveAction({ action: action.name }, read.state, context);
    return resolution.status === "blocked"
      ? { name: action.name, status: "blocked", unmet: resolution.unmet }
      : { name: action.name, status: "eligible", unmet: [] };
  });

  return { project: read.kind, state: read.state, actions };
}
