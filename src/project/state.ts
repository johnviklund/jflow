import { existsSync } from "node:fs";
import { join } from "node:path";

import { createWorkflowState, type WorkflowState } from "../actions/resolve.js";
import type { ValidationIssue } from "../workflow/types.js";
import { readRecord, writeRecord, type ProgressRecord } from "./records.js";

/**
 * The action resolver's view of the project: the `WorkflowState` derived from
 * the authoritative `progress` record (issue #3), plus Git presence, which is
 * observed from the directory and never recorded.
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

/**
 * Reads the workflow state from a project directory. An absent progress
 * record is an uninitialized project, not an error; a present but unreadable
 * one is a recoverable `malformed` result rather than a crash or a silent
 * default.
 */
export function readProjectState(root: string): ProjectStateResult {
  const git = gitRepositoryPresent(root);
  const read = readRecord(root, "progress");

  if (read.kind === "absent") {
    return { kind: "uninitialized", state: createWorkflowState({ gitRepositoryPresent: git }) };
  }
  if (read.kind === "malformed") {
    return {
      kind: "malformed",
      path: read.path,
      issues: read.issues,
      message: read.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    };
  }

  const { specificationAccepted, planAccepted, executionAuthorized, ticketChangesPresent } =
    read.record;
  return {
    kind: "initialized",
    state: {
      specificationAccepted,
      planAccepted,
      executionAuthorized,
      ticketChangesPresent,
      ...(read.record.assignedTicketId === undefined
        ? {}
        : { assignedTicketId: read.record.assignedTicketId }),
      gitRepositoryPresent: git,
    },
  };
}

/**
 * Writes the workflow flags into the progress record, keeping whatever else
 * the record holds (fix attempts, reconciliation). Git presence is never
 * written.
 *
 * @throws {Error} when the existing progress record is malformed; a flag
 *   update never overwrites a record it could not read.
 */
export function writeProjectState(root: string, state: WorkflowState): void {
  const existing = readRecord(root, "progress");
  if (existing.kind === "malformed") {
    throw new Error(
      `cannot update a malformed progress record at ${existing.path}; repair or remove it first`,
    );
  }
  const { gitRepositoryPresent: _observed, assignedTicketId, ...flags } = state;
  const previous: Partial<ProgressRecord> = existing.kind === "present" ? existing.record : {};
  const { assignedTicketId: _previous, authorizationScope, ...kept } = previous;

  // A flag update carries no scope, so a fresh authorization is recorded at
  // the narrowest scope; whole-plan authorization needs the explicit words
  // (SPEC.md D28, D29). Withdrawing authorization withdraws the scope too.
  const record: ProgressRecord = {
    ...kept,
    ...flags,
    ...(flags.executionAuthorized ? { authorizationScope: authorizationScope ?? "ticket" } : {}),
    ...(assignedTicketId === undefined ? {} : { assignedTicketId }),
  };
  writeRecord(root, "progress", record);
}
