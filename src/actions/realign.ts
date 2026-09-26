import type { DecisionDependencies } from "../jev/decisions.js";
import type { EscalationAsk } from "../jev/escalation.js";
import { judgeTicket } from "../jev/ticket-validation.js";
import {
  EMPTY_PROGRESS,
  readRecord,
  REALIGN_SOURCES,
  validateRecord,
  writeRecord,
  type ChangeOwnership,
  type ProgressRecord,
  type RealignRecommendation,
  type RealignRecord,
  type RealignSource,
  type Realignment,
  type Revalidation,
  type SpecificationDecision,
  type SpecificationRecord,
  type TicketRealignment,
  type TicketRecord,
  type TicketValidation,
} from "../project/records.js";
import { hasText, isOneOf, isRecord } from "../validation.js";
import { readRecordedEvidence } from "./implement.js";
import { awaitsRealignAcceptance, classifyTestability, findDependencyCycle, recordSetAsides, type ClassifiedTickets, type PlanDraft } from "./plan.js";
import { readWorkingTree } from "../project/worktree.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";
import type { SpecificationDraft } from "./specification.js";

/**
 * The helper's part of `realign` (issue #31, D42): the developer changes
 * their mind about an accepted plan while implementation is in flight, and
 * the specification, the ticket breakdown and the progress records are
 * reconciled with their new direction.
 *
 * - The affected tickets are re-scoped, added, parked or withdrawn; every
 *   other ticket, and its records, is left exactly as it was. Progress is
 *   kept, not rebuilt: fix counters, reviews and commits stay.
 * - A completed ticket whose acceptance criteria changed is re-validated
 *   against them through `validate`, over the evidence recorded for it,
 *   and reopened with its review cleared: validation never replaces
 *   review (D47), and that review covered the old criteria. An all-met
 *   one goes straight to review. If it cannot be re-validated, nothing is
 *   written.
 * - New and changed criteria are classified for testability as `plan
 *   write` classifies them (D41, D50).
 * - The specification and the breakdown both re-enter acceptance (D27,
 *   D28), and the execution authorization ends: accepting the realigned
 *   plan authorizes nothing, so `implement` waits for the developer twice.
 *
 * Realign runs only on the developer's instruction, recorded in their
 * words. The agent, resume or a review may only recommend it, and
 * `recommendRealign` writes the recommendation and starts nothing. Neither
 * edits code or records a ticket done.
 */

export type TicketChange =
  | {
      readonly action: "rescope";
      readonly ticketId: string;
      readonly title?: string;
      readonly acceptanceCriteria?: readonly string[];
      readonly dependsOn?: readonly string[];
    }
  | {
      readonly action: "add";
      readonly ticketId: string;
      readonly title: string;
      readonly acceptanceCriteria: readonly string[];
      readonly dependsOn?: readonly string[];
    }
  | { readonly action: "park" | "withdraw"; readonly ticketId: string; readonly reason: string };

export interface RealignDraft {
  /** The developer's new direction, as the agent summarized it for them. */
  readonly direction: string;
  /** The revised specification, when the direction changes it; otherwise it re-enters acceptance as it is. */
  readonly specification?: SpecificationDraft;
  readonly plan?: { readonly title?: string; readonly summary?: string };
  readonly changes: readonly TicketChange[];
  /** Open recommendations this realign addresses, by id. */
  readonly recommendations?: readonly string[];
  /** Untestable answers set aside, as for `plan write`: each with a reason and its evidence. */
  readonly testabilityOverrides?: PlanDraft["testabilityOverrides"];
}

export type RealignResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly realignment: Realignment;
        readonly revalidated: readonly Revalidation[];
        /** A re-validation that waits on the developer (`escalate` at `missing-check`). */
        readonly askHuman?: EscalationAsk;
        readonly next: string;
      };
    }
  | { readonly ok: false; readonly reason: string; readonly askHuman: EscalationAsk }
  | Exclude<ClassifiedTickets, { ok: true }>;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const sameList = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

function nextId(prefix: string, ids: readonly string[]): string {
  const numbers = ids.map((id) => Number(new RegExp(`^${prefix}-(\\d+)$`).exec(id)?.[1] ?? 0));
  return `${prefix}-${Math.max(0, ...numbers) + 1}`;
}

function readRealign(root: string): { readonly ok: true; readonly record: RealignRecord } | Refusal {
  const read = readRecord(root, "realign");
  if (read.kind === "malformed") return unreadable("realign", read);
  return { ok: true, record: read.kind === "present" ? read.record : { recommendations: [], realignments: [] } };
}

/** A drafted list of strings, or undefined when it is not one. */
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value.map((entry: string) => entry.trim()) : undefined;
}

type Applied = { readonly ok: true; readonly tickets: TicketRecord[]; readonly changes: TicketRealignment[] } | Refusal;

/** Applies the drafted changes to the breakdown, refusing any that does not fit its ticket. */
function applyChanges(current: readonly TicketRecord[], drafted: unknown): Applied {
  if (!Array.isArray(drafted)) return refuse("changes must be a list of ticket changes");
  const tickets = [...current];
  const changes: TicketRealignment[] = [];
  const touched = new Set<string>();
  for (const [index, change] of (drafted as TicketChange[]).entries()) {
    const id = text(change?.ticketId);
    if (id === "") return refuse(`changes[${index}] names no ticket`);
    if (touched.has(id)) return refuse(`${id} is changed twice; give one change per ticket`);
    touched.add(id);
    const at = tickets.findIndex((ticket) => ticket.id === id);
    const existing = tickets[at];
    switch (change.action) {
      case "add": {
        if (existing !== undefined) return refuse(`${id} is already in the plan; re-scope it instead of adding it`);
        const criteria = strings(change.acceptanceCriteria);
        if (text(change.title) === "" || criteria === undefined || criteria.length === 0) {
          return refuse(`the added ticket ${id} needs a title and acceptance criteria`);
        }
        tickets.push({ id, title: text(change.title), acceptanceCriteria: criteria, dependsOn: strings(change.dependsOn) ?? [], status: "ready" });
        changes.push({ action: "add", ticketId: id });
        break;
      }
      case "rescope": {
        if (existing === undefined) return refuse(`there is no ticket ${id} to re-scope`);
        if (existing.status === "withdrawn") return refuse(`${id} is withdrawn; add a new ticket instead`);
        const criteria = change.acceptanceCriteria === undefined ? existing.acceptanceCriteria : strings(change.acceptanceCriteria);
        const dependsOn = change.dependsOn === undefined ? existing.dependsOn : strings(change.dependsOn);
        const title = change.title === undefined ? existing.title : text(change.title);
        if (criteria === undefined || criteria.length === 0) return refuse(`${id} needs acceptance criteria; a ticket without them is not valid`);
        if (dependsOn === undefined || title === "") return refuse(`${id}'s re-scope needs a title and a list of dependencies`);
        if (title === existing.title && sameList(criteria, existing.acceptanceCriteria) && sameList(dependsOn, existing.dependsOn)) {
          return refuse(`the re-scope of ${id} changes nothing`);
        }
        const criteriaChanged = !sameList(criteria, existing.acceptanceCriteria);
        // Testability was classified for the old criteria; it does not describe the new ones.
        const { testability: _stale, ...kept } = existing;
        tickets[at] = { ...(criteriaChanged ? kept : existing), title, acceptanceCriteria: criteria, dependsOn };
        changes.push({ action: "rescope", ticketId: id, criteriaChanged, statusBefore: existing.status });
        break;
      }
      case "park":
      case "withdraw": {
        if (existing === undefined) return refuse(`there is no ticket ${id} to ${change.action}`);
        const reason = text(change.reason);
        if (reason === "") return refuse(`${change.action === "park" ? "parking" : "withdrawing"} ${id} needs the reason`);
        const allowed = change.action === "park" ? ["ready", "in-progress"] : ["ready", "in-progress", "parked"];
        if (!allowed.includes(existing.status)) {
          return refuse(
            existing.status === "done"
              ? `${id} is done and its work is committed; realign edits no code, so add a ticket that undoes it instead`
              : `${id} is ${existing.status}, so it cannot be ${change.action === "park" ? "parked" : "withdrawn"}`,
          );
        }
        const { parkedReason: _previous, ...rest } = existing;
        tickets[at] = change.action === "park" ? { ...rest, status: "parked", parkedReason: reason } : { ...rest, status: "withdrawn" };
        changes.push({ action: change.action, ticketId: id, reason, statusBefore: existing.status });
        break;
      }
      default:
        return refuse(`changes[${index}] is "${String((change as { action?: unknown })?.action)}"; a change is rescope, add, park or withdraw`);
    }
  }

  const withdrawn = new Set(tickets.filter((ticket) => ticket.status === "withdrawn").map((ticket) => ticket.id));
  const known = new Set(tickets.map((ticket) => ticket.id));
  for (const ticket of tickets) {
    if (ticket.status === "withdrawn") continue;
    const missing = ticket.dependsOn.filter((dependency) => !known.has(dependency) || withdrawn.has(dependency));
    if (missing.length > 0) {
      return refuse(`${ticket.id} depends on ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in the plan or withdrawn; re-scope ${ticket.id} too`);
    }
  }
  const cyclic = findDependencyCycle(tickets);
  if (cyclic !== undefined) return refuse(`the ticket dependencies form a cycle through "${cyclic}"`);
  return { ok: true, tickets, changes };
}

/** The specification re-entering acceptance: revised, keeping what the developer already decided, or as it was. */
function reconciledSpecification(current: SpecificationRecord, draft: SpecificationDraft | undefined, now: string): SpecificationRecord {
  const { acceptedAt: _at, acceptanceNote: _note, ...open } = current;
  if (draft === undefined) return { ...open, status: "awaiting-acceptance" };
  const decisions = (Array.isArray(draft.decisions) ? draft.decisions : []).map((decision): SpecificationDecision => {
    // Validated with the whole record afterwards; here only kept from throwing on a malformed entry.
    const { id, statement, basis } = (isRecord(decision) ? decision : {}) as Partial<SpecificationDecision>;
    const settled = current.decisions.find((entry) => entry.id === id && entry.statement === statement && entry.status !== "proposed");
    if (settled !== undefined) return settled;
    return { id: id as string, statement: statement as string, status: "proposed", ...(typeof basis === "string" ? { basis: basis.trim() } : {}) };
  });
  return {
    title: draft.title,
    problem: draft.problem,
    scenarios: draft.scenarios,
    acceptanceCriteria: draft.acceptanceCriteria,
    constraints: draft.constraints,
    exclusions: draft.exclusions,
    decisions,
    status: "awaiting-acceptance",
    writtenAt: now,
  };
}

/**
 * The uncommitted edits of the in-progress ticket a realign parks or
 * withdraws, recorded as that ticket's own as `parkTicket` does (D30), so
 * the next ticket neither absorbs nor commits them. Realign leaves the
 * files themselves alone.
 */
function stoppedTicketEdits(root: string, progress: ProgressRecord, changes: readonly TicketRealignment[], now: string): ChangeOwnership[] {
  const stopped = changes.find(
    (change) => (change.action === "park" || change.action === "withdraw") && change.statusBefore === "in-progress",
  );
  if (stopped === undefined) return [];
  const tree = readWorkingTree(root);
  const owned = new Set((progress.changeOwnership ?? []).map((entry) => entry.path));
  const edits = tree.kind === "present" ? tree.changedPaths.filter((path) => !owned.has(path)) : [];
  return edits.map((path) => ({
    path,
    owner: "ticket",
    ticketId: stopped.ticketId,
    note: `partial edit of ticket ${stopped.ticketId}, ${stopped.action === "park" ? "parked" : "withdrawn"} by realign on ${now}`,
  }));
}

/**
 * The progress record after a realign: kept, not rebuilt, except that the
 * execution authorization ends; validations and reviews of criteria that
 * changed go, re-validations replace them, and the plan review, which
 * covered the old scope, goes too. A parked or withdrawn in-progress
 * ticket is no longer the assigned one.
 */
function reconciledProgress(
  progress: ProgressRecord,
  changes: readonly TicketRealignment[],
  revalidations: Readonly<Record<string, TicketValidation>>,
  options: { readonly scopeChanged: boolean; readonly partialEdits: readonly ChangeOwnership[] },
): ProgressRecord {
  const {
    executionAuthorized: _authorized,
    authorizationScope: _scope,
    authorizationNote: _note,
    assignedTicketId,
    validations,
    reviews,
    planReview,
    changeOwnership,
    ...rest
  } = progress;
  const rescoped = changes.filter((change) => change.criteriaChanged === true).map((change) => change.ticketId);
  const stopped = changes.filter((change) => change.action === "park" || change.action === "withdraw").map((change) => change.ticketId);
  const except = <T>(map: Readonly<Record<string, T>> | undefined, ids: readonly string[]): Record<string, T> =>
    Object.fromEntries(Object.entries(map ?? {}).filter(([id]) => !ids.includes(id)));
  const nextValidations = { ...except(validations, rescoped), ...revalidations };
  const nextReviews = except(reviews, rescoped);
  const unassigned = assignedTicketId !== undefined && stopped.includes(assignedTicketId);
  const ownership = [...(changeOwnership ?? []), ...options.partialEdits];
  return {
    ...rest,
    executionAuthorized: false,
    ...(assignedTicketId === undefined || unassigned ? {} : { assignedTicketId }),
    ...(unassigned ? { ticketChangesPresent: false } : {}),
    ...(Object.keys(nextValidations).length === 0 ? {} : { validations: nextValidations }),
    ...(Object.keys(nextReviews).length === 0 ? {} : { reviews: nextReviews }),
    ...(planReview === undefined || options.scopeChanged ? {} : { planReview }),
    ...(ownership.length === 0 ? {} : { changeOwnership: ownership }),
  };
}

/**
 * Reconciles the plan with the developer's new direction and puts the
 * result back behind the acceptance gates. `note` is the developer's
 * instruction to realign, in their words; without it nothing runs.
 */
export async function realignPlan(
  root: string,
  draft: RealignDraft,
  input: { readonly note: string },
  dependencies: DecisionDependencies,
): Promise<RealignResult> {
  const note = text(input.note);
  if (note === "") return refuse("realign runs only on the developer's instruction; record their words (--note)");
  // The draft arrives as a JSON file the agent wrote; read it defensively.
  const direction = text(draft?.direction);
  if (direction === "") return refuse("a realign needs the new direction");

  const specification = readRecord(root, "specification");
  if (specification.kind === "malformed") return unreadable("specification", specification);
  const plan = readRecord(root, "plan");
  if (plan.kind === "malformed") return unreadable("plan", plan);
  const ticketsRead = readRecord(root, "tickets");
  if (ticketsRead.kind === "malformed") return unreadable("tickets", ticketsRead);
  const progressRead = readRecord(root, "progress");
  if (progressRead.kind === "malformed") return unreadable("progress", progressRead);
  const realign = readRealign(root);
  if (!realign.ok) return realign;
  if (plan.kind === "absent" || ticketsRead.kind === "absent" || specification.kind === "absent") {
    return refuse("there is no accepted plan to realign; run brainstorm and plan first");
  }
  if (plan.record.status !== "accepted" && !awaitsRealignAcceptance(plan.record, realign.record)) {
    return refuse("the plan has not been accepted; before acceptance it is plan's to revise, not realign's");
  }

  const applied = applyChanges(ticketsRead.record.tickets, draft.changes);
  if (!applied.ok) return applied;
  const now = dependencies.now();

  const recommendationIds = strings(draft.recommendations) ?? [];
  for (const id of recommendationIds) {
    const recommendation = realign.record.recommendations.find((entry) => entry.id === id);
    if (recommendation === undefined || recommendation.status !== "open") return refuse(`there is no open recommendation ${id}`);
  }

  // New and changed criteria go through the same testability check as plan's (D41, D50).
  const changedCriteria = new Set(
    applied.changes.filter((change) => change.action === "add" || change.criteriaChanged === true).map((change) => change.ticketId),
  );
  const classified = await classifyTestability(
    root,
    applied.tickets.filter((ticket) => changedCriteria.has(ticket.id)),
    draft.testabilityOverrides,
    dependencies,
  );
  if (!classified.ok) return classified;
  const tickets = applied.tickets.map((ticket) => classified.tickets.find((entry) => entry.id === ticket.id) ?? ticket);

  // Completed tickets whose criteria changed are judged against the new criteria before anything is written.
  // Whatever the verdicts, each goes back through review: its review covered the old criteria (D47).
  const revalidated: Revalidation[] = [];
  const validations: Record<string, TicketValidation> = {};
  let askHuman: EscalationAsk | undefined;
  for (const change of applied.changes) {
    if (change.action !== "rescope" || !change.criteriaChanged || change.statusBefore !== "done") continue;
    const at = tickets.findIndex((ticket) => ticket.id === change.ticketId);
    const ticket = tickets[at]!;
    const evidence = readRecordedEvidence(root, ticket.id) ?? { evidence: [], checks: [] };
    const judged = await judgeTicket(root, ticket, evidence, dependencies);
    if (judged.kind === "refused") return refuse(judged.reason);
    if (judged.kind !== "validated") {
      return { ok: false, reason: `${ticket.id} cannot be re-validated against its changed criteria, so nothing was realigned`, askHuman: judged.askHuman };
    }
    tickets[at] = { ...ticket, status: "ready" };
    validations[ticket.id] = judged.validation;
    revalidated.push({ ticketId: ticket.id, disposition: judged.validation.disposition, status: "ready" });
    askHuman ??= judged.askHuman;
  }

  const progress: ProgressRecord = progressRead.kind === "present" ? progressRead.record : EMPTY_PROGRESS;
  const nextProgress = reconciledProgress(progress, applied.changes, validations, {
    scopeChanged: applied.changes.length > 0 || draft.specification !== undefined,
    partialEdits: stoppedTicketEdits(root, progress, applied.changes, now),
  });
  const { authorizationScope, authorizationNote } = progress;

  const realignment: Realignment = {
    id: nextId("RA", realign.record.realignments.map((entry) => entry.id)),
    direction,
    note,
    changes: applied.changes,
    revalidated,
    specificationRevised: draft.specification !== undefined,
    ...(authorizationScope === undefined
      ? {}
      : { priorAuthorization: { scope: authorizationScope, ...(authorizationNote === undefined ? {} : { note: authorizationNote }) } }),
    ...(recommendationIds.length === 0 ? {} : { recommendations: recommendationIds }),
    realignedAt: now,
  };
  const { acceptedAt: _acceptedAt, acceptanceNote: _acceptanceNote, ...openPlan } = plan.record;

  // Everything is validated before any record is written.
  const nextSpecification = validateRecord("specification", reconciledSpecification(specification.record, draft.specification, now));
  if (!nextSpecification.ok) return refuse("the revised specification is not complete", nextSpecification.issues);
  const nextPlan = validateRecord("plan", {
    ...openPlan,
    ...(text(draft.plan?.title) === "" ? {} : { title: text(draft.plan?.title) }),
    ...(text(draft.plan?.summary) === "" ? {} : { summary: text(draft.plan?.summary) }),
    status: "awaiting-acceptance",
    writtenAt: now,
  });
  if (!nextPlan.ok) return refuse("the realigned plan cannot be recorded", nextPlan.issues);
  const nextTickets = validateRecord("tickets", { tickets });
  if (!nextTickets.ok) return refuse("the realigned tickets cannot be recorded", nextTickets.issues);
  const nextRecordedProgress = validateRecord("progress", nextProgress);
  if (!nextRecordedProgress.ok) return refuse("the progress record cannot be updated", nextRecordedProgress.issues);
  const nextRealign = validateRecord("realign", {
    recommendations: realign.record.recommendations.map((entry) =>
      recommendationIds.includes(entry.id) ? { ...entry, status: "addressed", addressedBy: realignment.id } : entry,
    ),
    realignments: [...realign.record.realignments, realignment],
  });
  if (!nextRealign.ok) return refuse("the realignment cannot be recorded", nextRealign.issues);
  const setAside = recordSetAsides(root, classified.setAsides, now);
  if (setAside !== undefined) return setAside;
  writeRecord(root, "tickets", nextTickets.record);
  writeRecord(root, "progress", nextRecordedProgress.record);
  writeRecord(root, "specification", nextSpecification.record);
  writeRecord(root, "plan", nextPlan.record);
  writeRecord(root, "realign", nextRealign.record);

  return {
    ok: true,
    outcome: {
      realignment,
      revalidated,
      ...(askHuman === undefined ? {} : { askHuman }),
      next: "Present the reconciled specification and breakdown to the developer: they accept the specification, then the plan, and authorize execution again before implement continues.",
    },
  };
}

export interface RecommendationInput {
  readonly source: RealignSource;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export type RecommendResult = { readonly ok: true; readonly outcome: { readonly recommendation: RealignRecommendation } } | Refusal;

/** Records a recommendation to realign for the developer to see. It changes no plan, ticket or authorization. */
export function recommendRealign(root: string, input: RecommendationInput, options: { readonly now: string }): RecommendResult {
  if (!isOneOf(REALIGN_SOURCES, input?.source)) return refuse(`a recommendation comes from ${REALIGN_SOURCES.join(", ")}`);
  if (!hasText(input.summary)) return refuse("a recommendation says what the developer should consider changing, and why");
  const realign = readRealign(root);
  if (!realign.ok) return realign;
  const recommendation: RealignRecommendation = {
    id: nextId("R", realign.record.recommendations.map((entry) => entry.id)),
    source: input.source,
    summary: input.summary.trim(),
    evidence: (strings(input.evidence) ?? []).filter((entry) => entry !== ""),
    recordedAt: options.now,
    status: "open",
  };
  const checked = validateRecord("realign", { ...realign.record, recommendations: [...realign.record.recommendations, recommendation] });
  if (!checked.ok) return refuse("the recommendation cannot be recorded", checked.issues);
  writeRecord(root, "realign", checked.record);
  return { ok: true, outcome: { recommendation } };
}
