import {
  createWorkflowState,
  type ObservedStateField,
  type WorkflowState,
} from "../actions/resolve.js";
import type { ValidationIssue } from "../workflow/types.js";
import { admittedToReview, readRecord, type ProgressRecord } from "./records.js";
import { readWorkingTree } from "./worktree.js";

/**
 * The action resolver's view of the project: the `WorkflowState` derived from
 * the authoritative records (issue #3) — the specification and the plan for
 * their acceptance gates (D27, D28), the progress record for the rest — plus
 * the working tree, which is observed through Git on every read and never
 * recorded: whether a repository is present, and which uncommitted changes
 * have no recorded owner (issue #7).
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

type ObservedState = Pick<WorkflowState, ObservedStateField>;

/**
 * A change is claimed when the developer kept it, when the assigned ticket
 * adopted it, or once the assigned ticket's work has begun. `implement`
 * cannot start while any change is unclaimed, so what appears after that is
 * presumed the ticket's. Git cannot tell the agent's edits from the
 * developer's own edits made mid-ticket: the ticket's commit (#10) carries
 * every change the developer did not keep, and lists the paths it
 * committed and left out; resume reconciliation (#22) checks it again.
 * This presumption makes `git.changesOwned` on `review` inert.
 */
function observeWorkingTree(root: string, progress: ProgressRecord | undefined): ObservedState {
  const tree = readWorkingTree(root);
  if (tree.kind === "absent") return { gitRepositoryPresent: false, unclaimedChanges: [] };
  if (tree.kind === "unreadable") {
    return { gitRepositoryPresent: false, gitRepositoryUnreadable: tree.message, unclaimedChanges: [] };
  }
  if (progress?.ticketChangesPresent) return { gitRepositoryPresent: true, unclaimedChanges: [] };
  const claimed = new Set(
    (progress?.changeOwnership ?? [])
      .filter((entry) => entry.owner === "developer" || entry.ticketId === progress?.assignedTicketId)
      .map((entry) => entry.path),
  );
  return {
    gitRepositoryPresent: true,
    unclaimedChanges: tree.changedPaths.filter((path) => !claimed.has(path)),
  };
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
  const specification = readRecord(root, "specification");
  if (specification.kind === "malformed") return malformed(specification.path, specification.issues);
  const plan = readRecord(root, "plan");
  if (plan.kind === "malformed") return malformed(plan.path, plan.issues);
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return malformed(progress.path, progress.issues);

  if (specification.kind === "absent" && plan.kind === "absent" && progress.kind === "absent") {
    return { kind: "uninitialized", state: createWorkflowState(observeWorkingTree(root, undefined)) };
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
      ticketAdmittedToReview:
        recorded?.assignedTicketId !== undefined && admittedToReview(recorded, recorded.assignedTicketId),
      ...(recorded?.assignedTicketId === undefined
        ? {}
        : { assignedTicketId: recorded.assignedTicketId }),
      ...observeWorkingTree(root, recorded),
    },
  };
}
