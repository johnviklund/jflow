import { existsSync } from "node:fs";
import { join } from "node:path";

import type { StageModelConfiguration } from "../config/configuration.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import { askEscalation } from "../jev/escalation.js";
import {
  admittedToReview,
  CONSEQUENTIAL_AREAS,
  FINDING_KINDS,
  readRecord,
  validateRecord,
  writeRecord,
  type ConsequentialArea,
  type DiagnosisEntry,
  type FindingDispute,
  type FindingKind,
  type ProgressRecord,
  type ReviewDisposition,
  type Reviewer,
  type ReviewFinding,
  type TicketRecord,
  type TicketReview,
  type TicketValidation,
} from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { hasText, isOneOf } from "../validation.js";
import { decideConflict, raiseConflict } from "./conflicts.js";
import type { HumanAskEvent } from "./dispatch.js";
import {
  countUnsuccessfulFix,
  EVIDENCE_DIRECTORY,
  fixLimit,
  nextFailureReachesLimit,
  readWorkingTicket,
  type FixCount,
} from "./implement.js";
import { refuse, unreadable, unreadableState, type Refusal } from "./refusal.js";
import { resolveAction, type ResolutionContext } from "./resolve.js";
import { recordTodo } from "./todo.js";
import { readTicketDiagnoses } from "./troubleshoot.js";

/**
 * The helper's part of `review` (issue #9, D31-D33, D47, D48, D51): the gate
 * into review, reviewer independence, and each finding's disposition by
 * D33's fixed rule. Jev never classifies a finding (D50). A dispute is
 * settled by evidence, by `escalate` at `review-dispute`, or, when it is
 * consequential, by the developer as a hard rule (D7).
 *
 * A blocking finding returns the ticket to fix: its validation is cleared,
 * so the fix passes `validate` again before it is re-reviewed, and the
 * failure lands on the ticket's one fix counter shared with `validate`.
 * The review itself is done by a reviewer agent the skill spawns; nothing
 * here edits code, commits, or marks a ticket done.
 */

/** The implementing agent every ticket has: the primary agent coordinates its work. */
export const PRIMARY_AGENT = "primary";

const BLOCKING_KINDS: readonly FindingKind[] = ["requirement", "correctness", "standard"];

export interface StartedReview {
  readonly ticket: TicketRecord;
  /** The all-met verdicts that admitted the ticket. */
  readonly validation: TicketValidation;
  /** Where the verification evidence is recorded, when it is. */
  readonly evidence?: string;
  /** Agents that may not review this ticket. */
  readonly implementers: readonly string[];
  /** The review stage's model, configured independently of the implementer's. */
  readonly stageModel?: StageModelConfiguration;
  /** The previous review, whose blocking findings a re-review checks again. */
  readonly previousReview?: TicketReview;
  /** Diagnoses of the ticket's failed checks, as evidence (issue #11). */
  readonly diagnoses: readonly DiagnosisEntry[];
  readonly fix: { readonly attempts: number; readonly limit: number };
}

export type StartReviewResult = { readonly ok: true; readonly outcome: StartedReview } | Refusal;

export interface DisputeInput {
  readonly reason: string;
  readonly evidence?: readonly string[];
  /** What the dispute would change that only the developer may decide (D7). */
  readonly touches?: readonly ConsequentialArea[];
  /** The evidence settles the dispute against the finding. */
  readonly conclusive?: boolean;
}

export interface FindingInput {
  readonly kind: FindingKind;
  readonly summary: string;
  readonly evidence?: readonly string[];
  /** The implementer's dispute of a blocking finding. */
  readonly dispute?: DisputeInput;
}

export interface ReviewInput {
  readonly ticketId: string;
  readonly reviewer: Reviewer;
  readonly findings: readonly FindingInput[];
  /** The next step for the developer, should a blocking finding reach the fix limit. */
  readonly recommendation?: string;
}

export interface FindingDecision {
  readonly ticketId: string;
  readonly finding: string;
  readonly outcome: "upheld" | "withdrawn";
  /** The developer's words. */
  readonly note: string;
  readonly recommendation?: string;
}

export type ReviewResult =
  | {
      readonly ok: true;
      readonly review: TicketReview;
      /** Present when the review returned the ticket to fix. */
      readonly fix?: FixCount;
      /** Present when the developer must decide; the skill asks and waits. */
      readonly askHuman?: HumanAskEvent;
    }
  | Refusal;

function implementersOf(progress: ProgressRecord, ticketId: string): readonly string[] {
  return [PRIMARY_AGENT, ...(progress.implementers?.[ticketId] ?? [])];
}

/** Why a ticket may not be reviewed now. */
function notAdmitted(progress: ProgressRecord, ticketId: string): string {
  switch (progress.reviews?.[ticketId]?.disposition) {
    case "awaiting-developer":
      return `ticket ${ticketId}'s review has disputed findings waiting for the developer; record their decision with review decide first`;
    case "passed":
      return `ticket ${ticketId} has passed review`;
    default:
      return `ticket ${ticketId} has not passed validate with every criterion met; validation is the gate into review, so run implement check first`;
  }
}

/**
 * Opens review of the assigned ticket: refused unless the `review` action is
 * eligible, which includes the ticket's latest `validate` finding every
 * criterion met. Returns what the reviewer's fresh context is built from.
 */
export function startReview(root: string, context: ResolutionContext): StartReviewResult {
  const state = readProjectState(root);
  if (state.kind === "malformed") return unreadableState(state);
  const resolution = resolveAction({ action: "review" }, state.state, context);
  if (resolution.status === "unknown-action") return refuse(resolution.message);
  if (resolution.status === "blocked") return refuse(resolution.unmet.map((entry) => entry.reason).join("; "));

  const working = readWorkingTicket(root, state.state.assignedTicketId);
  if (!working.ok) return working;
  const { ticket, progress } = working;
  const validation = progress.validations?.[ticket.id];
  if (validation === undefined || !admittedToReview(progress, ticket.id)) return refuse(notAdmitted(progress, ticket.id));
  const diagnosed = readTicketDiagnoses(root, ticket.id);
  if (!diagnosed.ok) return diagnosed;
  const evidence = `${EVIDENCE_DIRECTORY}/${encodeURIComponent(ticket.id)}.json`;
  const previousReview = progress.reviews?.[ticket.id];
  return {
    ok: true,
    outcome: {
      ticket,
      validation,
      ...(existsSync(join(root, evidence)) ? { evidence } : {}),
      implementers: implementersOf(progress, ticket.id),
      ...(resolution.stageModel === undefined ? {} : { stageModel: resolution.stageModel }),
      ...(previousReview === undefined ? {} : { previousReview }),
      diagnoses: diagnosed.diagnoses,
      fix: { attempts: progress.fixAttempts?.[ticket.id] ?? 0, limit: fixLimit(context) },
    },
  };
}

/** Checks one finding as drafted; returns why it cannot be recorded, if it cannot. */
function findingProblem(finding: FindingInput, index: number): string | undefined {
  const at = `finding ${index + 1}`;
  if (!isOneOf(FINDING_KINDS, finding?.kind)) {
    return `${at} has kind "${String(finding?.kind)}"; a finding is one of ${FINDING_KINDS.join(", ")}`;
  }
  if (!hasText(finding.summary)) return `${at} needs a summary`;
  const { dispute } = finding;
  if (dispute === undefined) return undefined;
  if (!BLOCKING_KINDS.includes(finding.kind)) return `${at} is an improvement, filed as a todo; there is nothing to dispute`;
  if (!hasText(dispute.reason)) return `${at}'s dispute needs a reason`;
  const touches = dispute.touches ?? [];
  const unknown = touches.find((area) => !isOneOf(CONSEQUENTIAL_AREAS, area));
  if (unknown !== undefined) return `${at}'s dispute touches "${unknown}"; it can touch ${CONSEQUENTIAL_AREAS.join(", ")}`;
  if (dispute.conclusive === true && touches.length > 0) {
    return `${at}'s dispute touches ${touches.join(", ")}; that is the developer's to decide, not settled by evidence`;
  }
  if (dispute.conclusive === true && !(dispute.evidence ?? []).some(hasText)) {
    return `${at}'s dispute is settled only by recorded evidence; add what it rests on`;
  }
  return undefined;
}

/** Whether a finding as drafted may end up blocking the ticket. */
const mayBlock = (finding: FindingInput) => BLOCKING_KINDS.includes(finding.kind) && finding.dispute?.conclusive !== true;

/** The ticket's next state: any blocking finding returns it to fix, else any open dispute waits, else it passed. */
function reviewDisposition(findings: readonly ReviewFinding[]): ReviewDisposition {
  if (findings.some((finding) => finding.disposition === "blocking")) return "returned-to-fix";
  if (findings.some((finding) => finding.disposition === "awaiting-developer")) return "awaiting-developer";
  return "passed";
}

const describeFinding = (ticketId: string, finding: { readonly id: string; readonly kind: string; readonly summary: string }) =>
  `Review finding ${finding.id} (${finding.kind}) on ticket ${ticketId}: ${finding.summary}`;

interface DisposedFinding {
  readonly finding: ReviewFinding;
  readonly asks: readonly string[];
}

/** Disposes of one finding by D33's rule; only a dispute can reach the developer, and only a non-consequential one reaches Jev. */
async function disposeFinding(
  root: string,
  ticketId: string,
  input: FindingInput,
  id: string,
  dependencies: DecisionDependencies,
): Promise<{ readonly ok: true; readonly disposed: DisposedFinding } | Refusal> {
  const now = dependencies.now();
  const evidence = (input.evidence ?? []).filter(hasText);
  const base = { id, kind: input.kind, summary: input.summary.trim(), evidence };
  if (input.kind === "improvement") {
    const filed = recordTodo(
      root,
      { summary: base.summary, detail: [`review of ticket ${ticketId}`, ...evidence].join("; ") },
      { now },
    );
    if (!filed.ok) return filed;
    return { ok: true, disposed: { finding: { ...base, disposition: "todo", todo: filed.outcome.item.id }, asks: [] } };
  }
  const draft = input.dispute;
  if (draft === undefined) return { ok: true, disposed: { finding: { ...base, disposition: "blocking" }, asks: [] } };

  const dispute: FindingDispute = { reason: draft.reason.trim(), evidence: (draft.evidence ?? []).filter(hasText) };
  const described = describeFinding(ticketId, base);
  const touches = draft.touches ?? [];
  if (touches.length > 0) {
    const raised = raiseConflict(root, { summary: `${described}; disputed: ${dispute.reason}`, touches }, { now });
    if (!raised.ok) return raised;
    return {
      ok: true,
      disposed: {
        finding: { ...base, disposition: "awaiting-developer", dispute: { ...dispute, conflict: raised.outcome.conflict.id } },
        asks: raised.outcome.askHuman?.reasons ?? [],
      },
    };
  }
  if (draft.conclusive === true) {
    const resolution = { by: "agent" as const, note: dispute.reason, evidence: dispute.evidence };
    return { ok: true, disposed: { finding: { ...base, disposition: "withdrawn", dispute: { ...dispute, resolution } }, asks: [] } };
  }

  const escalation = await askEscalation(
    root,
    {
      kind: "review-dispute",
      summary: `${described}. The implementer disputes it: ${dispute.reason}`,
      excerpts: [
        ...evidence.map((text) => ({ source: "finding", text })),
        ...dispute.evidence.map((text) => ({ source: "dispute", text })),
      ],
    },
    dependencies,
  );
  if (escalation.kind === "refused") return refuse(escalation.reason);
  const envelope = escalation.kind === "answered" ? { escalation: escalation.envelope } : {};
  if (!escalation.ask) {
    // Proceeding without the developer cannot set a reviewer's finding aside: it stands.
    const resolution = { by: "workflow" as const, note: "escalate answered proceed; the finding stands as the reviewer recorded it" };
    return { ok: true, disposed: { finding: { ...base, disposition: "blocking", dispute: { ...dispute, ...envelope, resolution } }, asks: [] } };
  }
  return {
    ok: true,
    disposed: {
      finding: { ...base, disposition: "awaiting-developer", dispute: { ...dispute, ...envelope } },
      asks: escalation.askHuman?.reasons ?? [],
    },
  };
}

interface ReviewWrite {
  readonly progress: ProgressRecord;
  readonly ticketId: string;
  readonly review: TicketReview;
  /** The review returns the ticket to fix and has not counted that yet. */
  readonly returned: boolean;
  readonly recommendation?: string;
  /** Disputes waiting for the developer. */
  readonly asks: readonly string[];
}

/**
 * Writes the review and, when it newly returns the ticket to fix, clears
 * the ticket's validation and counts the failure on the shared counter.
 */
async function writeReview(
  root: string,
  { progress, ticketId, review, returned, recommendation, asks }: ReviewWrite,
  dependencies: DecisionDependencies,
): Promise<ReviewResult> {
  const { [ticketId]: _cleared, ...validations } = progress.validations ?? {};
  const next = validateRecord("progress", {
    ...progress,
    reviews: { ...progress.reviews, [ticketId]: review },
    ...(returned ? { validations } : {}),
  });
  if (!next.ok) return refuse("the review cannot be recorded", next.issues);
  writeRecord(root, "progress", next.record);

  let askHuman: HumanAskEvent | undefined =
    asks.length === 0 ? undefined : { kind: "human-ask", reasons: [...asks] };
  let fix: FixCount | undefined;
  if (returned) {
    const blocking = review.findings.filter((finding) => finding.disposition === "blocking");
    const counted = await countUnsuccessfulFix(
      root,
      {
        ticketId,
        summary: `Review found ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}: ${blocking.map((finding) => finding.summary).join("; ")}.`,
        excerpts: blocking.map((finding) => ({
          source: `finding ${finding.id}`,
          text: [finding.summary, ...finding.evidence].join("; "),
        })),
        ...(recommendation === undefined ? {} : { recommendation: recommendation }),
      },
      dependencies,
    );
    if (!counted.ok) return counted;
    fix = counted.fix;
    // The fix-failed ask keeps its boundary; any dispute waiting for the developer is asked with it.
    if (counted.askHuman !== undefined) {
      askHuman = { ...counted.askHuman, reasons: [...asks, ...counted.askHuman.reasons] };
    }
  }
  return {
    ok: true,
    review,
    ...(fix === undefined ? {} : { fix }),
    ...(askHuman === undefined ? {} : { askHuman }),
  };
}

/**
 * Records a reviewer's findings on the ticket and disposes of each by D33's
 * fixed rule: a requirement, correctness or standard violation blocks; an
 * improvement is filed as a todo; a disputed finding is withdrawn only on
 * recorded evidence, put to `escalate` otherwise, and to the developer
 * without Jev when consequential. Refused before validation admits the
 * ticket, for a reviewer that implemented it, and, when a blocking finding
 * could reach the fix limit, without a recommendation.
 */
export async function recordReview(
  root: string,
  input: ReviewInput,
  dependencies: DecisionDependencies,
): Promise<ReviewResult> {
  const working = readWorkingTicket(root, input?.ticketId);
  if (!working.ok) return working;
  const { ticket, progress } = working;
  if (!admittedToReview(progress, ticket.id)) return refuse(notAdmitted(progress, ticket.id));

  const agent = typeof input.reviewer?.agent === "string" ? input.reviewer.agent.trim() : "";
  if (agent === "") return refuse("name the reviewing agent; review needs a reviewer distinct from the implementer");
  if (implementersOf(progress, ticket.id).includes(agent)) {
    return refuse(
      `${agent} implemented ticket ${ticket.id}; review by an implementing agent never satisfies the gate, even on another model, so spawn a distinct reviewer with a fresh context`,
    );
  }
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const problem = findings.map(findingProblem).find((entry) => entry !== undefined);
  if (problem !== undefined) return refuse(problem);
  if (findings.some(mayBlock) && nextFailureReachesLimit(progress, ticket.id, dependencies.context) && !hasText(input.recommendation)) {
    return refuse("a blocking finding here reaches the fix limit; record the review with a recommendation for the developer");
  }

  const disposed: DisposedFinding[] = [];
  for (const [index, finding] of findings.entries()) {
    const result = await disposeFinding(root, ticket.id, finding, `F${index + 1}`, dependencies);
    if (!result.ok) return result;
    disposed.push(result.disposed);
  }
  const reviewed = disposed.map((entry) => entry.finding);
  const model = input.reviewer.model?.trim();
  const review: TicketReview = {
    reviewer: { agent, ...(hasText(model) ? { model } : {}) },
    disposition: reviewDisposition(reviewed),
    findings: reviewed,
    reviewedAt: dependencies.now(),
  };
  // Disposing may have written todos and conflicts; the progress record is re-read before the review lands.
  const current = readRecord(root, "progress");
  if (current.kind !== "present") return current.kind === "malformed" ? unreadable("progress", current) : refuse("the progress record is gone");
  return writeReview(
    root,
    {
      progress: current.record,
      ticketId: ticket.id,
      review,
      returned: review.disposition === "returned-to-fix",
      ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
      asks: disposed.flatMap((entry) => entry.asks),
    },
    dependencies,
  );
}

/**
 * Records the developer's decision on a disputed finding that waits for
 * them: `upheld` makes it blocking, `withdrawn` sets it aside. A conflict
 * raised for the dispute is resolved with the same words. The ticket is then
 * settled again; a review that newly returns it to fix counts on the fix
 * counter.
 */
export async function decideFinding(
  root: string,
  decision: FindingDecision,
  dependencies: DecisionDependencies,
): Promise<ReviewResult> {
  if (!hasText(decision.note)) return refuse("the dispute is the developer's to decide; record it in their words");
  if (decision.outcome !== "upheld" && decision.outcome !== "withdrawn") {
    return refuse(`a disputed finding is upheld or withdrawn, not "${String(decision.outcome)}"`);
  }
  const working = readWorkingTicket(root, decision.ticketId);
  if (!working.ok) return working;
  const { ticket, progress } = working;
  const review = progress.reviews?.[ticket.id];
  if (review === undefined) return refuse(`ticket ${ticket.id} has no review`);
  const target = review.findings.find((finding) => finding.id === decision.finding);
  if (target === undefined) {
    return refuse(`no finding "${decision.finding}" on ticket ${ticket.id}; findings are ${review.findings.map((f) => f.id).join(", ") || "none"}`);
  }
  if (target.disposition !== "awaiting-developer" || target.dispute === undefined) {
    return refuse(`finding ${target.id} is ${target.disposition}, not waiting for the developer`);
  }

  const note = decision.note.trim();
  const decided: ReviewFinding = {
    ...target,
    disposition: decision.outcome === "upheld" ? "blocking" : "withdrawn",
    dispute: { ...target.dispute, resolution: { by: "developer", note } },
  };
  const findings = review.findings.map((finding) => (finding.id === target.id ? decided : finding));
  const next: TicketReview = { ...review, findings, disposition: reviewDisposition(findings) };
  const returned = next.disposition === "returned-to-fix" && review.disposition !== "returned-to-fix";
  if (returned && nextFailureReachesLimit(progress, ticket.id, dependencies.context) && !hasText(decision.recommendation)) {
    return refuse("upholding this finding reaches the fix limit; record the decision with a recommendation for the developer");
  }
  if (target.dispute.conflict !== undefined) {
    const resolved = decideConflict(root, target.dispute.conflict, { note, now: dependencies.now() });
    if (!resolved.ok) return resolved;
  }
  return writeReview(
    root,
    {
      progress,
      ticketId: ticket.id,
      review: next,
      returned,
      ...(decision.recommendation === undefined ? {} : { recommendation: decision.recommendation }),
      asks: [],
    },
    dependencies,
  );
}
