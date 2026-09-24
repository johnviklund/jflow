import type { HumanAskEvent } from "../actions/dispatch.js";
import {
  askDecision,
  recordChoice,
  reportDecision,
  type DecisionDependencies,
  type DecisionEnvelope,
  type DecisionReport,
} from "./decisions.js";
import { isOneOf } from "../validation.js";
import type { EvidenceExcerpt } from "./evidence.js";

/**
 * The binding `escalate` decision (issue #25, D40, D43, D44, D45): at every
 * human-facing boundary, Jev answers whether the developer must be asked
 * before the workflow proceeds. A confident `proceed` within existing
 * authority asks no one; `escalate`, a below-threshold answer, or any
 * answer to unaccepted wording asks the developer.
 *
 * Hard rules never reach Jev and always ask: consequential conflicts (D7),
 * continuing without Jev (D16/D17), and the specification and plan
 * acceptance gates (D27/D28). They are not escalation call sites, so they
 * write no trace and no envelope.
 *
 * `consequential-conflict` is accepted here only so a call site that meets
 * one gets the ask; the conflict itself is recorded through
 * `actions/conflicts.ts`, which stays the authoritative route (D7).
 *
 * The boundary kind leads the packet's task summary, which bounding only
 * ever cuts from the end, so the envelope alone says where it was asked and
 * whether the developer was asked (D36), and so the question can later be
 * split per boundary by proposal (D46).
 */

export const BOUNDARY_KINDS = [
  "next-ticket",
  "fix-failed",
  "review-dispute",
  "lesson-conflict",
  "resume-discrepancy",
  "missing-check",
  "other",
] as const;

export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

export const HARD_RULES = [
  "consequential-conflict",
  "continue-without-jev",
  "specification-acceptance",
  "plan-acceptance",
] as const;

export type HardRule = (typeof HARD_RULES)[number];

/** The situation at a boundary: what happened and the evidence for it. */
export interface Boundary {
  readonly kind: string;
  readonly summary: string;
  readonly excerpts: readonly EvidenceExcerpt[];
}

/** A human ask at a boundary; the skill puts it to the developer and waits. */
export interface EscalationAsk extends HumanAskEvent {
  readonly boundary: BoundaryKind | HardRule;
  readonly reasonCode?: string;
  readonly confidence?: number;
}

export type EscalationResult =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "hard-rule"; readonly ask: true; readonly askHuman: EscalationAsk }
  | {
      readonly kind: "needs-configuration" | "failed";
      readonly ask: true;
      readonly askHuman: EscalationAsk;
      readonly decision: DecisionReport;
    }
  | {
      readonly kind: "answered";
      readonly ask: boolean;
      readonly askHuman?: EscalationAsk;
      readonly envelope: string;
      readonly decision: DecisionReport;
    };

const BOUNDARY_PREFIX = /^Boundary: ([a-z-]+)\./;

/** A human ask at a boundary, with the summary first and the detail after it. */
export function humanAskAt(
  boundary: BoundaryKind | HardRule,
  summary: string,
  detail: string,
  answer: { readonly reasonCode?: string; readonly confidence?: number } = {},
): EscalationAsk {
  return {
    kind: "human-ask",
    boundary,
    ...(answer.reasonCode === undefined ? {} : { reasonCode: answer.reasonCode }),
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    reasons: [`${summary} (${detail})`],
  };
}

export async function askEscalation(
  root: string,
  boundary: Boundary,
  dependencies: DecisionDependencies,
): Promise<EscalationResult> {
  // The boundary arrives as a drafted JSON file; read it defensively.
  const summary = typeof boundary.summary === "string" ? boundary.summary.trim() : "";
  const { kind } = boundary;
  if (isOneOf(HARD_RULES, kind)) {
    return {
      kind: "hard-rule",
      ask: true,
      askHuman: humanAskAt(kind, summary, `${kind} is a hard rule: the decision is yours and Jev is not asked`),
    };
  }
  if (!isOneOf(BOUNDARY_KINDS, kind)) {
    return {
      kind: "refused",
      reason: `"${kind}" is not a boundary kind; boundary kinds are ${BOUNDARY_KINDS.join(", ")} and hard rules are ${HARD_RULES.join(", ")}`,
    };
  }
  if (summary === "") return { kind: "refused", reason: "an escalation needs a summary of the situation at the boundary" };

  const result = await askDecision(
    root,
    "escalate",
    { taskSummary: `Boundary: ${kind}. ${summary}`, candidates: [], excerpts: boundary.excerpts ?? [] },
    dependencies,
  );
  const decision = reportDecision(result);
  switch (result.kind) {
    case "refused":
      return result;
    case "needs-configuration":
      return {
        kind: result.kind,
        ask: true,
        askHuman: humanAskAt(kind, summary, `${result.askHuman} Continuing without Jev needs your approval.`),
        decision,
      };
    case "failed":
      return {
        kind: result.kind,
        ask: true,
        askHuman: humanAskAt(
          kind,
          summary,
          `Jev could not be asked: ${result.failure.error}; continuing without Jev needs your approval.`,
        ),
        decision,
      };
  }

  const { envelope } = result;
  if (envelope.route === "act" && envelope.answer.choice === "proceed") {
    // The binding no-ask, recorded as the workflow's own choice.
    const chosen = recordChoice(root, envelope.id, { action: "proceed", by: "workflow" }, ["proceed"], {
      now: dependencies.now(),
    });
    if (!chosen.ok) return { kind: "refused", reason: chosen.reason };
    return { kind: "answered", ask: false, envelope: envelope.id, decision };
  }

  const { answer } = envelope;
  const why =
    envelope.route === "act"
      ? `Jev answered escalate (${answer.reasonCode}, confidence ${answer.confidence})`
      : `Jev answered ${answer.choice} (${answer.reasonCode}), but ${envelope.routeReason}`;
  return {
    kind: "answered",
    ask: true,
    askHuman: humanAskAt(kind, summary, `at ${kind}: ${why}; envelope ${envelope.id}`, answer),
    envelope: envelope.id,
    decision,
  };
}

/**
 * Where an escalate envelope was asked and whether the developer was asked,
 * read from the envelope alone. A choice the developer recorded means they
 * were asked, whatever they chose; an agent's evidence-based override past
 * `escalate` means they were not; before any choice, the route and answer
 * decide.
 */
export function escalationOf(envelope: DecisionEnvelope): { readonly boundary: string; readonly ask: boolean } {
  const boundary = BOUNDARY_PREFIX.exec(envelope.request.packet.taskSummary)?.[1] ?? "unknown";
  const { choice } = envelope;
  const ask =
    choice === undefined
      ? envelope.route === "ask-human" || envelope.answer.choice === "escalate"
      : choice.by === "developer" || choice.action === "escalate";
  return { boundary, ask };
}
