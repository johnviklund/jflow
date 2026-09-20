import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createWorkflowState, type WorkflowState } from "../actions/resolve.js";

/**
 * Walking-skeleton persistence of the workflow state (issue #1). The
 * authoritative record store, with its own layout for plans, tickets,
 * progress and lessons, is issue #3; this file holds only the flags the
 * action resolver needs so that `status` can be read from project files today.
 *
 * Records live under a version-controlled `jflow/` directory, not under the
 * local-only `.jflow/` trace directory (SPEC.md D14, D23).
 */
export const PROJECT_RECORD_DIRECTORY = "jflow";
export const PROJECT_STATE_FILE = "state.json";

/** The recorded part of the state; Git presence is observed, never recorded. */
type RecordedState = Omit<WorkflowState, "gitRepositoryPresent">;

export type ProjectStateResult =
  | { readonly kind: "uninitialized"; readonly state: WorkflowState }
  | { readonly kind: "initialized"; readonly state: WorkflowState }
  | {
      /** A record exists but cannot be trusted; no state is offered in its place. */
      readonly kind: "malformed";
      readonly path: string;
      readonly message: string;
    };

type ParsedRecord =
  | { readonly ok: true; readonly state: RecordedState }
  | { readonly ok: false; readonly message: string };

const BOOLEAN_FIELDS = [
  "specificationAccepted",
  "planAccepted",
  "executionAuthorized",
  "ticketChangesPresent",
] as const;

export function projectStatePath(root: string): string {
  return join(root, PROJECT_RECORD_DIRECTORY, PROJECT_STATE_FILE);
}

function gitRepositoryPresent(root: string): boolean {
  return existsSync(join(root, ".git"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecordedState(document: unknown): ParsedRecord {
  if (!isRecord(document)) {
    return { ok: false, message: "the state record must be a JSON object" };
  }

  const flags: Partial<Record<(typeof BOOLEAN_FIELDS)[number], boolean>> = {};
  for (const key of BOOLEAN_FIELDS) {
    const value = document[key];
    if (typeof value !== "boolean") {
      return { ok: false, message: `"${key}" must be a boolean` };
    }
    flags[key] = value;
  }

  const assigned = document["assignedTicketId"];
  if (assigned !== undefined && typeof assigned !== "string") {
    return { ok: false, message: `"assignedTicketId" must be a string when present` };
  }

  return {
    ok: true,
    state: {
      specificationAccepted: flags.specificationAccepted === true,
      planAccepted: flags.planAccepted === true,
      executionAuthorized: flags.executionAuthorized === true,
      ticketChangesPresent: flags.ticketChangesPresent === true,
      ...(typeof assigned === "string" ? { assignedTicketId: assigned } : {}),
    },
  };
}

/**
 * Reads the workflow state from a project directory. An absent record is an
 * uninitialized project, not an error; a present but unreadable record is a
 * recoverable `malformed` result rather than a crash or a silent default.
 */
export function readProjectState(root: string): ProjectStateResult {
  const path = projectStatePath(root);
  const git = gitRepositoryPresent(root);

  if (!existsSync(path)) {
    return { kind: "uninitialized", state: createWorkflowState({ gitRepositoryPresent: git }) };
  }

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "malformed", path, message: `state record is not valid JSON: ${message}` };
  }

  const parsed = parseRecordedState(document);
  if (!parsed.ok) {
    return { kind: "malformed", path, message: parsed.message };
  }

  return { kind: "initialized", state: { ...parsed.state, gitRepositoryPresent: git } };
}

/** Writes the recorded part of the state; Git presence is never written. */
export function writeProjectState(root: string, state: WorkflowState): void {
  const { gitRepositoryPresent: _observed, ...recorded } = state;
  mkdirSync(join(root, PROJECT_RECORD_DIRECTORY), { recursive: true });
  writeFileSync(projectStatePath(root), `${JSON.stringify(recorded, null, 2)}\n`);
}
