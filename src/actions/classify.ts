import { randomBytes } from "node:crypto";

import { loadDecisionQuestion, type DecisionQuestion } from "../jev/client.js";
import {
  askDecisionRejectingUnlisted,
  reportDecision,
  type DecisionDependencies,
  type DecisionEnvelope,
  type DecisionReport,
  type DecisionRoute,
} from "../jev/decisions.js";
import type { EvidenceExcerpt } from "../jev/evidence.js";
import { startTrace } from "../jev/traces.js";
import { hasText, isOneOf } from "../validation.js";
import { refuse, type Refusal } from "./refusal.js";

/**
 * Jev's advisory `classify` decision (issue #29, D49, D50): one question
 * over three content kinds, each asked at its own call site.
 *
 * - `testability`: whether a drafted acceptance criterion can be validated
 *   (`plan write`).
 * - `item-routing`: whether an item found mid-work is a todo or in scope
 *   for the current ticket (`todo route`).
 * - `lesson-scope`: which of the candidate scopes a lesson applies to
 *   (`learn propose`).
 *
 * The content kind leads the packet's task summary, as `escalate`'s
 * boundary kind does, so an envelope says what was classified and replay
 * can break results down by kind (D46). Each kind is offered only its own
 * choices. Anything else, a review finding above all (D33), is refused
 * before Jev and the attempt is kept as a local trace.
 */

export const CONTENT_KINDS = ["item-routing", "testability", "lesson-scope"] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

/** `lesson-scope`'s answer when no candidate scope fits. */
export const UNCLEAR_SCOPE = "unclear";

export const ITEM_ROUTING_CHOICES = ["todo", "in-scope"] as const;

export const TESTABILITY_CHOICES = ["testable", "untestable"] as const;

export interface ClassifyInput {
  readonly kind: string;
  /** The content itself, in a sentence or two. */
  readonly summary: string;
  readonly excerpts: readonly EvidenceExcerpt[];
  /** `lesson-scope` only: the candidate scopes, the agent's own first. */
  readonly scopes?: readonly string[];
}

export type ClassifyResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly kind: "answered";
        readonly contentKind: ContentKind;
        readonly envelope: string;
        readonly answer: string;
        readonly reasonCode: string;
        readonly confidence?: number;
        readonly route: DecisionRoute;
        readonly decision: DecisionReport;
      };
    }
  | {
      /** Jev could not be asked; `decision` says why. */
      readonly ok: true;
      readonly outcome: { readonly kind: "unavailable"; readonly contentKind: ContentKind; readonly decision: DecisionReport };
    }
  | {
      /** Jev named something outside the kind's choices; nothing relies on it. */
      readonly ok: true;
      readonly outcome: { readonly kind: "unlisted"; readonly contentKind: ContentKind; readonly answer: string; readonly traceReference: string };
    }
  | Refusal;

const SUMMARY_PREFIX = /^Content: ([a-z-]+)\./;

/** What an envelope classified, read from the envelope alone; `unknown` for one that is not classify's. */
export function contentKindOf(envelope: DecisionEnvelope): string {
  return SUMMARY_PREFIX.exec(envelope.request.packet.taskSummary)?.[1] ?? "unknown";
}

function choicesFor(kind: ContentKind, scopes: readonly string[]): readonly string[] {
  switch (kind) {
    case "item-routing":
      return ITEM_ROUTING_CHOICES;
    case "testability":
      return TESTABILITY_CHOICES;
    case "lesson-scope":
      return [...scopes, UNCLEAR_SCOPE];
  }
}

/** How a record keeps a classification: Jev's answer and its envelope, or why there was none. */
export type Classification =
  | { readonly envelope: string; readonly answer: string; readonly reasonCode: string; readonly route: DecisionRoute }
  | { readonly unavailable: string; readonly traceReference?: string };

export function classificationOf(result: ClassifyResult): Classification {
  if (!result.ok) return { unavailable: result.reason };
  const { outcome } = result;
  switch (outcome.kind) {
    case "answered":
      return { envelope: outcome.envelope, answer: outcome.answer, reasonCode: outcome.reasonCode, route: outcome.route };
    case "unlisted":
      return { unavailable: `Jev answered "${outcome.answer}", which is not a ${outcome.contentKind} choice`, traceReference: outcome.traceReference };
    case "unavailable":
      return { unavailable: `Jev was not asked: ${outcome.decision.kind}` };
  }
}

/** The task summary a classification's packet opens with; a caller can tell by it what was classified. */
export function classifiedSummary(kind: ContentKind, summary: string): string {
  return `Content: ${kind}. ${summary.trim()}`;
}

/** Keeps a refused attempt as a local trace: it never reaches Jev, and it is not lost. */
function recordRefusal(root: string, input: ClassifyInput, reason: string, now: string): string {
  const name = `${now.replace(/[:.]/g, "-")}-classify-refused-${randomBytes(3).toString("hex")}`;
  return startTrace(root, name, {
    decision: "classify",
    refusedAt: now,
    kind: String(input?.kind),
    summary: typeof input?.summary === "string" ? input.summary : "",
    refused: reason,
  });
}

export async function classifyContent(
  root: string,
  input: ClassifyInput,
  dependencies: DecisionDependencies,
): Promise<ClassifyResult> {
  // The input arrives as a JSON file at `decide ask`; read it defensively.
  const kind = input?.kind;
  if (!isOneOf(CONTENT_KINDS, kind)) {
    const reason =
      kind === "review-finding"
        ? "a review finding is never classified: the fixed rule decides its disposition (D33)"
        : `"${String(kind)}" is not a content kind; classify takes ${CONTENT_KINDS.join(", ")}`;
    const trace = recordRefusal(root, input, reason, dependencies.now());
    return refuse(`${reason}; the attempt is recorded at ${trace}`);
  }
  if (!hasText(input.summary)) return refuse("say what is being classified (summary)");
  const scopes = [...new Set((input.scopes ?? []).filter(hasText).map((scope) => scope.trim()))];
  if (kind === "lesson-scope" && scopes.length === 0) return refuse("lesson-scope needs at least one candidate scope");

  // The kind's own choices; the envelope keeps the question as asked.
  const base = loadDecisionQuestion(dependencies.context.workflowPackage, "classify");
  const question: DecisionQuestion = { ...base, answers: choicesFor(kind, scopes) };
  const result = await askDecisionRejectingUnlisted(
    root,
    "classify",
    {
      taskSummary: classifiedSummary(kind, input.summary),
      candidates: question.answers,
      excerpts: Array.isArray(input.excerpts) ? input.excerpts : [],
    },
    { ...dependencies, readQuestion: () => question },
  );
  if (result.kind === "unlisted") {
    return { ok: true, outcome: { kind: "unlisted", contentKind: kind, answer: result.answer, traceReference: result.traceReference } };
  }
  if (result.kind === "refused") return refuse(result.reason);
  const decision = reportDecision(result);
  if (result.kind !== "answered") return { ok: true, outcome: { kind: "unavailable", contentKind: kind, decision } };
  const { envelope } = result;
  return {
    ok: true,
    outcome: {
      kind: "answered",
      contentKind: kind,
      envelope: envelope.id,
      answer: envelope.answer.choice,
      reasonCode: envelope.answer.reasonCode,
      ...(envelope.answer.confidence === undefined ? {} : { confidence: envelope.answer.confidence }),
      route: envelope.route,
      decision,
    },
  };
}
