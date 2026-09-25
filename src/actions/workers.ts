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
}

type AssignmentResult = { readonly ok: true; readonly outcome: { readonly assignment: WorkerAssignment } } | Refusal;

export type WorkerResult = AssignmentResult | { readonly ok: true; readonly outcome: { readonly askHuman: HumanAskEvent } };

function readWorkers(root: string): { readonly ok: true; readonly record: WorkersRecord } | Refusal {
  const read = readRecord(root, "workers");
  if (read.kind === "malformed") return unreadable("workers", read);
  return { ok: true, record: read.kind === "present" ? read.record : { assignments: [] } };
}

function save(root: string, record: WorkersRecord, assignment: WorkerAssignment): AssignmentResult {
  const next = validateRecord("workers", {
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

const ask = (reason: string): WorkerResult => ({ ok: true, outcome: { askHuman: { kind: "human-ask", reasons: [reason] } } });

/**
 * Records a worker assigned within a stage. Refused outside the stage's
 * declared roles or delegation limits, for the primary agent, and for any
 * model but the configured one or, when that is unavailable, the
 * configured fallback. Asks the developer when there is nothing configured
 * to run.
 */
export function assignWorker(
  root: string,
  draft: WorkerDraft,
  context: ResolutionContext,
  options: { readonly now: string },
): WorkerResult {
  const { workflowPackage, configuration } = context;
  // The draft arrives as a JSON file; read it defensively.
  const action = workflowPackage.actions.find((entry) => entry.name === draft?.stage);
  if (draft === undefined || action === undefined || action.kind !== "stage") {
    return refuse(`"${String(draft?.stage)}" is not a workflow stage; workers are assigned within a stage`);
  }
  const roles = action.requiredRoles.map((entry) => entry.role);
  if (!roles.includes(draft.role)) {
    return refuse(`stage ${action.name} declares the role${roles.length === 1 ? "" : "s"} ${roles.join(", ")}; a worker stays within them`);
  }
  if (!hasText(draft.agent)) return refuse("name the worker agent");
  if (draft.agent.trim() === PRIMARY_AGENT) {
    return refuse("the primary agent is not a stage worker; its model stays the same across stages and jflow never switches it");
  }
  if (!hasText(draft.model)) return refuse("record the model the worker runs on");

  const setting = `stageModels.${action.name}`;
  const configured = configuration.stageModels[action.name];
  if (configured === undefined) {
    return ask(
      `no worker model is configured for stage ${action.name}; which model should its workers use? jflow never picks one: set ${setting}.model in the configuration, then assign the worker again`,
    );
  }
  const unavailable = draft.unavailable;
  let substitution: WorkerAssignment["substitution"];
  if (unavailable !== undefined) {
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
    if (draft.model !== configured.fallbackModel) {
      return refuse(`${configured.model} is unavailable; only the configured fallback, ${configured.fallbackModel}, may run`);
    }
    substitution = { unavailableModel: configured.model, reason: unavailable.reason.trim() };
  } else if (draft.model !== configured.model) {
    return refuse(
      `stage ${action.name}'s worker model is ${configured.model}; running ${draft.model} instead would be a silent substitution. If ${configured.model} is unavailable, say so`,
    );
  }

  const current = readWorkers(root);
  if (!current.ok) return current;
  const limits = effectiveDelegationLimits(action, configuration);
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
  return save(root, current.record, {
    id: nextId(current.record),
    stage: action.name,
    role: draft.role,
    agent: draft.agent.trim(),
    ...(draft.ticketId === undefined ? {} : { ticketId: draft.ticketId }),
    model: draft.model,
    ...(substitution === undefined ? {} : { substitution }),
    status: "active",
    startedAt: options.now,
  });
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
