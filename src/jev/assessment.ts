import type { HumanAskEvent } from "../actions/dispatch.js";
import { refuse, type Refusal } from "../actions/refusal.js";
import { validateRecord, writeRecord, type JevAssessment } from "../project/records.js";
import { hasText } from "../validation.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { readEnvelope } from "./decisions.js";
import { fallbackCovers, readJev } from "./fallback.js";

/**
 * The primary agent's own assessment where Jev gave no usable answer
 * (issue #18, D16, D17): an answer not relied on (below its decision's
 * threshold, or to wording not yet accepted), or none at all, for the
 * failure on record, once continuing without Jev is approved. The
 * assessment rests on evidence and records its resolution. Without a usable
 * answer a binding decision is the developer's, as is anything
 * consequential: the agent's resolution is then only its recommendation.
 */

export interface AssessmentInput {
  readonly decision: string;
  /** The uncertain answer's envelope. */
  readonly envelope?: string;
  /** The failed call's trace, when Jev gave no answer. */
  readonly traceReference?: string;
  readonly assessment: string;
  readonly evidence: readonly string[];
  readonly resolution: string;
  /** Whether the case touches requirements, scope, workflow rules or permissions, or is otherwise the developer's. */
  readonly consequential: boolean;
}

export type AssessmentResult =
  | { readonly ok: true; readonly outcome: { readonly assessment: JevAssessment; readonly askHuman?: HumanAskEvent } }
  | Refusal;

export function assessWithoutJev(
  root: string,
  input: AssessmentInput,
  options: { readonly now: string; readonly stage?: string },
): AssessmentResult {
  if (!hasText(input?.decision)) return refuse("name the decision the assessment stands in for");
  if (!hasText(input.assessment)) return refuse("record the assessment: what the evidence shows");
  if (!hasText(input.resolution)) return refuse("record the resolution the assessment reaches");
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).filter(hasText);
  if (evidence.length === 0) return refuse("an assessment rests on evidence: a command and its output, a file and line, a record");
  if ((input.envelope === undefined) === (input.traceReference === undefined)) {
    return refuse("name either the uncertain answer's envelope or the failed call's trace");
  }
  const current = readJev(root);
  if (!current.ok) return current;

  const workflowPackage = loadShippedWorkflowPackage();
  let binding = workflowPackage.decisions[input.decision]?.authority === "binding";
  if (input.envelope !== undefined) {
    const read = readEnvelope(root, input.envelope);
    if (!read.ok) return read;
    const { envelope } = read;
    if (envelope.decision !== input.decision) return refuse(`envelope ${envelope.id} is ${envelope.decision}'s, not ${input.decision}'s`);
    if (envelope.route !== "ask-human") {
      return refuse(`envelope ${envelope.id}'s answer is usable (${envelope.route}); weigh or act on it, or set it aside with decide choose`);
    }
    binding = envelope.authority === "binding";
  } else {
    const { fallback } = current.record;
    if (!fallbackCovers(root, current.record, options.stage)) {
      return refuse("continuing without Jev needs the developer's approval first (jev approve)");
    }
    if (fallback.traceReference !== input.traceReference || fallback.pendingDecision !== input.decision) {
      return refuse(
        `the failure on record is ${fallback.pendingDecision ?? "none"} (${fallback.traceReference ?? "no trace"}); an assessment stands in for that failure only`,
      );
    }
  }

  // Without a usable answer a binding decision is the developer's, as is anything consequential.
  const escalated = input.consequential === true || binding;
  const numbers = (current.record.assessments ?? []).map((entry) => Number(/^A-(\d+)$/.exec(entry.id)?.[1] ?? 0));
  const assessment: JevAssessment = {
    id: `A-${Math.max(0, ...numbers) + 1}`,
    decision: input.decision,
    ...(input.envelope === undefined ? {} : { envelope: input.envelope }),
    ...(input.traceReference === undefined ? {} : { traceReference: input.traceReference }),
    assessment: input.assessment.trim(),
    evidence,
    resolution: input.resolution.trim(),
    consequential: input.consequential === true,
    status: escalated ? "escalated" : "resolved",
    recordedAt: options.now,
  };
  const next = validateRecord("jev", { ...current.record, assessments: [...(current.record.assessments ?? []), assessment] });
  if (!next.ok) return refuse("the assessment cannot be recorded", next.issues);
  writeRecord(root, "jev", next.record);
  if (!escalated) return { ok: true, outcome: { assessment } };
  return {
    ok: true,
    outcome: {
      assessment,
      askHuman: {
        kind: "human-ask",
        reasons: [
          `${input.decision} without a usable Jev answer: ${assessment.assessment} Recommended: ${assessment.resolution} (assessment ${assessment.id}; the decision is yours)`,
        ],
      },
    },
  };
}
