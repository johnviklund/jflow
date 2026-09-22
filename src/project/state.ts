import { existsSync } from "node:fs";
import { join } from "node:path";

import { createWorkflowState, type WorkflowState } from "../actions/resolve.js";
import type { ValidationIssue } from "../workflow/types.js";
import { readRecord } from "./records.js";

/**
 * The action resolver's view of the project: the `WorkflowState` derived from
 * the authoritative records (issue #3) — the specification and the plan for
 * their acceptance gates (D27, D28), the progress record for the rest — plus
 * Git presence, which is observed from the directory and never recorded.
 */

export type ProjectStateResult =
  | { readonly kind: "uninitialized"; readonly state: WorkflowState }
  | { readonly kind: "initialized"; readonly state: WorkflowState }
  | {
      /** A record exists but cannot be trusted; no state is offered in its place. */
      readonly kind: "malformed";
      readonly path: string;
      readonly issues: readonly ValidationIssue[];
      /** The issues as one line, for reports. */
      readonly message: string;
    };

function gitRepositoryPresent(root: string): boolean {
  return existsSync(join(root, ".git"));
}

function malformed(path: string, issues: readonly ValidationIssue[]): ProjectStateResult {
  return {
    kind: "malformed",
    path,
    issues,
    message: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
  };
}

/**
 * Reads the workflow state from a project directory. No records at all is an
 * uninitialized project, not an error; an unreadable record is a recoverable
 * `malformed` result rather than a crash or a silent default.
 */
export function readProjectState(root: string): ProjectStateResult {
  const git = gitRepositoryPresent(root);
  const specification = readRecord(root, "specification");
  if (specification.kind === "malformed") return malformed(specification.path, specification.issues);
  const plan = readRecord(root, "plan");
  if (plan.kind === "malformed") return malformed(plan.path, plan.issues);
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return malformed(progress.path, progress.issues);

  if (specification.kind === "absent" && plan.kind === "absent" && progress.kind === "absent") {
    return { kind: "uninitialized", state: createWorkflowState({ gitRepositoryPresent: git }) };
  }

  const specificationAccepted =
    specification.kind === "present" && specification.record.status === "accepted";
  const planAccepted = plan.kind === "present" && plan.record.status === "accepted";
  const recorded = progress.kind === "present" ? progress.record : undefined;
  return {
    kind: "initialized",
    state: {
      specificationAccepted,
      planAccepted,
      executionAuthorized: recorded?.executionAuthorized ?? false,
      ticketChangesPresent: recorded?.ticketChangesPresent ?? false,
      ...(recorded?.assignedTicketId === undefined
        ? {}
        : { assignedTicketId: recorded.assignedTicketId }),
      gitRepositoryPresent: git,
    },
  };
}
