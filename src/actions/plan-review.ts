import { existsSync } from "node:fs";
import { join } from "node:path";

import type { StageModelConfiguration } from "../config/configuration.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import {
  EMPTY_PROGRESS,
  readRecord,
  validateRecord,
  writeRecord,
  type PlanReview,
  type ProgressRecord,
  type ReviewFinding,
  type TicketRecord,
  type TicketsRecord,
} from "../project/records.js";
import { hasText } from "../validation.js";
import { decideConflict } from "./conflicts.js";
import type { HumanAskEvent } from "./dispatch.js";
import { EVIDENCE_DIRECTORY } from "./implement.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";
import { recordedImplementers } from "./workers.js";
import type { ResolutionContext } from "./resolve.js";
import {
  decideDispute,
  disposeFindings,
  findingsProblem,
  PRIMARY_AGENT,
  reviewDisposition,
  reviewerOf,
  type FindingInput,
} from "./review.js";

/**
 * The integrated review of a plan (issue #13, D9). A plan with more than
 * one ticket is complete only once every ticket is done or withdrawn and a
 * review across them, of their interactions and the plan's acceptance
 * criteria, has passed. Its reviewer implemented none of the tickets, and
 * its findings follow ticket review's fixed rule (D33). A blocking finding
 * holds the plan: fixing it is new work, which `realign` adds and the
 * developer decides, or the developer withdraws it in their words. A
 * one-ticket plan's ticket review covers both scopes, so it needs no second
 * review. A plan review counts only while the tickets it covered are the
 * plan's tickets, so new work reopens it.
 */

const SUBJECT = "the integrated plan";

export type PlanCompletion = { readonly complete: true } | { readonly complete: false; readonly reason: string };

/** A ticket still to be done: neither done nor withdrawn. */
export const isOpen = (ticket: TicketRecord) => ticket.status !== "done" && ticket.status !== "withdrawn";
const live = (tickets: TicketsRecord) => tickets.tickets.filter((ticket) => ticket.status !== "withdrawn");

/** The plan review, when it covered exactly the plan's tickets as they are now. */
function currentReview(tickets: TicketsRecord, progress: ProgressRecord): PlanReview | undefined {
  const review = progress.planReview;
  const ids = live(tickets).map((ticket) => ticket.id);
  if (review === undefined || review.tickets.length !== ids.length) return undefined;
  return ids.every((id) => review.tickets.includes(id)) ? review : undefined;
}

const openTickets = (tickets: TicketsRecord) => {
  const open = tickets.tickets.filter(isOpen);
  return open.length === 0 ? undefined : `tickets ${open.map((ticket) => ticket.id).join(", ")} are not done`;
};

/** Whether the plan is complete, and if not, what it waits for. */
export function planCompletion(tickets: TicketsRecord, progress: ProgressRecord): PlanCompletion {
  const open = openTickets(tickets);
  if (open !== undefined) return { complete: false, reason: open };
  const ids = live(tickets).map((ticket) => ticket.id);
  if (ids.length === 0) return { complete: true };
  const review = currentReview(tickets, progress);
  if (review === undefined) {
    return {
      complete: false,
      reason: `every ticket is done; no integrated review of the plan covers ${ids.join(", ")}`,
    };
  }
  switch (review.disposition) {
    case "passed":
      return { complete: true };
    case "returned-to-fix":
      return { complete: false, reason: "the integrated review has blocking findings; fixing them needs new work in the plan" };
    case "awaiting-developer":
      return { complete: false, reason: "the integrated review has disputed findings waiting for the developer" };
  }
}

interface Records {
  readonly tickets: TicketsRecord;
  readonly progress: ProgressRecord;
}

function readRecords(root: string): { readonly ok: true; readonly records: Records } | Refusal {
  const tickets = readRecord(root, "tickets");
  if (tickets.kind === "malformed") return unreadable("tickets", tickets);
  if (tickets.kind === "absent") return refuse("there is no ticket breakdown to review");
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return unreadable("progress", progress);
  return { ok: true, records: { tickets: tickets.record, progress: progress.kind === "present" ? progress.record : EMPTY_PROGRESS } };
}

/** Every agent that implemented any of the plan's tickets. */
function planImplementers(root: string, progress: ProgressRecord): { readonly ok: true; readonly agents: readonly string[] } | Refusal {
  const recorded = recordedImplementers(root);
  if (!recorded.ok) return recorded;
  return {
    ok: true,
    agents: [...new Set([PRIMARY_AGENT, ...Object.values(progress.implementers ?? {}).flat(), ...recorded.agents])],
  };
}

/** Why the integrated review cannot be taken now, if it cannot. */
function notReviewable({ tickets, progress }: Records): string | undefined {
  const open = openTickets(tickets);
  if (open !== undefined) return `${open}; the integrated review comes once every ticket is`;
  if (live(tickets).length === 0) return "the plan has no tickets to review";
  const review = currentReview(tickets, progress);
  switch (review?.disposition) {
    case undefined:
      return undefined;
    case "passed":
      return review.scope === "single-ticket"
        ? "a single-ticket plan's ticket review already covered the plan; no integrated review is needed"
        : "the integrated review has passed; the plan is complete";
    case "awaiting-developer":
      return "the integrated review has disputed findings waiting for the developer; record their decision with review plan decide first";
    case "returned-to-fix":
      return "the integrated review's blocking findings stand on these same tickets; a new review follows new work in the plan (realign) or the developer withdrawing them";
  }
}

export interface StartedPlanReview {
  readonly tickets: readonly (Pick<TicketRecord, "id" | "title" | "acceptanceCriteria" | "commit"> & {
    /** The ticket's recorded verification evidence, when it is kept. */
    readonly evidence?: string;
  })[];
  /** The accepted specification's acceptance criteria: the plan's overall criteria. */
  readonly planCriteria: readonly string[];
  /** Agents that may not review the plan. */
  readonly implementers: readonly string[];
  readonly stageModel?: StageModelConfiguration;
  readonly previousReview?: PlanReview;
}

export type StartPlanReviewResult = { readonly ok: true; readonly outcome: StartedPlanReview } | Refusal;

/** Opens the integrated review once every ticket of a multi-ticket plan is done or withdrawn. */
export function startPlanReview(root: string, context: ResolutionContext): StartPlanReviewResult {
  const read = readRecords(root);
  if (!read.ok) return read;
  const problem = notReviewable(read.records);
  if (problem !== undefined) return refuse(problem);
  const specification = readRecord(root, "specification");
  if (specification.kind === "malformed") return unreadable("specification", specification);
  if (specification.kind === "absent" || specification.record.acceptanceCriteria.length === 0) {
    return refuse("there are no specification acceptance criteria to review the plan against");
  }
  const implementers = planImplementers(root, read.records.progress);
  if (!implementers.ok) return implementers;
  const stageModel = context.configuration.stageModels["review"];
  const previousReview = read.records.progress.planReview;
  return {
    ok: true,
    outcome: {
      tickets: live(read.records.tickets).map(({ id, title, acceptanceCriteria, commit }) => {
        const evidence = `${EVIDENCE_DIRECTORY}/${encodeURIComponent(id)}.json`;
        return {
          id,
          title,
          acceptanceCriteria,
          ...(commit === undefined ? {} : { commit }),
          ...(existsSync(join(root, evidence)) ? { evidence } : {}),
        };
      }),
      planCriteria: specification.record.acceptanceCriteria,
      implementers: implementers.agents,
      ...(stageModel === undefined ? {} : { stageModel }),
      ...(previousReview === undefined ? {} : { previousReview }),
    },
  };
}

export type PlanReviewResult =
  | { readonly ok: true; readonly review: PlanReview; readonly askHuman?: HumanAskEvent }
  | Refusal;

function writePlanReview(root: string, review: PlanReview, asks: readonly string[]): PlanReviewResult {
  // Disposing may have written todos and conflicts; progress is read afresh.
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return unreadable("progress", progress);
  const next = validateRecord("progress", {
    ...(progress.kind === "present" ? progress.record : EMPTY_PROGRESS),
    planReview: review,
  });
  if (!next.ok) return refuse("the integrated review cannot be recorded", next.issues);
  writeRecord(root, "progress", next.record);

  const reasons = [...asks];
  if (review.disposition === "returned-to-fix") {
    const blocking = review.findings.filter((finding) => finding.disposition === "blocking");
    reasons.push(
      `The integrated review found ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}: ${blocking
        .map((finding) => finding.summary)
        .join("; ")}. The plan is not complete. Fixing this is new work in the plan, which realign adds; the decision is yours.`,
    );
  }
  return { ok: true, review, ...(reasons.length === 0 ? {} : { askHuman: { kind: "human-ask", reasons } }) };
}

/**
 * Records the integrated review's findings under ticket review's rule:
 * requirement, correctness and standard findings block the plan, an
 * improvement becomes a todo, and a dispute is withdrawn on evidence, put
 * to `escalate`, or, when consequential, to the developer without Jev.
 */
export async function recordPlanReview(
  root: string,
  input: { readonly reviewer: { readonly agent: string; readonly model?: string }; readonly findings: readonly FindingInput[] },
  dependencies: DecisionDependencies,
): Promise<PlanReviewResult> {
  const read = readRecords(root);
  if (!read.ok) return read;
  const problem = notReviewable(read.records);
  if (problem !== undefined) return refuse(problem);
  const implementers = planImplementers(root, read.records.progress);
  if (!implementers.ok) return implementers;
  const reviewer = reviewerOf(input?.reviewer, implementers.agents, "a ticket of this plan");
  if (!reviewer.ok) return reviewer;
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const invalid = findingsProblem(findings);
  if (invalid !== undefined) return refuse(invalid);

  const disposed = await disposeFindings(root, SUBJECT, findings, dependencies);
  if (!disposed.ok) return disposed;
  return writePlanReview(
    root,
    {
      scope: "integrated",
      tickets: live(read.records.tickets).map((ticket) => ticket.id),
      reviewer: reviewer.reviewer,
      disposition: reviewDisposition(disposed.findings),
      findings: disposed.findings,
      reviewedAt: dependencies.now(),
    },
    disposed.asks,
  );
}

/**
 * The developer withdrawing a blocking integrated finding: theirs to
 * decide, as the plan's scope is (D7), and recorded in their words.
 */
function withdrawBlocking(review: PlanReview, findingId: string, note: string): PlanReview | undefined {
  const target = review.findings.find((finding) => finding.id === findingId);
  if (target?.disposition !== "blocking") return undefined;
  const withdrawn: ReviewFinding = {
    ...target,
    disposition: "withdrawn",
    dispute: { reason: note, evidence: [], resolution: { by: "developer", note } },
  };
  const findings = review.findings.map((finding) => (finding.id === findingId ? withdrawn : finding));
  return { ...review, findings, disposition: reviewDisposition(findings) };
}

/**
 * Records the developer's decision on an integrated finding, and settles
 * the plan again: a disputed one upheld or withdrawn, or a blocking one
 * withdrawn.
 */
export async function decidePlanFinding(
  root: string,
  decision: { readonly finding: string; readonly outcome: "upheld" | "withdrawn"; readonly note: string },
  dependencies: DecisionDependencies,
): Promise<PlanReviewResult> {
  const read = readRecords(root);
  if (!read.ok) return read;
  const review = read.records.progress.planReview;
  if (review?.scope !== "integrated") return refuse("there is no integrated review to decide on");
  if (decision.outcome === "withdrawn" && hasText(decision.note)) {
    const withdrawn = withdrawBlocking(review, decision.finding, decision.note.trim());
    if (withdrawn !== undefined) return writePlanReview(root, withdrawn, []);
  }
  const decided = decideDispute(review, decision, SUBJECT);
  if (!decided.ok) return decided;
  if (decided.conflict !== undefined) {
    const resolved = decideConflict(root, decided.conflict, { note: decision.note.trim(), now: dependencies.now() });
    if (!resolved.ok) return resolved;
  }
  return writePlanReview(root, decided.review, []);
}
