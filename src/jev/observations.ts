import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fixLimit } from "../actions/implement.js";
import type { ResolutionContext } from "../actions/resolve.js";
import { readRecord } from "../project/records.js";
import { listEnvelopes, readEnvelope, type DecisionEnvelope } from "./decisions.js";
import { kindOfPacket } from "./kinds.js";
import { splitKindsOf } from "./replay.js";
import { listTraces } from "./traces.js";

/**
 * Harness observations (issue #30, D35, D39, D48): how the workflow itself
 * behaved, read as a derived view over what is already stored, the decision
 * envelopes, the local Jev traces and the progress record's fix counters.
 * There is no observation store and nothing here writes: reading them twice
 * gives the same view, and cleaning traces removes the observations they
 * held.
 *
 * Nothing is filtered, by Jev or otherwise. Every low-confidence answer,
 * override, escalation, unanswered call and ticket at the fix limit is
 * listed, and a record that cannot be read is listed as unreadable rather
 * than dropped. Observations are applied never: the only thing that reads
 * them is a question-file proposal, which the developer accepts or not.
 *
 * The view is worth something only because every answer carries a closed
 * reason code (D35), so observations group by why an answer was given.
 */

export const OBSERVATION_KINDS = ["low-confidence", "override", "escalation", "jev-failure", "fix-limit"] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export interface HarnessObservation {
  /** Stable for as long as its source is on disk: the kind and the envelope, trace or ticket it was read from. */
  readonly id: string;
  readonly kind: ObservationKind;
  /** The decision asked; absent for a ticket at the fix limit, which no one decision owns. */
  readonly decision?: string;
  /** Where the decision was asked: its boundary or content kind, or `all`. */
  readonly where?: string;
  readonly reasonCode?: string;
  readonly confidence?: number;
  readonly envelope?: string;
  readonly trace?: string;
  readonly ticket?: string;
  readonly at?: string;
  readonly detail: string;
}

export interface ObservationView {
  readonly observations: readonly HarnessObservation[];
  /** Sources that could not be read, with why. */
  readonly unreadable: readonly { readonly source: string; readonly reason: string }[];
}

function fromEnvelope(envelope: DecisionEnvelope): HarnessObservation[] {
  const { answer } = envelope;
  const common = {
    decision: envelope.decision,
    where: kindOfPacket(envelope.decision, envelope.request.packet.taskSummary),
    reasonCode: answer.reasonCode,
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    envelope: envelope.id,
    trace: answer.traceReference,
    at: envelope.askedAt,
  };
  const observed: HarnessObservation[] = [];
  // An unaccepted wording routes to the developer too, but that is the wording's status, not the answer's confidence.
  if (envelope.route === "ask-human" && envelope.request.question.status === "accepted") {
    observed.push({
      id: `OBS-low-confidence-${envelope.id}`,
      kind: "low-confidence",
      ...common,
      detail: `${envelope.decision} answered "${answer.choice}" below its threshold, so the developer was asked`,
    });
  }
  if (envelope.choice !== undefined && !envelope.choice.followsAnswer) {
    observed.push({
      id: `OBS-override-${envelope.id}`,
      kind: "override",
      ...common,
      detail: `${envelope.choice.by} chose "${envelope.choice.action}" over Jev's "${answer.choice}"${envelope.choice.reason === undefined ? "" : `: ${envelope.choice.reason}`}`,
    });
  }
  if (envelope.decision === "escalate" && answer.choice === "escalate") {
    observed.push({
      id: `OBS-escalation-${envelope.id}`,
      kind: "escalation",
      ...common,
      detail: `escalate answered escalate at ${common.where}`,
    });
  }
  return observed;
}

interface StoredTrace {
  readonly decision?: string;
  readonly requestedAt?: string;
  readonly error?: string;
  readonly response?: { readonly status?: number };
}

/** A call Jev did not answer: a transport error or a status outside 2xx. A trace still in flight has neither. */
function fromTrace(reference: string, trace: StoredTrace): HarnessObservation | undefined {
  const status = trace.response?.status;
  const failure =
    trace.error !== undefined ? trace.error : status !== undefined && (status < 200 || status >= 300) ? `Jev answered HTTP ${status}` : undefined;
  if (failure === undefined) return undefined;
  const name = reference.slice(reference.lastIndexOf("/") + 1, -".json".length);
  return {
    id: `OBS-jev-failure-${name}`,
    kind: "jev-failure",
    ...(typeof trace.decision === "string" ? { decision: trace.decision } : {}),
    trace: reference,
    ...(typeof trace.requestedAt === "string" ? { at: trace.requestedAt } : {}),
    detail: failure,
  };
}

export function readObservations(root: string, context: ResolutionContext): ObservationView {
  const observations: HarnessObservation[] = [];
  const unreadable: { source: string; reason: string }[] = [];

  for (const id of listEnvelopes(root)) {
    const read = readEnvelope(root, id);
    if (read.ok) observations.push(...fromEnvelope(read.envelope));
    else unreadable.push({ source: `envelope ${id}`, reason: read.reason });
  }

  for (const reference of listTraces(root)) {
    try {
      const observed = fromTrace(reference, JSON.parse(readFileSync(join(root, reference), "utf8")) as StoredTrace);
      if (observed !== undefined) observations.push(observed);
    } catch (error) {
      unreadable.push({ source: reference, reason: (error as Error).message });
    }
  }

  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") {
    unreadable.push({ source: progress.path, reason: progress.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") });
  } else if (progress.kind === "present") {
    const limit = fixLimit(context);
    for (const [ticket, attempts] of Object.entries(progress.record.fixAttempts ?? {})) {
      if (attempts < limit) continue;
      observations.push({
        id: `OBS-fix-limit-${ticket}`,
        kind: "fix-limit",
        ticket,
        detail: `${ticket} reached the fix limit: ${attempts} unsuccessful fix attempts, limit ${limit}`,
      });
    }
  }

  return { observations, unreadable };
}

/** The recurrence that makes observations a pattern: the same thing happening more than once. */
export const RECURRENCE_MINIMUM = 2;

/** A change a pattern points at; the agent drafts the change itself, and the developer decides. */
export type SuggestedChange =
  | { readonly change: "question" }
  | { readonly change: "threshold"; readonly for?: string }
  | { readonly change: "authority" };

export interface ObservationPattern {
  readonly kind: ObservationKind;
  readonly decision?: string;
  readonly where?: string;
  readonly reasonCode?: string;
  readonly count: number;
  /** The observations in the pattern, by id, for a proposal to link. */
  readonly observations: readonly string[];
  readonly suggests: readonly SuggestedChange[];
}

function suggestionsFor(kind: ObservationKind, decision: string | undefined, where: string | undefined): SuggestedChange[] {
  if (decision === undefined) return [];
  // A pattern at one kind of a split decision points at that kind's own threshold (D44, D50).
  const threshold: SuggestedChange =
    where !== undefined && splitKindsOf(decision)?.includes(where) === true ? { change: "threshold", for: where } : { change: "threshold" };
  switch (kind) {
    case "low-confidence":
    case "escalation":
      return [threshold, { change: "question" }];
    case "override":
      return [{ change: "question" }, { change: "authority" }];
    case "jev-failure":
      return [{ change: "question" }];
    case "fix-limit":
      return [];
  }
}

/**
 * Observations of one kind, decision, place and reason code that recur,
 * most frequent first. A pattern is where a proposal starts; it changes
 * nothing.
 */
export function findPatterns(observations: readonly HarnessObservation[], minimum = RECURRENCE_MINIMUM): ObservationPattern[] {
  const groups = new Map<string, HarnessObservation[]>();
  for (const observation of observations) {
    const key = [observation.kind, observation.decision, observation.where, observation.reasonCode].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups.values()]
    .filter((members) => members.length >= minimum)
    .map((members) => {
      const { kind, decision, where, reasonCode } = members[0]!;
      return {
        kind,
        ...(decision === undefined ? {} : { decision }),
        ...(where === undefined ? {} : { where }),
        ...(reasonCode === undefined ? {} : { reasonCode }),
        count: members.length,
        observations: members.map((member) => member.id),
        suggests: suggestionsFor(kind, decision, where),
      };
    })
    .sort((a, b) => b.count - a.count);
}
