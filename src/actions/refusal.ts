import type { RecordKind, RecordReadResult } from "../project/records.js";
import type { ProjectStateResult } from "../project/state.js";
import type { ValidationIssue } from "../workflow/types.js";

/**
 * How a helper operation says no: a reason for the developer and, when the
 * refusal is a validation failure, the offending paths. Shared by every
 * action module so the skill reads one shape.
 */
export interface Refusal {
  readonly ok: false;
  readonly reason: string;
  readonly issues?: readonly ValidationIssue[];
}

export function refuse(reason: string, issues?: readonly ValidationIssue[]): Refusal {
  return issues === undefined ? { ok: false, reason } : { ok: false, reason, issues };
}

/** A record exists but cannot be trusted; nothing proceeds on a guess about it. */
export function unreadable(
  kind: RecordKind,
  read: Extract<RecordReadResult<RecordKind>, { kind: "malformed" }>,
): Refusal {
  return refuse(`the ${kind} record at ${read.path} cannot be read`, read.issues);
}

/** The project state cannot be derived because one of its records is unreadable. */
export function unreadableState(read: Extract<ProjectStateResult, { kind: "malformed" }>): Refusal {
  return refuse(`the record at ${read.path} cannot be read`, read.issues);
}
