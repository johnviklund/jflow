import {
  askDecisionRejectingUnlisted,
  reportDecision,
  type DecisionDependencies,
  type DecisionReport,
} from "../jev/decisions.js";
import { loadDecisionQuestion, type DecisionQuestion } from "../jev/client.js";
import { validateRecord, writeRecord } from "../project/records.js";
import { hasText } from "../validation.js";
import type { HumanAskEvent } from "./dispatch.js";
import { refuse, type Refusal } from "./refusal.js";
import { NO_RECOMMENDATION, readWorkers, runnableModel, selectionSubject, stageOptions, type WorkerDraft } from "./workers.js";

/**
 * Jev's advisory `model-selection` decision (issue #28, D49): for a stage
 * worker's assignment, a model and effort chosen only from what the
 * developer configured for that stage.
 *
 * - The options are the model the stage may run now (its configured model,
 *   or only its configured fallback when the host reported that model
 *   unavailable, D20) at each configured effort. They are the question's
 *   choices, beside `no-recommendation`.
 * - An answer outside them is rejected by the workflow and recorded in the
 *   workers record; no worker starts on it, and it is not a Jev outage.
 * - One option leaves nothing to choose, so Jev is not asked; nothing
 *   configured asks the developer, as `worker assign` does.
 * - Following or overriding the recommendation is recorded on its envelope
 *   when the worker is assigned (`worker assign` with `selection`).
 */

export { NO_RECOMMENDATION };

export interface SelectionDraft {
  readonly stage: string;
  readonly role: string;
  readonly ticketId?: string;
  /** What the worker will do, in a sentence or two. */
  readonly task: string;
  readonly unavailable?: WorkerDraft["unavailable"];
}

export type SelectionResult =
  | { readonly ok: true; readonly outcome: { readonly askHuman: HumanAskEvent } }
  | { readonly ok: true; readonly outcome: { readonly kind: "single-option"; readonly options: readonly string[] } }
  | {
      readonly ok: true;
      readonly outcome: {
        readonly kind: "recommended";
        readonly recommendation: { readonly model: string; readonly effort?: string };
        readonly options: readonly string[];
        readonly decision: DecisionReport;
      };
    }
  | {
      readonly ok: true;
      readonly outcome: {
        /** `no-recommendation`, or Jev could not be asked: choose from the options yourself. */
        readonly kind: "no-recommendation";
        readonly options: readonly string[];
        readonly decision: DecisionReport;
      };
    }
  | {
      readonly ok: true;
      readonly outcome: { readonly kind: "rejected"; readonly answer: string; readonly options: readonly string[] };
    }
  | Refusal;

export async function recommendModel(
  root: string,
  draft: SelectionDraft,
  dependencies: DecisionDependencies,
): Promise<SelectionResult> {
  const runnable = runnableModel(draft, dependencies.context);
  if (!runnable.ok || !("model" in runnable)) return runnable;
  if (!hasText(draft.task)) return refuse("say what the worker will do (task), so the recommendation can fit it");
  const offered = stageOptions(runnable.model, runnable.configured);
  const options = offered.map((option) => option.label);
  if (options.length === 1) return { ok: true, outcome: { kind: "single-option", options } };

  // The question's choices are this stage's options; the envelope keeps the question as asked.
  const base = loadDecisionQuestion(dependencies.context.workflowPackage, "model-selection");
  const question: DecisionQuestion = { ...base, answers: [...options, NO_RECOMMENDATION] };
  const result = await askDecisionRejectingUnlisted(
    root,
    "model-selection",
    {
      taskSummary: `${selectionSubject(runnable.action.name, draft.role, draft.ticketId)} ${draft.task.trim()}`,
      candidates: options,
      excerpts: [
        { source: "stage/options", text: options.join("; ") },
        ...(runnable.substitution === undefined
          ? []
          : [{ source: "stage/unavailable", text: `${runnable.substitution.unavailableModel}: ${runnable.substitution.reason}` }]),
      ],
    },
    { ...dependencies, readQuestion: () => question, stage: runnable.action.name },
  );

  if (result.kind === "unlisted") {
    const current = readWorkers(root);
    if (!current.ok) return current;
    const rejection = {
      stage: runnable.action.name,
      role: draft.role,
      ...(draft.ticketId === undefined ? {} : { ticketId: draft.ticketId }),
      answer: result.answer,
      options,
      traceReference: result.traceReference,
      rejectedAt: dependencies.now(),
    };
    const validated = validateRecord("workers", { ...current.record, rejections: [...(current.record.rejections ?? []), rejection] });
    if (!validated.ok) return refuse("the rejection cannot be recorded", validated.issues);
    writeRecord(root, "workers", validated.record);
    return { ok: true, outcome: { kind: "rejected", answer: result.answer, options } };
  }
  if (result.kind === "refused") return refuse(result.reason);
  const decision = reportDecision(result);
  const chosen = result.kind === "answered" ? offered.find((option) => option.label === result.envelope.answer.choice) : undefined;
  if (chosen === undefined) return { ok: true, outcome: { kind: "no-recommendation", options, decision } };
  return {
    ok: true,
    outcome: {
      kind: "recommended",
      recommendation: { model: chosen.model, ...(chosen.effort === undefined ? {} : { effort: chosen.effort }) },
      options,
      decision,
    },
  };
}
