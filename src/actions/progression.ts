import type { DecisionDependencies } from "../jev/decisions.js";
import { askEscalation, humanAskAt, type EscalationAsk } from "../jev/escalation.js";
import {
  EMPTY_PROGRESS,
  readRecord,
  validateRecord,
  writeRecord,
  type ChangeOwnership,
  type IndependenceCheck,
  type ProgressRecord,
  type TicketRecord,
  type TicketsRecord,
} from "../project/records.js";
import { readWorkingTree } from "../project/worktree.js";
import { hasText } from "../validation.js";
import { readWorkingTicket, startTicket, type StartedTicket } from "./implement.js";
import { independenceGap, parkedDependency, parkedTickets, partialEdits } from "./independence.js";
import { isOpen, planCompletion } from "./plan-review.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";

/**
 * Moving through the plan one ticket at a time (issue #12, D29, D30, D44).
 * `nextTicket` picks the next eligible ticket and, under whole-plan
 * authorization, asks `escalate` at `next-ticket`: `proceed` starts it with
 * no prompt, anything else asks the developer. Without whole-plan
 * authorization the developer is asked without a Jev call. When nothing
 * can safely proceed it says why and starts nothing.
 *
 * `parkTicket` records a blocked ticket as parked with its blocker, never
 * done, and keeps its partial edits as its own. `recordIndependence`
 * records why a ready ticket may start beside the parked ones. Neither
 * touches the recorded authorization.
 */

export interface ParkedSummary {
  readonly id: string;
  readonly blocker: string;
  readonly partialEdits: readonly string[];
}

export type NextResult =
  | ({ readonly kind: "started"; readonly escalation?: string } & StartedTicket)
  | { readonly kind: "ask"; readonly ticket: string; readonly askHuman: EscalationAsk; readonly escalation?: string }
  | { readonly kind: "needs-independence-check"; readonly candidates: readonly string[]; readonly parked: readonly ParkedSummary[] }
  | { readonly kind: "waiting"; readonly reasons: readonly string[] }
  | { readonly kind: "needs-plan-review"; readonly reason: string }
  | { readonly kind: "finished" }
  | { readonly kind: "refused"; readonly reason: string };

interface Records {
  readonly tickets: TicketsRecord;
  readonly progress: ProgressRecord;
}

function readRecords(root: string): { readonly ok: true; readonly records: Records } | Refusal {
  const tickets = readRecord(root, "tickets");
  if (tickets.kind === "malformed") return unreadable("tickets", tickets);
  if (tickets.kind === "absent") return refuse("there is no ticket breakdown");
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return unreadable("progress", progress);
  return {
    ok: true,
    records: { tickets: tickets.record, progress: progress.kind === "present" ? progress.record : EMPTY_PROGRESS },
  };
}

function summarizeParked(records: Records): readonly ParkedSummary[] {
  return parkedTickets(records.tickets).map((ticket) => ({
    id: ticket.id,
    // The tickets record requires a parked ticket's reason.
    blocker: ticket.parkedReason!,
    partialEdits: partialEdits(records.progress, [ticket.id]),
  }));
}


/** Why each open ticket cannot start now, for a report that starts nothing. */
function waitingReasons(tickets: TicketsRecord): readonly string[] {
  const byId = new Map(tickets.tickets.map((ticket) => [ticket.id, ticket]));
  return tickets.tickets.filter(isOpen).map((ticket) => {
    if (ticket.status === "parked") return `${ticket.id} is parked: ${ticket.parkedReason!}`;
    const waiting = ticket.dependsOn.filter((id) => byId.get(id)?.status !== "done");
    const blocker = parkedDependency(tickets, ticket.id);
    return `${ticket.id} depends on ${waiting.join(", ")}${blocker === undefined ? "" : `, and so waits for parked ${blocker}`}`;
  });
}

/**
 * Selects the next eligible ticket, in plan order, and starts it when the
 * authorization and `escalate` allow. A ready ticket is eligible once its
 * dependencies are done and, beside a parked ticket, it has an independence
 * check covering every parked one.
 */
export async function nextTicket(root: string, dependencies: DecisionDependencies): Promise<NextResult> {
  const read = readRecords(root);
  if (!read.ok) return { kind: "refused", reason: read.reason };
  const { tickets, progress } = read.records;
  const active = tickets.tickets.find((ticket) => ticket.status === "in-progress");
  if (active !== undefined) {
    return { kind: "refused", reason: `ticket ${active.id} is in progress; it passes review or is parked before the next starts` };
  }
  if (!tickets.tickets.some(isOpen)) {
    const completion = planCompletion(tickets, progress);
    return completion.complete ? { kind: "finished" } : { kind: "needs-plan-review", reason: completion.reason };
  }

  const done = new Set(tickets.tickets.filter((ticket) => ticket.status === "done").map((ticket) => ticket.id));
  const ready = tickets.tickets.filter((ticket) => ticket.status === "ready" && ticket.dependsOn.every((id) => done.has(id)));
  const summary = (id: string, title: string) =>
    `Start ticket ${id} (${title}) next. Done: ${[...done].join(", ") || "none"}. Parked: ${
      parkedTickets(tickets)
        .map((ticket) => ticket.id)
        .join(", ") || "none"
    }.`;
  const candidate = ready.find((ticket) => parkedDependency(tickets, ticket.id) === undefined);
  if (candidate !== undefined && (!progress.executionAuthorized || progress.authorizationScope !== "plan")) {
    // Only the developer widens authorization, so no Jev call; an independence check still comes before the start.
    const scope = progress.executionAuthorized
      ? `execution is authorized for ticket ${progress.assignedTicketId ?? "one ticket"} only`
      : "execution is not authorized";
    return {
      kind: "ask",
      ticket: candidate.id,
      askHuman: humanAskAt(
        "next-ticket",
        summary(candidate.id, candidate.title),
        `${scope}; starting ${candidate.id} needs your authorization, and Jev is not asked`,
      ),
    };
  }

  const startable = ready.filter((ticket) => independenceGap(tickets, progress, ticket.id) === undefined);
  const target = startable[0];
  if (target === undefined) {
    const checkable = ready.filter((ticket) => parkedDependency(tickets, ticket.id) === undefined);
    if (checkable.length > 0) {
      return {
        kind: "needs-independence-check",
        candidates: checkable.map((ticket) => ticket.id),
        parked: summarizeParked(read.records),
      };
    }
    return { kind: "waiting", reasons: waitingReasons(tickets) };
  }

  const boundary = summary(target.id, target.title);

  // Every start under whole-plan authorization is the next-ticket boundary, the first one included (D44).
  const check = progress.independenceChecks?.[target.id];
  const asked = await askEscalation(
    root,
    {
      kind: "next-ticket",
      summary: boundary,
      excerpts: [
        ...summarizeParked(read.records).map((parked) => ({ source: `parked ${parked.id}`, text: parked.blocker })),
        ...(check === undefined
          ? []
          : [{ source: "independence check", text: `${check.dependencies} ${check.decisions} ${check.partialEdits}` }]),
      ],
    },
    dependencies,
  );
  if (asked.kind === "refused") return { kind: "refused", reason: asked.reason };
  const escalation = asked.kind === "answered" ? asked.envelope : undefined;
  if (asked.ask) {
    return {
      kind: "ask",
      ticket: target.id,
      askHuman: asked.askHuman ?? humanAskAt("next-ticket", boundary, "escalate asked for the developer"),
      ...(escalation === undefined ? {} : { escalation }),
    };
  }

  const started = startTicket(root, { ticketId: target.id }, dependencies.context, { escalated: true });
  if (!started.ok) return { kind: "refused", reason: started.reason };
  return { kind: "started", ...started.outcome, ...(escalation === undefined ? {} : { escalation }) };
}

export type ParkResult =
  | { readonly ok: true; readonly outcome: { readonly ticket: TicketRecord; readonly partialEdits: readonly string[] } }
  | Refusal;

/**
 * Parks the ticket in progress with its blocker (D30): never done, its
 * uncommitted changes recorded as its partial edits so the next ticket
 * neither absorbs nor commits them. Under whole-plan authorization the
 * next ticket may then be chosen; under one-ticket authorization the
 * ticket stays assigned, so nothing else starts. Authorization is never
 * changed.
 */
export function parkTicket(
  root: string,
  request: { readonly ticketId: string; readonly blocker: string },
  options: { readonly now: string },
): ParkResult {
  if (!hasText(request?.blocker)) return refuse("record what blocks the ticket; a parked ticket keeps its blocker");
  const working = readWorkingTicket(root, request.ticketId);
  if (!working.ok) return working;
  const { ticket, progress, tickets } = working;

  const tree = readWorkingTree(root);
  const owned = new Set((progress.changeOwnership ?? []).map((entry) => entry.path));
  const edits = tree.kind === "present" ? tree.changedPaths.filter((path) => !owned.has(path)) : [];
  const adopted: ChangeOwnership[] = edits.map((path) => ({
    path,
    owner: "ticket",
    ticketId: ticket.id,
    note: `partial edit of ticket ${ticket.id}, parked on ${options.now}`,
  }));
  const parked: TicketRecord = { ...ticket, status: "parked", parkedReason: request.blocker.trim() };
  const nextTickets = validateRecord("tickets", {
    tickets: tickets.tickets.map((entry) => (entry.id === ticket.id ? parked : entry)),
  });
  if (!nextTickets.ok) return refuse("the ticket cannot be parked as recorded", nextTickets.issues);
  const { assignedTicketId, ...rest } = progress;
  const nextProgress = validateRecord("progress", {
    ...rest,
    // Under one-ticket authorization the ticket stays the one authorized; nothing else starts.
    ...(progress.authorizationScope === "ticket" && assignedTicketId !== undefined ? { assignedTicketId } : {}),
    ticketChangesPresent: false,
    changeOwnership: [...(progress.changeOwnership ?? []), ...adopted],
  });
  if (!nextProgress.ok) return refuse("the progress record cannot be updated", nextProgress.issues);
  writeRecord(root, "tickets", nextTickets.record);
  writeRecord(root, "progress", nextProgress.record);
  return { ok: true, outcome: { ticket: parked, partialEdits: partialEdits(nextProgress.record, [ticket.id]) } };
}

export interface IndependenceInput {
  readonly ticketId: string;
  /** Why the parked tickets are not among its dependencies, direct or indirect. */
  readonly dependencies: string;
  /** Why the decisions the parked tickets wait on do not affect it. */
  readonly decisions: string;
  /** Why the parked tickets' partial edits do not affect it. */
  readonly partialEdits: string;
}

export type IndependenceResult = { readonly ok: true; readonly outcome: { readonly check: IndependenceCheck } } | Refusal;

const CHECK_PARTS = [
  ["dependencies", "dependencies"],
  ["decisions", "unresolved decisions"],
  ["partialEdits", "partial edits"],
] as const;

/**
 * Records why a ready ticket may start beside every ticket parked now,
 * covering dependencies, unresolved decisions and partial edits. Refused
 * for a ticket that depends on a parked one, or with any part left out.
 */
export function recordIndependence(root: string, input: IndependenceInput, options: { readonly now: string }): IndependenceResult {
  const read = readRecords(root);
  if (!read.ok) return read;
  const { tickets, progress } = read.records;
  const ticket = tickets.tickets.find((entry) => entry.id === input?.ticketId);
  if (ticket === undefined) return refuse(`no ticket "${String(input?.ticketId)}" in the plan`);
  if (ticket.status !== "ready") return refuse(`ticket ${ticket.id} is ${ticket.status}; only a ready ticket is checked`);
  const parked = parkedTickets(tickets).map((entry) => entry.id);
  if (parked.length === 0) return refuse("no ticket is parked; there is nothing to check independence against");
  const blocker = parkedDependency(tickets, ticket.id);
  if (blocker !== undefined) return refuse(`ticket ${ticket.id} depends on parked ticket ${blocker}; it is not independent`);
  const missing = CHECK_PARTS.filter(([key]) => !hasText(input[key])).map(([, label]) => label);
  if (missing.length > 0) return refuse(`the independence check leaves out ${missing.join(", ")}; it covers all three`);

  const check: IndependenceCheck = {
    parked,
    dependencies: input.dependencies.trim(),
    decisions: input.decisions.trim(),
    partialEdits: input.partialEdits.trim(),
    partialEditPaths: partialEdits(progress, parked),
    checkedAt: options.now,
  };
  const next = validateRecord("progress", {
    ...progress,
    independenceChecks: { ...progress.independenceChecks, [ticket.id]: check },
  });
  if (!next.ok) return refuse("the independence check cannot be recorded", next.issues);
  writeRecord(root, "progress", next.record);
  return { ok: true, outcome: { check } };
}
