import type { ResolutionContext } from "../actions/resolve.js";
import { refuse, unreadable, type Refusal } from "../actions/refusal.js";
import {
  readRecord,
  validateRecord,
  writeRecord,
  type FallbackScope,
  type FallbackStatus,
  type JevRecord,
} from "../project/records.js";
import { hasText } from "../validation.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import type { JevFailure } from "./client.js";

/**
 * Continuing without Jev (issue #18, D16, D17). Once a decision cannot be
 * answered, retries included, the fallback waits for the developer's
 * approval and keeps the pending decision. Approval covers the current
 * ticket or one stage, and the whole plan only when the developer broadens
 * it. The fallback's status stays on record, and in `status`, and every
 * change is logged in its history: a later answer returns to normal use at
 * that decision.
 */

const OFF: JevRecord = { fallback: { status: "off" } };

export function readJev(root: string): { readonly ok: true; readonly record: JevRecord } | Refusal {
  const read = readRecord(root, "jev");
  if (read.kind === "malformed") return unreadable("jev", read);
  return { ok: true, record: read.kind === "present" ? read.record : OFF };
}

function save(root: string, record: JevRecord): { readonly ok: true; readonly record: JevRecord } | Refusal {
  const next = validateRecord("jev", record);
  if (!next.ok) return refuse("the Jev fallback cannot be recorded", next.issues);
  writeRecord(root, "jev", next.record);
  return { ok: true, record: next.record };
}

function withChange(record: JevRecord, fallback: JevRecord["fallback"], at: string, note: string): JevRecord {
  return { ...record, fallback, history: [...(record.history ?? []), { status: fallback.status, at, note }] };
}

function assignedTicket(root: string): string | undefined {
  const progress = readRecord(root, "progress");
  return progress.kind === "present" ? progress.record.assignedTicketId : undefined;
}

/** Whether an approved fallback covers the decision being asked now: this ticket, this stage, or the whole plan. */
export function fallbackCovers(root: string, record: JevRecord, stage: string | undefined): boolean {
  const { fallback } = record;
  if (fallback.status !== "approved") return false;
  switch (fallback.scope) {
    case "plan":
      return true;
    case "ticket":
      return fallback.scopeId !== undefined && fallback.scopeId === assignedTicket(root);
    case "stage":
      return fallback.scopeId !== undefined && fallback.scopeId === stage;
    default:
      return false;
  }
}

/**
 * Records a decision Jev could not answer. An approved fallback that
 * covers it lets the work go on on the agent's own assessment; otherwise
 * the fallback waits for the developer with the decision pending.
 */
export function recordFailure(
  root: string,
  decision: string,
  failure: JevFailure,
  options: { readonly now: string; readonly stage?: string },
): { readonly ok: true; readonly fallback: Extract<FallbackStatus, "approved" | "awaiting-approval"> } | Refusal {
  const current = readJev(root);
  if (!current.ok) return current;
  const failed = { pendingDecision: decision, reason: failure.error, traceReference: failure.traceReference };
  if (fallbackCovers(root, current.record, options.stage)) {
    // Within the approval: the failure is kept on record, and the developer is not asked again (D17).
    const saved = save(root, { ...current.record, fallback: { ...current.record.fallback, ...failed } });
    return saved.ok ? { ok: true, fallback: "approved" } : saved;
  }
  const saved = save(
    root,
    withChange(current.record, { status: "awaiting-approval", ...failed }, options.now, `${decision} could not be answered: ${failure.error}`),
  );
  return saved.ok ? { ok: true, fallback: "awaiting-approval" } : saved;
}

/** Returns to normal Jev use at the decision that was answered, and records the change. */
export function recordRecovery(root: string, decision: string, options: { readonly now: string }): { readonly ok: true } | Refusal {
  const current = readJev(root);
  if (!current.ok) return current;
  if (current.record.fallback.status === "off") return { ok: true };
  const saved = save(root, withChange(current.record, { status: "off" }, options.now, `Jev recovered: ${decision} was answered`));
  return saved.ok ? { ok: true } : saved;
}

export interface FallbackApproval {
  /** `ticket` covers the ticket in progress; `stage` the named stage; `plan` is the developer's explicit broadening. */
  readonly scope: FallbackScope;
  readonly stage?: string;
  /** The developer's words. */
  readonly note: string;
}

export type ApprovalResult = { readonly ok: true; readonly outcome: { readonly fallback: JevRecord["fallback"] } } | Refusal;

/** Records the developer's approval to continue without Jev, for the scope they gave. */
export function approveFallback(
  root: string,
  approval: FallbackApproval,
  options: { readonly now: string; readonly context?: ResolutionContext },
): ApprovalResult {
  if (!hasText(approval?.note)) return refuse("continuing without Jev is the developer's decision; record it in their words");
  const current = readJev(root);
  if (!current.ok) return current;
  const { fallback } = current.record;
  if (fallback.status === "off") return refuse("Jev is in normal use; there is no fallback to approve");

  let scopeId: string | undefined;
  switch (approval.scope) {
    case "ticket":
      scopeId = assignedTicket(root);
      if (scopeId === undefined) return refuse("no ticket is in progress to scope the approval to; name a stage, or the whole plan");
      break;
    case "stage": {
      if (!hasText(approval.stage)) return refuse("name the stage the approval covers");
      const workflowPackage = options.context?.workflowPackage ?? loadShippedWorkflowPackage();
      const action = workflowPackage.actions.find((entry) => entry.name === approval.stage);
      if (action?.kind !== "stage") return refuse(`"${approval.stage}" is not a workflow stage`);
      scopeId = approval.stage;
      break;
    }
    case "plan":
      break;
    default:
      return refuse(`an approval covers a ticket, a stage or the whole plan, not "${String(approval.scope)}"`);
  }

  const approved: JevRecord["fallback"] = {
    status: "approved",
    ...(fallback.pendingDecision === undefined ? {} : { pendingDecision: fallback.pendingDecision }),
    ...(fallback.reason === undefined ? {} : { reason: fallback.reason }),
    ...(fallback.traceReference === undefined ? {} : { traceReference: fallback.traceReference }),
    scope: approval.scope,
    ...(scopeId === undefined ? {} : { scopeId }),
    approvedAt: options.now,
    approvalNote: approval.note.trim(),
  };
  const saved = save(
    root,
    withChange(current.record, approved, options.now, `continuing without Jev approved for ${approval.scope}${scopeId === undefined ? "" : ` ${scopeId}`}`),
  );
  if (!saved.ok) return saved;
  return { ok: true, outcome: { fallback: saved.record.fallback } };
}
