import type { ValidationIssue } from "../workflow/types.js";
import { validateProposedQuestion } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { askJev, type DecisionQuestion } from "./client.js";
import {
  jevClientOptions,
  listEnvelopes,
  readEnvelope,
  type DecisionDependencies,
  type DecisionEnvelope,
  type DecisionRoute,
} from "./decisions.js";
import { escalationOf } from "./escalation.js";
import { contentKindOf } from "../actions/classify.js";

/**
 * Minimal replay (issue #27, D36, D46): a proposed question wording or
 * confidence threshold for one declared decision is re-run against that
 * decision's stored envelopes, and the report says how many answers would
 * change and in which direction, by boundary kind and by reason code, each
 * change linked to its envelope.
 *
 * Minimal means exactly that: load the envelopes, ask Jev over each stored
 * packet in its stored frame, diff the answers. It gates a proposal; it
 * does not score one or evaluate Jev. It reads only envelopes, never chat
 * history. Each call is traced under `.jflow/traces/` like any other. It
 * writes no envelope, no project record and no Jev fallback status, makes
 * no workflow decision, and changes no question or policy file.
 *
 * Each envelope is compared with what it recorded, and only the proposal
 * varies:
 * - A proposed threshold alone re-routes the stored answers; Jev is not
 *   asked, so the report shows the threshold's effect and not Jev's
 *   run-to-run variance. A stored wording that was not accepted still
 *   routes to the developer.
 * - A proposed question is asked over each stored packet and routed as if
 *   accepted, under the proposed threshold or else the one the envelope
 *   was routed by, so a later policy change is not credited to the wording.
 *
 * Kinds: `escalate` breaks down by boundary kind and `classify` by content
 * kind; every other decision is one kind, `all`.
 */

export interface ReplayProposal {
  /** A proposed question file for the decision, as it would ship. */
  readonly question?: unknown;
  /** A proposed confidence threshold, 0 to 1. */
  readonly threshold?: number;
}

export interface ReplayDirection {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

export interface ReplayTally {
  readonly replayed: number;
  /** Answers whose choice or route would change. */
  readonly changed: number;
  readonly directions: readonly ReplayDirection[];
}

export interface ReplayChange {
  readonly envelope: string;
  /** The boundary kind for `escalate`; `all` for a decision asked in one kind of place. */
  readonly kind: string;
  /** The stored answer's reason code. */
  readonly reasonCode: string;
  readonly from: { readonly answer: string; readonly route: DecisionRoute };
  readonly to: {
    readonly answer: string;
    readonly reasonCode: string;
    readonly confidence?: number;
    readonly route: DecisionRoute;
  };
}

export interface ReplayReport {
  readonly decision: string;
  readonly envelopes: number;
  /** Present when there was nothing to replay: the report says so rather than succeeding empty. */
  readonly nothingToReplay?: string;
  readonly question?: { readonly version: number; readonly status: string };
  readonly threshold: number;
  readonly replayed: number;
  readonly changed: number;
  readonly unchanged: number;
  /** Answer changes, from the stored choice to the replayed one. */
  readonly directions: readonly ReplayDirection[];
  /** Route changes: `act` or `weigh` to `ask-human`, and back. */
  readonly routeChanges: readonly ReplayDirection[];
  /** Reason-code changes among the replayed answers, whether or not the answer changed. */
  readonly reasonChanges: readonly ReplayDirection[];
  readonly byKind: Readonly<Record<string, ReplayTally>>;
  readonly byReasonCode: Readonly<Record<string, ReplayTally>>;
  readonly changes: readonly ReplayChange[];
  /** Envelopes Jev could not be asked about, with why; they count as neither changed nor unchanged. */
  readonly failed: readonly { readonly envelope: string; readonly error: string }[];
  /** Stored envelopes, of any decision, that could not be read. */
  readonly unreadable: readonly { readonly envelope: string; readonly reason: string }[];
}

export type ReplayResult =
  | { readonly ok: true; readonly report: ReplayReport }
  | { readonly ok: false; readonly reason: string; readonly issues?: readonly ValidationIssue[] }
  | { readonly ok: false; readonly askHuman: string };

/** Decisions whose choices are built per call rather than read from the question file (issue #28). */
const CHOICES_PER_CALL: ReadonlySet<string> = new Set(["model-selection", "classify"]);

/** Where an envelope was asked: the boundary kind for `escalate`, the content kind for `classify`. */
function kindOf(envelope: DecisionEnvelope): string {
  if (envelope.decision === "escalate") return escalationOf(envelope).boundary;
  if (envelope.decision === "classify") return contentKindOf(envelope);
  return "all";
}

/** Counts from-to pairs in order of first appearance. */
function countDirections(pairs: readonly (readonly [string, string])[]): ReplayDirection[] {
  const counts = new Map<string, ReplayDirection>();
  for (const [from, to] of pairs) {
    const key = `${from}\u0000${to}`;
    const current = counts.get(key);
    counts.set(key, { from, to, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()];
}

interface Replayed {
  readonly envelope: DecisionEnvelope;
  readonly reasonCode: string;
  readonly change?: ReplayChange;
}

const changesOf = (entries: readonly Replayed[]) => entries.flatMap((entry) => (entry.change === undefined ? [] : [entry.change]));

function tallyOf(entries: readonly Replayed[]): ReplayTally {
  const changes = changesOf(entries);
  return {
    replayed: entries.length,
    changed: changes.length,
    directions: countDirections(
      changes.filter((change) => change.from.answer !== change.to.answer).map((change) => [change.from.answer, change.to.answer]),
    ),
  };
}

function groupBy(entries: readonly Replayed[], key: (entry: Replayed) => string): Record<string, ReplayTally> {
  const groups = new Map<string, Replayed[]>();
  for (const entry of entries) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return Object.fromEntries([...groups].map(([name, members]) => [name, tallyOf(members)]));
}

/** A route by confidence and threshold, for a wording that is accepted; never relied on without a finite confidence. */
function routeUnder(authority: string, confidence: number | undefined, threshold: number): DecisionRoute {
  if (confidence === undefined || !Number.isFinite(confidence) || confidence < threshold) return "ask-human";
  return authority === "binding" ? "act" : "weigh";
}

export async function replayDecision(
  root: string,
  decision: string,
  proposal: ReplayProposal,
  dependencies: DecisionDependencies,
): Promise<ReplayResult> {
  const { workflowPackage } = dependencies.context;
  const declaration = workflowPackage.decisions[decision];
  if (declaration === undefined || workflowPackage.policy[decision] === undefined) {
    const known = Object.keys(workflowPackage.decisions).join(", ");
    return { ok: false, reason: `"${decision}" is not a declared decision; declared decisions are ${known}` };
  }
  if (proposal.question === undefined && proposal.threshold === undefined) {
    return { ok: false, reason: "replay needs a proposed question or a proposed threshold" };
  }
  const { threshold } = proposal;
  if (threshold !== undefined && (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1))) {
    return { ok: false, reason: `a proposed threshold is a number from 0 to 1, not ${String(threshold)}` };
  }
  let proposed: DecisionQuestion | undefined;
  if (proposal.question !== undefined) {
    const named = (proposal.question as { decision?: unknown } | null)?.decision;
    if (named !== decision) {
      return { ok: false, reason: `the proposed question is for "${String(named)}", not "${decision}"` };
    }
    const validated = validateProposedQuestion(proposal.question, decision);
    if (!validated.ok) return { ok: false, reason: "the proposed question is not a valid question file", issues: validated.issues };
    proposed = validated.question;
  }

  const envelopes: DecisionEnvelope[] = [];
  const unreadable: { envelope: string; reason: string }[] = [];
  for (const id of listEnvelopes(root)) {
    const read = readEnvelope(root, id);
    if (!read.ok) unreadable.push({ envelope: id, reason: read.reason });
    else if (read.envelope.decision === decision) envelopes.push(read.envelope);
  }
  const current = confidenceThreshold(workflowPackage, decision);
  const base = {
    decision,
    envelopes: envelopes.length,
    ...(proposed === undefined ? {} : { question: { version: proposed.version, status: proposed.status } }),
    threshold: threshold ?? current,
  };
  const empty = {
    replayed: 0,
    changed: 0,
    unchanged: 0,
    directions: [],
    routeChanges: [],
    reasonChanges: [],
    byKind: {},
    byReasonCode: {},
    changes: [],
    failed: [],
    unreadable,
  };
  if (envelopes.length === 0) {
    return { ok: true, report: { ...base, ...empty, nothingToReplay: `there are no stored ${decision} envelopes, so there is nothing to replay` } };
  }
  if (proposed !== undefined && dependencies.apiKey.status === "missing") return { ok: false, askHuman: dependencies.apiKey.askHuman };

  const replayed: Replayed[] = [];
  const failed: { envelope: string; error: string }[] = [];
  for (const envelope of envelopes) {
    const from = { answer: envelope.answer.choice, route: envelope.route };
    let to: ReplayChange["to"];
    if (proposed === undefined) {
      // A threshold alone: the stored answer, re-routed. Unaccepted wording still goes to the developer.
      const accepted = envelope.request.question.status === "accepted";
      to = {
        answer: envelope.answer.choice,
        reasonCode: envelope.answer.reasonCode,
        ...(envelope.answer.confidence === undefined ? {} : { confidence: envelope.answer.confidence }),
        route: accepted ? routeUnder(declaration.authority, envelope.answer.confidence, base.threshold) : "ask-human",
      };
    } else {
      // Asked once per envelope; a failure is reported, never retried into a fallback.
      // model-selection's choices are the stage's options, built per call: keep the ones the envelope was asked with.
      const question = CHOICES_PER_CALL.has(decision) ? { ...proposed, answers: envelope.request.question.answers } : proposed;
      const result = await askJev(
        { question, evidence: envelope.request.packet, frame: envelope.request.frame },
        jevClientOptions(root, dependencies),
      );
      if (result.kind === "needs-configuration") return { ok: false, askHuman: result.askHuman };
      if (result.kind === "failed") {
        failed.push({ envelope: envelope.id, error: result.failure.error });
        continue;
      }
      const { summary } = result;
      const routedBy = threshold ?? envelope.policy.thresholds["confidence"] ?? current;
      to = {
        answer: summary.answer,
        reasonCode: summary.reasonCode,
        ...(summary.confidence === undefined ? {} : { confidence: summary.confidence }),
        route: routeUnder(declaration.authority, summary.confidence, routedBy),
      };
    }
    const differs = from.answer !== to.answer || from.route !== to.route;
    replayed.push({
      envelope,
      reasonCode: to.reasonCode,
      ...(differs ? { change: { envelope: envelope.id, kind: kindOf(envelope), reasonCode: envelope.answer.reasonCode, from, to } } : {}),
    });
  }

  const changes = changesOf(replayed);
  return {
    ok: true,
    report: {
      ...base,
      ...(replayed.length === 0
        ? { nothingToReplay: `Jev could not be asked about any of the ${envelopes.length} ${decision} envelopes` }
        : {}),
      replayed: replayed.length,
      changed: changes.length,
      unchanged: replayed.length - changes.length,
      directions: tallyOf(replayed).directions,
      routeChanges: countDirections(
        changes.filter((change) => change.from.route !== change.to.route).map((change) => [change.from.route, change.to.route]),
      ),
      reasonChanges: countDirections(
        replayed
          .filter((entry) => entry.envelope.answer.reasonCode !== entry.reasonCode)
          .map((entry) => [entry.envelope.answer.reasonCode, entry.reasonCode]),
      ),
      byKind: groupBy(replayed, (entry) => kindOf(entry.envelope)),
      byReasonCode: groupBy(replayed, (entry) => entry.envelope.answer.reasonCode),
      changes,
      failed,
      unreadable,
    },
  };
}
