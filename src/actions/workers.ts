import type { StageModelConfiguration } from "../config/configuration.js";
import { readEnvelope, recordChoice, type DecisionEnvelope } from "../jev/decisions.js";
import { readRecord, validateRecord, writeRecord, type WorkerAssignment, type WorkersRecord } from "../project/records.js";
import { hasText } from "../validation.js";
import type { HumanAskEvent } from "./dispatch.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";
import { effectiveDelegationLimits, type ResolutionContext } from "./resolve.js";

/**
 * Stage workers (issue #15, D18-D20): the primary agent assigns a worker
 * within a stage's declared roles and delegation limits, on the stage's
 * configured model, and the model it actually ran on is recorded. When that
 * model is unavailable only the explicitly configured fallback may run, and
 * the substitution is recorded; with no fallback, or no model configured,
 * the developer is asked and nothing starts. The primary agent is never a
 * worker, so jflow never changes the main conversational model.
 *
 * The helper cannot observe the host (`pinned-worker-model` is unverified),
 * so the model and any unavailability are as the primary agent reports
 * them; what it enforces is that only a configured model is ever reported.
 */

/** `model-selection`'s answer when no configured option fits (issue #28). */
export const NO_RECOMMENDATION = "no-recommendation";

/** The implementing agent every ticket has: the primary agent coordinates its work. */
export const PRIMARY_AGENT = "primary";

export interface WorkerDraft {
  readonly stage: string;
  readonly role: string;
  readonly agent: string;
  /** The model the worker runs on. */
  readonly model: string;
  readonly ticketId?: string;
  /** The configured model the host reported unavailable, and why. */
  readonly unavailable?: { readonly model: string; readonly reason: string };
  /** The effort it runs at; required where the stage configures efforts (issue #28). */
  readonly effort?: string;
  /**
   * The `model-selection` envelope this choice answers. Following its
   * recommendation needs nothing more; setting it aside needs a reason and
   * evidence, and below its threshold only the developer decides.
   */
  readonly selection?: {
    readonly envelope: string;
    readonly by?: "agent" | "developer";
    readonly reason?: string;
    readonly evidence?: readonly string[];
  };
}

type AssignmentResult = { readonly ok: true; readonly outcome: { readonly assignment: WorkerAssignment } } | Refusal;

export type WorkerResult = AssignmentResult | AskResult;

export function readWorkers(root: string): { readonly ok: true; readonly record: WorkersRecord } | Refusal {
  const read = readRecord(root, "workers");
  if (read.kind === "malformed") return unreadable("workers", read);
  return { ok: true, record: read.kind === "present" ? read.record : { assignments: [] } };
}

function save(root: string, record: WorkersRecord, assignment: WorkerAssignment): AssignmentResult {
  const next = validateRecord("workers", {
    ...record,
    assignments: record.assignments.some((entry) => entry.id === assignment.id)
      ? record.assignments.map((entry) => (entry.id === assignment.id ? assignment : entry))
      : [...record.assignments, assignment],
  });
  if (!next.ok) return refuse("the worker assignment cannot be recorded", next.issues);
  writeRecord(root, "workers", next.record);
  return { ok: true, outcome: { assignment } };
}

function nextId(record: WorkersRecord): string {
  const numbers = record.assignments.map((entry) => Number(/^W-(\d+)$/.exec(entry.id)?.[1] ?? 0));
  return `W-${Math.max(0, ...numbers) + 1}`;
}

type AskResult = { readonly ok: true; readonly outcome: { readonly askHuman: HumanAskEvent } };

const ask = (reason: string): AskResult => ({ ok: true, outcome: { askHuman: { kind: "human-ask", reasons: [reason] } } });

/** A stage's action, as the workers within it see it. */
type StageAction = ResolutionContext["workflowPackage"]["actions"][number];

/**
 * The model a stage's workers may run now (D20): the configured one, or,
 * when the host reported it unavailable, only the configured fallback.
 * Asks the developer when there is nothing configured to run.
 */
export type RunnableModel =
  | {
      readonly ok: true;
      readonly action: StageAction;
      readonly configured: StageModelConfiguration;
      readonly model: string;
      readonly substitution?: NonNullable<WorkerAssignment["substitution"]>;
    }
  | AskResult
  | Refusal;

/** The stage a worker is drafted for, refused unless it is a stage and the role one it declares. */
function stageOf(
  draft: { readonly stage: string; readonly role: string } | undefined,
  context: ResolutionContext,
): { readonly ok: true; readonly action: StageAction } | Refusal {
  // The draft arrives as a JSON file; read it defensively.
  const action = context.workflowPackage.actions.find((entry) => entry.name === draft?.stage);
  if (draft === undefined || action === undefined || action.kind !== "stage") {
    return refuse(`"${String(draft?.stage)}" is not a workflow stage; workers are assigned within a stage`);
  }
  const roles = action.requiredRoles.map((entry) => entry.role);
  if (!roles.includes(draft.role)) {
    return refuse(`stage ${action.name} declares the role${roles.length === 1 ? "" : "s"} ${roles.join(", ")}; a worker stays within them`);
  }
  return { ok: true, action };
}

export function runnableModel(
  draft: { readonly stage: string; readonly role: string; readonly unavailable?: WorkerDraft["unavailable"] },
  context: ResolutionContext,
): RunnableModel {
  const { configuration } = context;
  const stage = stageOf(draft, context);
  if (!stage.ok) return stage;
  const { action } = stage;
  const setting = `stageModels.${action.name}`;
  const configured = configuration.stageModels[action.name];
  if (configured === undefined) {
    return ask(
      `no worker model is configured for stage ${action.name}; which model should its workers use? jflow never picks one: set ${setting}.model in the configuration, then assign the worker again`,
    );
  }
  const unavailable = draft.unavailable;
  if (unavailable === undefined) return { ok: true, action, configured, model: configured.model };
  if (!hasText(unavailable.reason)) return refuse("record why the model is unavailable, as the host reported it");
  if (configured.fallbackModel !== undefined && unavailable.model === configured.fallbackModel) {
    return ask(
      `both worker models for stage ${action.name}, ${configured.model} and its fallback ${configured.fallbackModel}, are unavailable (${unavailable.reason}); which model should run? Nothing has started. Change ${setting} in the configuration, then assign the worker again`,
    );
  }
  if (unavailable.model !== configured.model) {
    return refuse(`stage ${action.name} is configured with ${configured.model}; only its unavailability allows the fallback`);
  }
  if (configured.fallbackModel === undefined) {
    return ask(
      `${configured.model}, the worker model for stage ${action.name}, is unavailable (${unavailable.reason}) and no fallback is configured; which model should run? Nothing has started. Set ${setting}.fallbackModel, or another model, in the configuration, then assign the worker again`,
    );
  }
  return {
    ok: true,
    action,
    configured,
    model: configured.fallbackModel,
    substitution: { unavailableModel: configured.model, reason: unavailable.reason.trim() },
  };
}

/** A worker option as `model-selection` names it: the model, and the effort where the stage configures efforts. */
export function optionLabel(model: string, effort?: string): string {
  return effort === undefined ? model : `${model} @ ${effort}`;
}

export interface WorkerOption {
  readonly model: string;
  readonly effort?: string;
  /** The option as Jev is offered it. */
  readonly label: string;
}

/** The options a stage's worker may run on now: the runnable model at each configured effort. */
export function stageOptions(model: string, configured: StageModelConfiguration): readonly WorkerOption[] {
  return configured.efforts === undefined
    ? [{ model, label: model }]
    : configured.efforts.map((effort) => ({ model, effort, label: optionLabel(model, effort) }));
}

/** How a `model-selection` packet names the assignment it was asked for; `worker assign` matches a selection by it. */
export function selectionSubject(stage: string, role: string, ticketId?: string): string {
  return `Stage ${stage}, role ${role}${ticketId === undefined ? "" : `, ticket ${ticketId}`}:`;
}

/**
 * The choice to record on a `model-selection` envelope, checked before
 * anything is written: the envelope must be model-selection's, asked for
 * this stage, role and ticket, with a recommendation, and not yet used.
 */
function selectionFor(
  root: string,
  draft: WorkerDraft & { readonly selection: NonNullable<WorkerDraft["selection"]> },
  stage: string,
): { readonly ok: true; readonly envelope: DecisionEnvelope } | Refusal {
  const read = readEnvelope(root, draft.selection.envelope);
  if (!read.ok) return read;
  const { envelope } = read;
  if (envelope.decision !== "model-selection") return refuse(`envelope ${envelope.id} is ${envelope.decision}'s, not model-selection's`);
  if (!envelope.request.packet.taskSummary.startsWith(selectionSubject(stage, draft.role, draft.ticketId))) {
    return refuse(`envelope ${envelope.id} was asked for another assignment, not ${selectionSubject(stage, draft.role, draft.ticketId).slice(0, -1)}`);
  }
  if (envelope.choice !== undefined) {
    return refuse(`envelope ${envelope.id} already records the choice "${envelope.choice.action}"; each worker needs its own recommendation`);
  }
  if (envelope.answer.choice === NO_RECOMMENDATION) {
    return refuse(`envelope ${envelope.id} made no recommendation, so there is nothing to follow or set aside; assign without selection`);
  }
  return { ok: true, envelope };
}

/**
 * Records a worker assigned within a stage. Refused outside the stage's
 * declared roles or delegation limits, for the primary agent, for any
 * model but the configured one or, when that is unavailable, the
 * configured fallback, and for an effort the stage does not configure.
 * Asks the developer when there is nothing configured to run. With a
 * `selection`, the choice is recorded on that `model-selection` envelope
 * first; setting its recommendation aside needs a reason and evidence.
 */
export function assignWorker(
  root: string,
  draft: WorkerDraft,
  context: ResolutionContext,
  options: { readonly now: string },
): WorkerResult {
  const stage = stageOf(draft, context);
  if (!stage.ok) return stage;
  if (!hasText(draft.agent)) return refuse("name the worker agent");
  if (draft.agent.trim() === PRIMARY_AGENT) {
    return refuse("the primary agent is not a stage worker; its model stays the same across stages and jflow never switches it");
  }
  if (!hasText(draft.model)) return refuse("record the model the worker runs on");
  const runnable = runnableModel(draft, context);
  if (!runnable.ok || !("model" in runnable)) return runnable;
  const { action, configured } = runnable;
  if (draft.model !== runnable.model) {
    return refuse(
      runnable.substitution !== undefined
        ? `${configured.model} is unavailable; only the configured fallback, ${runnable.model}, may run`
        : `stage ${action.name}'s worker model is ${configured.model}; running ${draft.model} instead would be a silent substitution. If ${configured.model} is unavailable, say so`,
    );
  }
  const efforts = configured.efforts;
  if (efforts === undefined && draft.effort !== undefined) {
    return refuse(`stage ${action.name} configures no efforts; leave effort out, or set stageModels.${action.name}.efforts`);
  }
  if (efforts !== undefined && (draft.effort === undefined || !efforts.includes(draft.effort))) {
    return refuse(`stage ${action.name}'s workers run at one of the configured efforts, ${efforts.join(", ")}; record which (effort)`);
  }

  const current = readWorkers(root);
  if (!current.ok) return current;
  const limits = effectiveDelegationLimits(action, context.configuration);
  const allowed = limits.allowParallelWithinUnit ? limits.maxParallelWorkers : 1;
  // The limits hold within one unit of work: the ticket, when there is one.
  const active = current.record.assignments.filter(
    (entry) => entry.stage === action.name && entry.status === "active" && entry.ticketId === draft.ticketId,
  );
  if (active.length >= allowed) {
    return refuse(
      `stage ${action.name} allows ${allowed} worker${allowed === 1 ? "" : "s"} at a time within one unit of work, and ${active
        .map((entry) => entry.id)
        .join(", ")} ${active.length === 1 ? "is" : "are"} still active; finish one first`,
    );
  }
  const selection = draft.selection === undefined ? undefined : selectionFor(root, { ...draft, selection: draft.selection }, action.name);
  if (selection !== undefined && !selection.ok) return selection;
  const assignment: WorkerAssignment = {
    id: nextId(current.record),
    stage: action.name,
    role: draft.role,
    agent: draft.agent.trim(),
    ...(draft.ticketId === undefined ? {} : { ticketId: draft.ticketId }),
    model: draft.model,
    ...(runnable.substitution === undefined ? {} : { substitution: runnable.substitution }),
    ...(draft.effort === undefined ? {} : { effort: draft.effort }),
    ...(draft.selection === undefined ? {} : { selection: draft.selection.envelope }),
    status: "active",
    startedAt: options.now,
  };
  const next = validateRecord("workers", { ...current.record, assignments: [...current.record.assignments, assignment] });
  if (!next.ok) return refuse("the worker assignment cannot be recorded", next.issues);
  if (selection !== undefined && draft.selection !== undefined) {
    // Recorded beside Jev's answer only once the assignment is known to be valid (D6).
    const chose = recordChoice(
      root,
      selection.envelope.id,
      {
        action: optionLabel(draft.model, draft.effort),
        by: draft.selection.by ?? "agent",
        ...(draft.selection.reason === undefined ? {} : { reason: draft.selection.reason }),
        ...(draft.selection.evidence === undefined ? {} : { evidence: draft.selection.evidence }),
      },
      selection.envelope.request.question.answers,
      { now: options.now },
    );
    if (!chose.ok) return chose;
  }
  writeRecord(root, "workers", next.record);
  return { ok: true, outcome: { assignment } };
}

/** Records that a worker finished, freeing its place within the stage's limits. */
export function finishWorker(root: string, id: string, options: { readonly now: string }): AssignmentResult {
  const current = readWorkers(root);
  if (!current.ok) return current;
  const entry = current.record.assignments.find((assignment) => assignment.id === id);
  if (entry === undefined) return refuse(`no worker assignment "${id}"`);
  if (entry.status === "finished") return refuse(`worker ${id} has already finished`);
  return save(root, current.record, { ...entry, status: "finished", finishedAt: options.now });
}

/**
 * The stage workers recorded as working on a ticket, or on any ticket when
 * none is named; a reviewer is none of them (D32). Workers in the review
 * stage are reviewers, not implementers.
 */
export function recordedImplementers(root: string, ticketId?: string): { readonly ok: true; readonly agents: readonly string[] } | Refusal {
  const current = readWorkers(root);
  if (!current.ok) return current;
  const agents = current.record.assignments
    .filter((entry) => entry.stage !== "review" && (ticketId === undefined ? entry.ticketId !== undefined : entry.ticketId === ticketId))
    .map((entry) => entry.agent);
  return { ok: true, agents: [...new Set(agents)] };
}
