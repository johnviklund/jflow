import {
  EMPTY_PROGRESS,
  readRecord,
  validateRecord,
  writeRecord,
  type AuthorizationScope,
  type PlanRecord,
  type ProgressRecord,
  type TicketRecord,
  type TicketsRecord,
} from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { isRecord } from "../validation.js";
import { refuse, unreadable, unreadableState, type Refusal } from "./refusal.js";

/**
 * The helper's part of `plan` (issue #6, D28, D41, D51): writing the ticket
 * breakdown the skill's method produced, refusing a ticket without
 * acceptance criteria, and recording plan acceptance separately from
 * execution authorization, which one instruction may still grant together.
 * Slicing and wording are the skill's; nothing here judges content.
 */

export interface TicketDraft {
  readonly id: string;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependsOn: readonly string[];
}

export interface PlanDraft {
  readonly title: string;
  readonly summary: string;
  readonly source?: string;
  readonly tickets: readonly TicketDraft[];
}

export interface PlanOutcome {
  readonly plan: PlanRecord;
  readonly tickets: TicketsRecord;
  readonly progress: ProgressRecord;
}

export type PlanResult = { readonly ok: true; readonly outcome: PlanOutcome } | Refusal;

/** What the developer authorized, in their words (D28). */
export interface Authorization {
  readonly scope: AuthorizationScope;
  /** Required for ticket scope: the one ticket the developer named. */
  readonly ticketId?: string;
  readonly note: string;
}

type Progressed = { readonly ok: true; readonly progress: ProgressRecord } | Refusal;

/** Reports the first ticket on a dependency cycle, or undefined when the graph is acyclic. */
function findDependencyCycle(tickets: readonly TicketRecord[]): string | undefined {
  const dependencies = new Map(tickets.map((ticket) => [ticket.id, ticket.dependsOn]));
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (id: string): boolean => {
    if (onPath.has(id)) return true;
    if (done.has(id)) return false;
    onPath.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    onPath.delete(id);
    done.add(id);
    return false;
  };
  return tickets.map((ticket) => ticket.id).find((id) => visit(id));
}

/**
 * Shapes the drafted tickets into a record document without trusting the
 * draft: the record validator judges every field, then the cycle check runs
 * on validated tickets, since a cycle passes validation yet would leave its
 * tickets never eligible.
 */
function validateTickets(
  drafts: unknown,
): { readonly ok: true; readonly tickets: TicketsRecord } | Refusal {
  const document = {
    tickets: Array.isArray(drafts)
      ? drafts.map((ticket: unknown) =>
          isRecord(ticket)
            ? { ...ticket, status: "ready", dependsOn: ticket["dependsOn"] ?? [] }
            : ticket,
        )
      : drafts,
  };
  const validated = validateRecord("tickets", document);
  if (!validated.ok) return refuse("the ticket breakdown is not complete", validated.issues);
  if (validated.record.tickets.length === 0) return refuse("a plan needs at least one ticket");
  const cyclic = findDependencyCycle(validated.record.tickets);
  if (cyclic !== undefined) {
    return refuse(
      `the ticket dependencies form a cycle through "${cyclic}"; no ticket on it could ever start`,
    );
  }
  return { ok: true, tickets: validated.record };
}

function readProgress(root: string): Progressed {
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return unreadable("progress", progress);
  return { ok: true, progress: progress.kind === "present" ? progress.record : EMPTY_PROGRESS };
}

function readTickets(root: string): TicketsRecord {
  const tickets = readRecord(root, "tickets");
  return tickets.kind === "present" ? tickets.record : { tickets: [] };
}

/**
 * Writes the breakdown awaiting acceptance, every ticket ready. Refused
 * unless the specification is accepted (D27), when any ticket lacks
 * acceptance criteria (D41), and when the plan is already accepted, since
 * changing an agreed plan is `realign`'s job (D42). Nothing is written
 * unless both records validate. The progress record is kept as it is: an
 * unaccepted plan cannot have been authorized, and any fix counters or
 * discrepancies it holds are the developer's history, not the plan's.
 */
export function writePlan(
  root: string,
  draft: PlanDraft,
  options: { readonly now: string },
): PlanResult {
  const state = readProjectState(root);
  if (state.kind === "malformed") return unreadableState(state);
  if (!state.state.specificationAccepted) {
    return refuse(
      "the specification has not been explicitly accepted; a plan cannot be made against an unagreed definition",
    );
  }
  const existing = readRecord(root, "plan");
  if (existing.kind === "malformed") return unreadable("plan", existing);
  if (existing.kind === "present" && existing.record.status === "accepted") {
    return refuse(
      "the plan has been accepted; changing it is a plan change, so invoke realign rather than plan again",
    );
  }

  const tickets = validateTickets(draft.tickets);
  if (!tickets.ok) return tickets;
  const plan = validateRecord("plan", {
    title: draft.title,
    summary: draft.summary,
    ...(draft.source === undefined ? {} : { source: draft.source }),
    status: "awaiting-acceptance",
    writtenAt: options.now,
  });
  if (!plan.ok) return refuse("the plan is not complete", plan.issues);
  const progress = readProgress(root);
  if (!progress.ok) return progress;

  writeRecord(root, "tickets", tickets.tickets);
  writeRecord(root, "plan", plan.record);
  return {
    ok: true,
    outcome: { plan: plan.record, tickets: tickets.tickets, progress: progress.progress },
  };
}

/** Applies an authorization to the progress record, checking a named ticket exists. */
function authorize(root: string, progress: ProgressRecord, authorization: Authorization): Progressed {
  const { assignedTicketId: _previous, ...rest } = progress;
  if (authorization.scope === "plan") {
    if (authorization.ticketId !== undefined) {
      return refuse(
        "whole-plan authorization names no single ticket; drop the ticket or use ticket scope",
      );
    }
    return {
      ok: true,
      progress: {
        ...rest,
        executionAuthorized: true,
        authorizationScope: "plan",
        authorizationNote: authorization.note,
      },
    };
  }
  if (authorization.ticketId === undefined) {
    return refuse("authorization for one ticket must name that ticket");
  }
  const known = readTickets(root).tickets.map((ticket) => ticket.id);
  if (!known.includes(authorization.ticketId)) {
    return refuse(
      `no ticket "${authorization.ticketId}" in the plan; tickets are ${known.join(", ") || "none"}`,
    );
  }
  return {
    ok: true,
    progress: {
      ...rest,
      executionAuthorized: true,
      authorizationScope: "ticket",
      authorizationNote: authorization.note,
      assignedTicketId: authorization.ticketId,
    },
  };
}

/**
 * Records the developer's acceptance of the breakdown (D28). "Looks good"
 * accepts without authorizing; an instruction that also authorizes passes
 * `authorize`, and both are recorded in one step, both validated first.
 */
export function acceptPlan(
  root: string,
  options: { readonly now: string; readonly note?: string; readonly authorize?: Authorization },
): PlanResult {
  const existing = readRecord(root, "plan");
  if (existing.kind === "absent") return refuse("no plan has been written; run plan first");
  if (existing.kind === "malformed") return unreadable("plan", existing);
  if (existing.record.status === "accepted") {
    return refuse(`the plan was already accepted at ${existing.record.acceptedAt}`);
  }

  const current = readProgress(root);
  if (!current.ok) return current;
  const authorized = options.authorize
    ? authorize(root, current.progress, options.authorize)
    : current;
  if (!authorized.ok) return authorized;

  const plan = validateRecord("plan", {
    ...existing.record,
    status: "accepted",
    acceptedAt: options.now,
    ...(options.note === undefined ? {} : { acceptanceNote: options.note }),
  });
  if (!plan.ok) return refuse("the plan cannot be accepted as recorded", plan.issues);
  const progress = validateRecord("progress", authorized.progress);
  if (!progress.ok) return refuse("the progress record cannot be updated", progress.issues);

  writeRecord(root, "plan", plan.record);
  if (options.authorize) writeRecord(root, "progress", progress.record);
  return {
    ok: true,
    outcome: { plan: plan.record, tickets: readTickets(root), progress: progress.record },
  };
}

/**
 * Records execution authorization given after acceptance, scoped to one
 * ticket or the whole plan (D28, D29). Refused while the plan is unaccepted:
 * there is nothing agreed to authorize.
 */
export function authorizeExecution(root: string, authorization: Authorization): PlanResult {
  const existing = readRecord(root, "plan");
  if (existing.kind === "absent") return refuse("no plan has been written; run plan first");
  if (existing.kind === "malformed") return unreadable("plan", existing);
  if (existing.record.status !== "accepted") {
    return refuse("the plan has not been accepted; execution cannot be authorized before acceptance");
  }

  const current = readProgress(root);
  if (!current.ok) return current;
  const authorized = authorize(root, current.progress, authorization);
  if (!authorized.ok) return authorized;
  const progress = validateRecord("progress", authorized.progress);
  if (!progress.ok) return refuse("the progress record cannot be updated", progress.issues);

  writeRecord(root, "progress", progress.record);
  return {
    ok: true,
    outcome: { plan: existing.record, tickets: readTickets(root), progress: progress.record },
  };
}
