import {
  EMPTY_PROGRESS,
  readRecord,
  validateRecord,
  writeRecord,
  type AuthorizationScope,
  type CriterionTestability,
  type PlanRecord,
  type ProgressRecord,
  type RealignRecord,
  type TicketRecord,
  type TicketsRecord,
} from "../project/records.js";
import { readEnvelope, recordChoice, type DecisionDependencies } from "../jev/decisions.js";
import { readProjectState } from "../project/state.js";
import { hasText, isRecord } from "../validation.js";
import { classificationOf, classifyContent, TESTABILITY_CHOICES, type ClassifyResult } from "./classify.js";
import type { ResolutionContext } from "./resolve.js";
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
  /**
   * Untestable answers the agent sets aside, each with a reason and the
   * evidence it rests on (D6); `criterion` counts from 0 (issue #29).
   */
  readonly testabilityOverrides?: readonly {
    readonly ticketId: string;
    readonly criterion: number;
    readonly reason: string;
    readonly evidence?: readonly string[];
  }[];
}

/** A criterion `classify` confidently classed untestable, to be rewritten before the breakdown is written. */
export interface UntestableCriterion {
  readonly ticketId: string;
  readonly criterion: number;
  readonly text: string;
  readonly envelope: string;
  readonly reasonCode: string;
}

export type ClassifiedPlanResult =
  | PlanResult
  | { readonly ok: false; readonly reason: string; readonly untestable: readonly UntestableCriterion[] };

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

/**
 * Whether the plan awaiting acceptance is a realigned one (issue #31): the
 * latest realign wrote it and it has not been accepted since. Such a
 * breakdown carries progress, so only realign revises it.
 */
export function awaitsRealignAcceptance(plan: PlanRecord, realign: RealignRecord | undefined): boolean {
  const latest = realign?.realignments[realign.realignments.length - 1];
  return plan.status === "awaiting-acceptance" && latest !== undefined && latest.realignedAt === plan.writtenAt;
}

/** Reports the first ticket on a dependency cycle, or undefined when the graph is acyclic. */
export function findDependencyCycle(tickets: readonly TicketRecord[]): string | undefined {
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
type PreparedPlan =
  | { readonly ok: true; readonly plan: PlanRecord; readonly tickets: TicketsRecord; readonly progress: ProgressRecord }
  | Refusal;

/** Everything `plan write` checks before anything is written or asked. */
function preparePlan(root: string, draft: PlanDraft, options: { readonly now: string }): PreparedPlan {
  const existing = readRecord(root, "plan");
  if (existing.kind === "malformed") return unreadable("plan", existing);
  const realign = readRecord(root, "realign");
  if (realign.kind === "malformed") return unreadable("realign", realign);
  if (existing.kind === "present" && awaitsRealignAcceptance(existing.record, realign.kind === "present" ? realign.record : undefined)) {
    return refuse("a realigned breakdown awaits acceptance and carries the tickets' progress; revise it with realign, not plan");
  }
  const state = readProjectState(root);
  if (state.kind === "malformed") return unreadableState(state);
  if (!state.state.specificationAccepted) {
    return refuse(
      "the specification has not been explicitly accepted; a plan cannot be made against an unagreed definition",
    );
  }
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
  return { ok: true, plan: plan.record, tickets: tickets.tickets, progress: progress.progress };
}

export function writePlan(
  root: string,
  draft: PlanDraft,
  options: { readonly now: string },
): PlanResult {
  const prepared = preparePlan(root, draft, options);
  if (!prepared.ok) return prepared;
  writeRecord(root, "tickets", prepared.tickets);
  writeRecord(root, "plan", prepared.plan);
  return { ok: true, outcome: { plan: prepared.plan, tickets: prepared.tickets, progress: prepared.progress } };
}

/** How one criterion was classed, as the ticket records it. */
function testabilityOf(criterion: string, result: ClassifyResult): CriterionTestability {
  const classified = classificationOf(result);
  return "envelope" in classified
    ? { criterion, answer: classified.answer, envelope: classified.envelope, route: classified.route }
    : { criterion, unavailable: classified.unavailable };
}

/** A criterion `classify` confidently classed untestable: it blocks the breakdown (D50, the developer's choice). */
const blocks = (entry: CriterionTestability): entry is CriterionTestability & { envelope: string } =>
  entry.answer === "untestable" && entry.route !== "ask-human" && entry.envelope !== undefined;

/**
 * `plan write` with each drafted criterion's testability classified first
 * (issue #29, D50). A criterion `classify` confidently classes untestable
 * stops the breakdown from being written until it is rewritten, or set
 * aside with a reason and evidence recorded on its envelope. An answer not
 * relied on, or none, is recorded and blocks nothing: the developer sees
 * it when the breakdown is presented for acceptance.
 */
export async function writeClassifiedPlan(
  root: string,
  draft: PlanDraft,
  dependencies: DecisionDependencies,
): Promise<ClassifiedPlanResult> {
  const now = dependencies.now();
  const prepared = preparePlan(root, draft, { now });
  if (!prepared.ok) return prepared;
  const classified = await classifyTestability(root, prepared.tickets.tickets, draft.testabilityOverrides, dependencies);
  if (!classified.ok) return classified;
  const record = validateRecord("tickets", { tickets: classified.tickets });
  if (!record.ok) return refuse("the ticket breakdown cannot be recorded", record.issues);
  const recorded = recordSetAsides(root, classified.setAsides, now);
  if (recorded !== undefined) return recorded;
  writeRecord(root, "tickets", record.record);
  writeRecord(root, "plan", prepared.plan);
  return { ok: true, outcome: { plan: prepared.plan, tickets: record.record, progress: prepared.progress } };
}

/** An untestable answer the agent set aside, to be recorded on its envelope once the breakdown is written. */
export interface TestabilitySetAside {
  readonly ticketId: string;
  readonly index: number;
  readonly envelope: string;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export type ClassifiedTickets =
  | { readonly ok: true; readonly tickets: TicketRecord[]; readonly setAsides: readonly TestabilitySetAside[] }
  | Exclude<ClassifiedPlanResult, { ok: true }>;

/**
 * Classifies every criterion of `tickets` for testability (issue #29,
 * D50) and returns them with their answers, or the criteria `classify`
 * confidently classed untestable that no override sets aside. Records
 * nothing; `realign` classifies the tickets it adds or re-scopes through
 * this too (issue #31).
 */
export async function classifyTestability(
  root: string,
  tickets: readonly TicketRecord[],
  drafted: PlanDraft["testabilityOverrides"],
  dependencies: DecisionDependencies,
): Promise<ClassifiedTickets> {
  const classified: { ticket: TicketRecord; testability: CriterionTestability[] }[] = [];
  for (const ticket of tickets) {
    const testability: CriterionTestability[] = [];
    for (const criterion of ticket.acceptanceCriteria) {
      const result = await classifyContent(
        root,
        {
          kind: "testability",
          summary: criterion,
          excerpts: [{ source: `tickets/${ticket.id}`, text: ticket.title }],
        },
        { ...dependencies, stage: "plan" },
      );
      testability.push(testabilityOf(criterion, result));
    }
    classified.push({ ticket, testability });
  }

  const overrides = Array.isArray(drafted) ? drafted : [];
  const overrideFor = (ticketId: string, index: number) =>
    overrides.find((entry) => entry?.ticketId === ticketId && Number(entry.criterion) === index);
  const untestable: UntestableCriterion[] = [];
  for (const { ticket, testability } of classified) {
    testability.forEach((entry, index) => {
      if (!blocks(entry) || overrideFor(ticket.id, index) !== undefined) return;
      const read = readEnvelope(root, entry.envelope);
      untestable.push({
        ticketId: ticket.id,
        criterion: index,
        text: entry.criterion,
        envelope: entry.envelope,
        reasonCode: read.ok ? read.envelope.answer.reasonCode : "unknown",
      });
    });
  }
  if (untestable.length > 0) {
    return {
      ok: false,
      reason: `rewrite ${untestable.length === 1 ? "this criterion" : "these criteria"} so a check's output can show ${untestable.length === 1 ? "it" : "them"} met or not met, or set the answer aside with a reason and evidence (testabilityOverrides); nothing was written`,
      untestable,
    };
  }

  // Every set-aside is checked before anything is recorded: it must answer a blocking criterion, with a reason and evidence (D6).
  const setAsides: TestabilitySetAside[] = [];
  for (const override of overrides) {
    const target = classified.find(({ ticket }) => ticket.id === override?.ticketId);
    const index = Number(override?.criterion);
    const entry = target?.testability[index];
    if (target === undefined || entry === undefined || !blocks(entry)) {
      return refuse(
        `testabilityOverrides names ${String(override?.ticketId)} criterion ${String(override?.criterion)}, which classify did not class untestable; remove it`,
      );
    }
    const reason = typeof override.reason === "string" ? override.reason.trim() : "";
    const evidence = (Array.isArray(override.evidence) ? override.evidence : []).filter(hasText);
    if (reason === "" || evidence.length === 0) {
      return refuse(`setting aside ${target.ticket.id} criterion ${index}'s untestable answer needs a reason and the evidence it rests on`);
    }
    setAsides.push({ ticketId: target.ticket.id, index, envelope: entry.envelope, reason, evidence });
  }
  return {
    ok: true,
    tickets: classified.map(({ ticket, testability }) => ({
      ...ticket,
      testability: testability.map((entry, index) => {
        const aside = setAsides.find((item) => item.ticketId === ticket.id && item.index === index);
        return aside === undefined ? entry : { ...entry, setAside: { reason: aside.reason, evidence: aside.evidence } };
      }),
    })),
    setAsides,
  };
}

/** Records each set-aside as the agent's choice on its classify envelope (D6). */
export function recordSetAsides(root: string, setAsides: readonly TestabilitySetAside[], now: string): Refusal | undefined {
  for (const aside of setAsides) {
    const chose = recordChoice(
      root,
      aside.envelope,
      { action: "testable", by: "agent", reason: aside.reason, evidence: aside.evidence },
      TESTABILITY_CHOICES,
      { now },
    );
    if (!chose.ok) return chose;
  }
  return undefined;
}

/** Applies an authorization to the progress record, checking a named ticket exists. */
function authorize(root: string, progress: ProgressRecord, authorization: Authorization): Progressed {
  const { assignedTicketId: _previous, firstStartAuthorized: _unused, ...rest } = progress;
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
        // The developer's authorization is the decision at the first start (D44).
        firstStartAuthorized: true,
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
  // A plan rests on its specification; after a realign both await acceptance, the specification first (D27, D28).
  const state = readProjectState(root);
  if (state.kind === "malformed") return unreadableState(state);
  if (!state.state.specificationAccepted) {
    return refuse("the specification is not accepted; the developer accepts it before the plan that rests on it");
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

/**
 * The stages an authorization will run sub-agents in that have no model
 * configured: review always (its reviewer is a sub-agent), and implement
 * under whole-plan authorization while each ticket goes to its own
 * implementer (`implement.ticketWorker`). The developer is asked for them
 * when they authorize, not at the first sub-agent.
 */
export function stagesWithoutModel(context: ResolutionContext, scope: Authorization["scope"]): string[] {
  return stagesRun(context, scope).filter((stage) => context.configuration.stageModels[stage] === undefined);
}

/** The stages an authorization will run sub-agents in. */
export function stagesRun(context: ResolutionContext, scope: Authorization["scope"]): string[] {
  return [...(scope === "plan" && context.configuration.settings["implement.ticketWorker"] !== false ? ["implement"] : []), "review"];
}
