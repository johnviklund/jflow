import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StageModelConfiguration } from "../config/configuration.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import { askEscalation, humanAskAt, type EscalationAsk } from "../jev/escalation.js";
import type { EvidenceExcerpt } from "../jev/evidence.js";
import {
  evidenceExcerpt,
  validateTicket,
  type TicketValidationResult,
  type ValidationInput,
} from "../jev/ticket-validation.js";
import { ensureLocalDirectory } from "../jev/traces.js";
import {
  EMPTY_PROGRESS,
  readRecord,
  validateRecord,
  writeRecord,
  type ProgressRecord,
  type TicketRecord,
  type TicketsRecord,
} from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { hasText } from "../validation.js";
import type { DelegationLimits } from "../workflow/types.js";
import { refuse, unreadable, unreadableState, type Refusal } from "./refusal.js";
import { resolveAction, type ResolutionContext } from "./resolve.js";

/**
 * The helper's part of `implement` (issue #8, D41, D47, D48, D51): starting
 * exactly one ticket under recorded execution authorization, recording the
 * ticket's check output as verification evidence, putting it through the
 * binding `validate` gate, and holding the ticket's one fix counter.
 *
 * Nothing here commits or marks a ticket done. A ticket stays `in-progress`
 * until it has passed review, so one lost to compaction before then is
 * redone from its definition rather than half-resumed. The checks themselves
 * are run by the agent; this module spawns no process.
 */

/** Where a ticket's latest verification evidence is kept: local, outside version control, like the traces. */
export const EVIDENCE_DIRECTORY = ".jflow/evidence";

const FIX_LIMIT_SETTING = "review.fixRetryLimit";
const DEFAULT_FIX_LIMIT = 2;

/** The ticket's fix counter as it stands after a failure, and whether that failure counted. */
export interface FixCount {
  readonly attempts: number;
  readonly limit: number;
  /** False for the ticket's first failure: the implementation is not yet a fix attempt. */
  readonly counted: boolean;
  /** The escalate envelope asked at the limit. */
  readonly escalation?: string;
}

export interface StartedTicket {
  readonly ticket: TicketRecord;
  /** How much parallel sub-work the ticket may use (the stage's limits, bounded by configuration). */
  readonly delegationLimits: DelegationLimits;
  readonly stageModel?: StageModelConfiguration;
  readonly setupWarnings: readonly string[];
  readonly fix: { readonly attempts: number; readonly limit: number };
}

export type StartResult = { readonly ok: true; readonly outcome: StartedTicket } | Refusal;

export function fixLimit(context: ResolutionContext): number {
  const configured = context.configuration.settings[FIX_LIMIT_SETTING];
  return typeof configured === "number" ? configured : DEFAULT_FIX_LIMIT;
}

interface Records {
  readonly progress: ProgressRecord;
  readonly tickets: TicketsRecord;
}

function readRecords(root: string): { readonly ok: true; readonly records: Records } | Refusal {
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return unreadable("progress", progress);
  const tickets = readRecord(root, "tickets");
  if (tickets.kind === "malformed") return unreadable("tickets", tickets);
  return {
    ok: true,
    records: {
      progress: progress.kind === "present" ? progress.record : EMPTY_PROGRESS,
      tickets: tickets.kind === "present" ? tickets.record : { tickets: [] },
    },
  };
}

const NO_TICKET = "no ticket is assigned; implement works on one ticket at a time";

/**
 * Which ticket a start request is for. Under ticket scope only the assigned
 * ticket; under whole-plan scope the one named, or the one already assigned.
 * Without authorization the resolver refuses, so the request is taken as is.
 */
function targetOf(
  progress: ProgressRecord,
  requested: string | undefined,
): { readonly ok: true; readonly target?: string } | Refusal {
  const target = requested ?? progress.assignedTicketId;
  if (!progress.executionAuthorized) return { ok: true, ...(target === undefined ? {} : { target }) };
  if (progress.authorizationScope === "ticket" && requested !== undefined && requested !== progress.assignedTicketId) {
    return refuse(
      `execution is authorized for ticket ${progress.assignedTicketId} only; ${requested} needs the developer's own authorization`,
    );
  }
  if (target === undefined) {
    return refuse(
      progress.authorizationScope === "plan" ? "whole-plan authorization covers every ticket; name the ticket to start" : NO_TICKET,
    );
  }
  return { ok: true, target };
}

/**
 * Starts one ticket: refused without recorded execution authorization or
 * any other unmet `implement` prerequisite, while another ticket is in
 * progress, or before the ticket's dependencies are done. Under ticket
 * scope only the authorized ticket starts; under whole-plan scope the
 * caller names it. Starting a ticket already in progress is allowed, to redo
 * it after lost context. Marks the ticket in progress and its work begun,
 * so new changes in the working tree are presumed the ticket's (issue #7).
 */
export function startTicket(
  root: string,
  request: { readonly ticketId?: string },
  context: ResolutionContext,
): StartResult {
  const state = readProjectState(root);
  if (state.kind === "malformed") return unreadableState(state);
  const read = readRecords(root);
  if (!read.ok) return read;
  const { progress, tickets } = read.records;

  const targeted = targetOf(progress, request.ticketId);
  if (!targeted.ok) return targeted;
  const { target } = targeted;

  const resolution = resolveAction(
    { action: "implement" },
    { ...state.state, ...(target === undefined ? {} : { assignedTicketId: target }) },
    context,
  );
  if (resolution.status === "unknown-action") return refuse(resolution.message);
  if (resolution.status === "blocked") return refuse(resolution.unmet.map((entry) => entry.reason).join("; "));
  if (target === undefined) return refuse(NO_TICKET);

  const ticket = tickets.tickets.find((entry) => entry.id === target);
  if (ticket === undefined) {
    return refuse(`no ticket "${target}" in the plan; tickets are ${tickets.tickets.map((entry) => entry.id).join(", ") || "none"}`);
  }
  const other = tickets.tickets.find((entry) => entry.status === "in-progress" && entry.id !== target);
  if (other !== undefined) {
    return refuse(`ticket ${other.id} is in progress; one ticket at a time, so it passes review or is parked before ${target} starts`);
  }
  if (ticket.status !== "ready" && ticket.status !== "in-progress") {
    return refuse(`ticket ${target} is ${ticket.status}; only a ready ticket starts`);
  }
  const waiting = ticket.dependsOn
    .map((id) => tickets.tickets.find((entry) => entry.id === id))
    .filter((entry): entry is TicketRecord => entry !== undefined && entry.status !== "done");
  if (waiting.length > 0) {
    return refuse(
      `ticket ${target} depends on ${waiting.map((entry) => `${entry.id} (${entry.status})`).join(", ")}, not yet done`,
    );
  }

  const started: TicketRecord = { ...ticket, status: "in-progress" };
  const nextTickets = validateRecord("tickets", {
    tickets: tickets.tickets.map((entry) => (entry.id === target ? started : entry)),
  });
  if (!nextTickets.ok) return refuse("the ticket cannot be started as recorded", nextTickets.issues);
  const nextProgress = validateRecord("progress", { ...progress, assignedTicketId: target, ticketChangesPresent: true });
  if (!nextProgress.ok) return refuse("the progress record cannot be updated", nextProgress.issues);
  writeRecord(root, "tickets", nextTickets.record);
  writeRecord(root, "progress", nextProgress.record);

  return {
    ok: true,
    outcome: {
      ticket: started,
      delegationLimits: resolution.delegationLimits,
      ...(resolution.stageModel === undefined ? {} : { stageModel: resolution.stageModel }),
      setupWarnings: resolution.setupWarnings,
      fix: { attempts: progress.fixAttempts?.[target] ?? 0, limit: fixLimit(context) },
    },
  };
}

/** The ticket being worked on: execution authorized, the ticket assigned and in progress. */
export function readWorkingTicket(
  root: string,
  ticketId: unknown,
): { readonly ok: true; readonly ticket: TicketRecord; readonly progress: ProgressRecord } | Refusal {
  const read = readRecords(root);
  if (!read.ok) return read;
  const { progress, tickets } = read.records;
  if (!progress.executionAuthorized) {
    return refuse("execution has not been authorized; implement records nothing without the developer's authorization");
  }
  const ticket = tickets.tickets.find((entry) => entry.id === ticketId);
  if (ticket === undefined) return refuse(`no ticket "${String(ticketId)}" in the plan`);
  if (ticket.status !== "in-progress" || progress.assignedTicketId !== ticket.id) {
    return refuse(`ticket ${ticket.id} has not been started; run implement start first`);
  }
  return { ok: true, ticket, progress };
}

export interface FixFailure {
  readonly ticketId: string;
  /** What failed: the criteria not met, or the blocking finding. */
  readonly summary: string;
  readonly excerpts: readonly EvidenceExcerpt[];
  /** The agent's recommended next step; required when this failure reaches the limit. */
  readonly recommendation?: string;
}

export type FixCountResult =
  | { readonly ok: true; readonly fix: FixCount; readonly askHuman?: EscalationAsk }
  | Refusal;

/**
 * The counter after one more failure. Absent means the ticket has never
 * failed; its first failure records 0 and counts nothing.
 */
function afterFailure(current: number | undefined, limit: number): { readonly attempts: number; readonly counted: boolean; readonly atLimit: boolean } {
  const counted = current !== undefined;
  const attempts = counted ? current + 1 : 0;
  return { attempts, counted, atLimit: counted && attempts >= limit };
}

/** Whether the ticket's next counted failure reaches the fix limit, so it needs a recommendation first. */
export function nextFailureReachesLimit(progress: ProgressRecord, ticketId: string, context: ResolutionContext): boolean {
  return afterFailure(progress.fixAttempts?.[ticketId], fixLimit(context)).atLimit;
}


/**
 * Records one failure on the ticket's single fix counter (D48), whichever
 * gate found it: a `not-met` criterion here or a blocking review finding
 * (#9). The ticket's first failure only returns it to fix, since the
 * implementation is not a fix attempt; every failure after that is an
 * unsuccessful fix attempt and counts. At the configured limit `escalate`
 * is asked at `fix-failed` with the attempts, the evidence and the agent's
 * recommendation: a confident `proceed` keeps fixing, anything else asks
 * the developer.
 */
export async function countUnsuccessfulFix(
  root: string,
  failure: FixFailure,
  dependencies: DecisionDependencies,
): Promise<FixCountResult> {
  const working = readWorkingTicket(root, failure.ticketId);
  if (!working.ok) return working;
  const { ticket, progress } = working;
  const limit = fixLimit(dependencies.context);
  const { attempts, counted, atLimit } = afterFailure(progress.fixAttempts?.[ticket.id], limit);
  const recommendation = failure.recommendation?.trim() ?? "";
  if (atLimit && recommendation === "") {
    return refuse(`this failure reaches the fix limit (${limit}); record it with a recommendation for the developer`);
  }

  const nextProgress = validateRecord("progress", {
    ...progress,
    fixAttempts: { ...progress.fixAttempts, [ticket.id]: attempts },
  });
  if (!nextProgress.ok) return refuse("the fix counter cannot be recorded", nextProgress.issues);
  writeRecord(root, "progress", nextProgress.record);
  if (!atLimit) return { ok: true, fix: { attempts, limit, counted } };

  const summary = `Ticket ${ticket.id} (${ticket.title}) has had ${attempts} unsuccessful fix attempt${attempts === 1 ? "" : "s"}; the limit is ${limit}. ${failure.summary}`;
  const escalation = await askEscalation(
    root,
    {
      kind: "fix-failed",
      summary,
      excerpts: [...failure.excerpts, { source: "recommendation", text: recommendation }],
    },
    dependencies,
  );
  const fix = { attempts, limit, counted };
  switch (escalation.kind) {
    case "refused":
    case "hard-rule":
      return {
        ok: true,
        fix,
        askHuman: humanAskAt("fix-failed", summary, escalation.kind === "refused" ? escalation.reason : "a hard rule applies"),
      };
    case "needs-configuration":
    case "failed":
      return { ok: true, fix, askHuman: escalation.askHuman };
    case "answered":
      return {
        ok: true,
        fix: { ...fix, escalation: escalation.envelope },
        ...(escalation.askHuman === undefined ? {} : { askHuman: escalation.askHuman }),
      };
  }
}

/** What the agent ran for the ticket, plus its recommendation should this attempt reach the fix limit. */
export interface CheckInput extends ValidationInput {
  readonly recommendation?: string;
  /** Sub-agents that worked on the ticket besides the primary agent; none of them may review it. */
  readonly workers?: readonly string[];
}

export type CheckResult =
  | Extract<TicketValidationResult, { kind: "refused" | "needs-configuration" | "failed" }>
  | (Extract<TicketValidationResult, { kind: "validated" }> & {
      /** Where the verification evidence was recorded, relative to the project root. */
      readonly evidence: string;
      /** Present when a criterion was not met. */
      readonly fix?: FixCount;
    });

function recordEvidence(root: string, input: ValidationInput, recordedAt: string): string {
  ensureLocalDirectory(root, EVIDENCE_DIRECTORY);
  const reference = `${EVIDENCE_DIRECTORY}/${encodeURIComponent(input.ticketId)}.json`;
  const stored = { ticketId: input.ticketId, evidence: input.evidence, checks: input.checks ?? [], recordedAt };
  writeFileSync(join(root, reference), `${JSON.stringify(stored, null, 2)}\n`);
  return reference;
}

/** Adds the ticket's workers to its recorded implementers, which review checks its reviewer against (D32). */
function recordImplementers(root: string, ticketId: string, workers: readonly string[]): { readonly ok: true } | Refusal {
  if (workers.length === 0) return { ok: true };
  const read = readRecords(root);
  if (!read.ok) return read;
  const { progress } = read.records;
  const known = progress.implementers?.[ticketId] ?? [];
  const next = validateRecord("progress", {
    ...progress,
    implementers: { ...progress.implementers, [ticketId]: [...new Set([...known, ...workers.map((id) => id.trim())])] },
  });
  if (!next.ok) return refuse("the ticket's implementers cannot be recorded", next.issues);
  writeRecord(root, "progress", next.record);
  return { ok: true };
}

/**
 * Records the ticket's check output as verification evidence and asks the
 * binding `validate` gate over it. All criteria `met` admits the ticket to
 * review; a `not-met` returns it to fix and counts on the fix counter;
 * `needs-check` names the checks still to run; a missing check with none
 * left has already asked `escalate`. An attempt whose failure would reach
 * the fix limit is refused up front without a recommendation, so the
 * developer is never asked without one.
 */
export async function checkTicket(
  root: string,
  input: CheckInput,
  dependencies: DecisionDependencies,
): Promise<CheckResult> {
  const working = readWorkingTicket(root, input?.ticketId);
  if (!working.ok) return { kind: "refused", reason: working.reason };
  const { ticket, progress } = working;
  const { recommendation, workers, ...validation } = input;
  if (workers !== undefined && (!Array.isArray(workers) || !workers.every(hasText))) {
    return { kind: "refused", reason: "workers must list the id of each sub-agent that worked on the ticket" };
  }
  if (nextFailureReachesLimit(progress, ticket.id, dependencies.context) && !hasText(recommendation)) {
    return {
      kind: "refused",
      reason: "if this attempt fails it reaches the fix limit; include a recommendation for the developer before checking",
    };
  }

  const result = await validateTicket(root, validation, dependencies);
  if (result.kind === "refused") return result;
  const evidence = recordEvidence(root, validation, dependencies.now());
  const recorded = recordImplementers(root, ticket.id, workers ?? []);
  if (!recorded.ok) return { kind: "refused", reason: recorded.reason };
  if (result.kind !== "validated") return result;

  const notMet = result.validation.criteria.filter((entry) => entry.verdict === "not-met");
  if (notMet.length === 0) return { ...result, evidence };
  const counted = await countUnsuccessfulFix(
    root,
    {
      ticketId: ticket.id,
      summary: `Validation found ${notMet.length} of ${result.validation.criteria.length} criteria not met.`,
      excerpts: [
        ...notMet.map((entry) => ({ source: "not-met", text: entry.criterion })),
        ...validation.evidence.filter((entry) => entry.kind === "check").map(evidenceExcerpt),
      ],
      ...(recommendation === undefined ? {} : { recommendation }),
    },
    dependencies,
  );
  if (!counted.ok) return { kind: "refused", reason: counted.reason };
  return {
    ...result,
    evidence,
    fix: counted.fix,
    ...(counted.askHuman === undefined ? {} : { askHuman: counted.askHuman }),
  };
}
