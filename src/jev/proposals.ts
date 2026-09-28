import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readLessons } from "../actions/learn.js";
import { refuse, type Refusal } from "../actions/refusal.js";
import { hasText, isOneOf } from "../validation.js";
import { setJsonValue } from "../workflow/json-edit.js";
import {
  PACKAGE_FILE,
  readQuestionFileIn,
  SHIPPED_PACKAGE_DIRECTORY,
  validateProposedQuestion,
  validateWorkflowPackage,
  type ProposedQuestion,
} from "../workflow/package.js";
import { confidenceThreshold, thresholdKeyFor } from "../workflow/policy.js";
import { DECISION_AUTHORITIES, type DecisionAuthority } from "../workflow/types.js";
import { loadDecisionQuestion } from "./client.js";
import type { DecisionDependencies } from "./decisions.js";
import { readObservations, type HarnessObservation } from "./observations.js";
import { replayDecision, type ReplayProposal, type ReplayReport } from "./replay.js";
import { ensureLocalDirectory } from "./traces.js";

/**
 * Question-file proposals (issue #30, D35, D39, D44, D45, D46): jflow's way
 * of improving a Jev question or policy file from what it observed about
 * itself. A proposal names one decision and one change, a question wording,
 * a confidence threshold (for the whole decision, or for one kind of place
 * it is asked, which is how `escalate` and `classify` are split by kind), or
 * the decision's authority. It links the harness observations that
 * motivated it and any retained project lessons, and carries a replay
 * report over the stored envelopes.
 *
 * The gate:
 * - Drafting writes the proposal and nothing else. Until the developer
 *   decides, and after a rejection, no question or policy file changes.
 * - Only `acceptProposal` writes the package, only with the developer's
 *   words, only with a replay report that replayed something, and only
 *   while the decision is still at the version the proposal was replayed
 *   against. The acceptance is recorded before any file is written.
 * - Acceptance bumps the decision's one version, in its question file and
 *   its declaration together, whatever the change, so an envelope's
 *   question version says which regime answered it.
 * - A proposal needs at least one observation: a project lesson can only
 *   contribute to one, never change a file by itself (D35).
 *
 * Proposals are kept locally under `.jflow/proposals/`, beside the
 * envelopes and traces they reference. What an accepted proposal changed is
 * carried by the package files themselves: the new version, the question's
 * acceptance note or the basis naming the proposal.
 */

export const PROPOSAL_DIRECTORY = ".jflow/proposals";

export type ProposedChange =
  | { readonly kind: "question"; readonly question: unknown }
  | { readonly kind: "threshold"; readonly threshold: number; readonly for?: string }
  | { readonly kind: "authority"; readonly authority: DecisionAuthority };

export interface ProposalDraft {
  readonly decision: string;
  readonly change: ProposedChange;
  /** The harness observations that motivated it, by id; at least one. */
  readonly observations: readonly string[];
  /** Retained project lessons that contribute to it, by id. */
  readonly lessons?: readonly string[];
  readonly rationale: string;
}

/** The change as recorded: a proposed question is kept as it was validated. */
export type RecordedChange =
  | { readonly kind: "question"; readonly question: ProposedQuestion }
  | { readonly kind: "threshold"; readonly threshold: number; readonly for?: string }
  | { readonly kind: "authority"; readonly authority: DecisionAuthority };

export interface ProposalOutcome {
  readonly outcome: "accepted" | "rejected";
  readonly by: "developer";
  /** The developer's words. */
  readonly note: string;
  readonly decidedAt: string;
  /** The decision's version after an accepted change. */
  readonly version?: number;
  /** Package files an accepted change wrote, relative to the package directory. */
  readonly files?: readonly string[];
}

export interface Proposal {
  readonly id: string;
  readonly decision: string;
  readonly change: RecordedChange;
  readonly rationale: string;
  /** The linked observations as they read when the proposal was drafted, so the record outlives a trace cleanup. */
  readonly observations: readonly HarnessObservation[];
  readonly lessons: readonly { readonly id: string; readonly statement: string; readonly scope: string }[];
  /** What the decision stood at when the proposal was drafted; acceptance refuses once it has moved. */
  readonly base: { readonly version: number; readonly threshold: number; readonly authority: DecisionAuthority };
  readonly replay?: ReplayReport;
  /** Why there is no replay report yet. */
  readonly replayUnavailable?: string;
  readonly proposedAt: string;
  readonly status: "pending" | "accepted" | "rejected";
  readonly outcome?: ProposalOutcome;
}

export type ProposalResult =
  | { readonly ok: true; readonly outcome: { readonly proposal: Proposal; readonly askHuman?: string } }
  | Refusal;

export interface ProposalDependencies extends DecisionDependencies {
  /** The package directory acceptance writes; defaults to the shipped package. */
  readonly packageDirectory?: string;
}

function proposalPath(root: string, id: string): string {
  return join(root, PROPOSAL_DIRECTORY, `${id}.json`);
}

/** Writes a whole file through a temporary one, so a reader never sees half of it. */
function replaceFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function writeProposal(root: string, proposal: Proposal): void {
  ensureLocalDirectory(root, PROPOSAL_DIRECTORY);
  replaceFile(proposalPath(root, proposal.id), `${JSON.stringify(proposal, null, 2)}\n`);
}

function proposalIds(root: string): string[] {
  const directory = join(root, PROPOSAL_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((file) => /^(P-(\d+))\.json$/.exec(file))
    .filter((match) => match !== null)
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map((match) => match[1]!);
}

export function readProposal(root: string, id: string): { readonly ok: true; readonly proposal: Proposal } | Refusal {
  if (!/^P-\d+$/.test(id)) return refuse(`"${id}" is not a proposal id`);
  const path = proposalPath(root, id);
  if (!existsSync(path)) return refuse(`no proposal "${id}" under ${PROPOSAL_DIRECTORY}`);
  try {
    const proposal = JSON.parse(readFileSync(path, "utf8")) as Proposal;
    if (proposal.id !== id || typeof proposal.status !== "string") return refuse(`proposal "${id}" is not a readable proposal`);
    return { ok: true, proposal };
  } catch (error) {
    return refuse(`proposal "${id}" cannot be read: ${(error as Error).message}`);
  }
}

export function listProposals(
  root: string,
): { readonly ok: true; readonly proposals: readonly Pick<Proposal, "id" | "decision" | "change" | "status" | "proposedAt">[] } | Refusal {
  const proposals = [];
  for (const id of proposalIds(root)) {
    const read = readProposal(root, id);
    if (!read.ok) return read;
    const { decision, change, status, proposedAt } = read.proposal;
    proposals.push({ id, decision, change, status, proposedAt });
  }
  return { ok: true, proposals };
}

function replayInputOf(change: RecordedChange): ReplayProposal {
  switch (change.kind) {
    case "question":
      return { question: change.question };
    case "threshold":
      return { threshold: change.threshold, ...(change.for === undefined ? {} : { kind: change.for }) };
    case "authority":
      return { authority: change.authority };
  }
}

/** Runs the replay a proposal is accepted on; `unavailable` when it could not run. */
async function replayOf(
  root: string,
  decision: string,
  change: RecordedChange,
  dependencies: DecisionDependencies,
): Promise<{ readonly report: ReplayReport } | { readonly unavailable: string; readonly askHuman?: string } | Refusal> {
  const result = await replayDecision(root, decision, replayInputOf(change), dependencies);
  if (result.ok) return { report: result.report };
  if ("askHuman" in result) return { unavailable: result.askHuman, askHuman: result.askHuman };
  return refuse(result.reason, result.issues);
}

/** Checks a drafted change against the decision as it stands, and returns it as it is recorded. */
function recordedChange(draft: ProposalDraft, dependencies: DecisionDependencies): { readonly ok: true; readonly change: RecordedChange } | Refusal {
  const { workflowPackage } = dependencies.context;
  const { decision, change } = draft;
  const declaration = workflowPackage.decisions[decision]!;
  switch (change?.kind) {
    case "question": {
      const validated = validateProposedQuestion(change.question, decision);
      if (!validated.ok) return refuse("the proposed question is not a valid question file", validated.issues);
      // The answers are the vocabulary the workflow acts on; wording may change, the choices may not.
      const current = loadDecisionQuestion(workflowPackage, decision);
      if (JSON.stringify(validated.question.answers) !== JSON.stringify(current.answers)) {
        return refuse(`a proposed wording keeps the ${decision} answers as they are (${current.answers.join(", ")}); the workflow acts on them`);
      }
      if (
        validated.question.prompt === current.prompt &&
        JSON.stringify(validated.question.reasons) === JSON.stringify(current.reasons) &&
        JSON.stringify(validated.question.descriptions ?? {}) === JSON.stringify(current.descriptions ?? {})
      ) {
        return refuse(`the proposed ${decision} question is the current one`);
      }
      // Recorded as proposed wording: it is accepted only by `acceptProposal`, and replay routes it as if accepted.
      return { ok: true, change: { kind: "question", question: { ...validated.question, status: "proposed" } } };
    }
    case "threshold": {
      if (typeof change.threshold !== "number" || !(change.threshold >= 0 && change.threshold <= 1)) {
        return refuse(`a proposed threshold is a number from 0 to 1, not ${String(change.threshold)}`);
      }
      if (change.for !== undefined && typeof change.for !== "string") return refuse("a threshold's for names one kind, as a string");
      // A kind is checked by replay; here only whether anything would change.
      const current = workflowPackage.policy[decision]!.thresholds[thresholdKeyFor(change.for)];
      if (current === change.threshold) return refuse(`the ${decision} threshold${change.for === undefined ? "" : ` for ${change.for}`} is already that`);
      return { ok: true, change: { kind: "threshold", threshold: change.threshold, ...(change.for === undefined ? {} : { for: change.for }) } };
    }
    case "authority": {
      if (!isOneOf(DECISION_AUTHORITIES, change.authority)) {
        return refuse(`a proposed authority is ${DECISION_AUTHORITIES.join(" or ")}, not ${String(change.authority)}`);
      }
      if (change.authority === declaration.authority) return refuse(`${decision} is already ${declaration.authority}`);
      return { ok: true, change: { kind: "authority", authority: change.authority } };
    }
    default:
      return refuse("a proposal names one change: a question, a threshold or an authority");
  }
}

/**
 * Drafts a proposal and replays it against the stored envelopes before the
 * developer sees it. Writes the proposal only; with no Jev key for a
 * wording's replay it is recorded without a report, to be replayed later.
 */
export async function draftProposal(root: string, draft: ProposalDraft, dependencies: ProposalDependencies): Promise<ProposalResult> {
  // The draft arrives as a JSON file the agent wrote; read it defensively.
  const { workflowPackage } = dependencies.context;
  const decision = draft?.decision;
  if (typeof decision !== "string" || workflowPackage.decisions[decision] === undefined) {
    return refuse(`"${String(decision)}" is not a declared decision; declared decisions are ${Object.keys(workflowPackage.decisions).join(", ")}`);
  }
  if (!hasText(draft.rationale)) return refuse("a proposal needs a rationale: why the change, from what was observed");
  const changed = recordedChange(draft, dependencies);
  if (!changed.ok) return changed;

  const linked = Array.isArray(draft.observations) ? draft.observations.filter((id) => typeof id === "string") : [];
  if (linked.length === 0) {
    return refuse("a proposal rests on at least one harness observation; a project lesson can only contribute to one");
  }
  const view = readObservations(root, dependencies.context);
  const observations: HarnessObservation[] = [];
  for (const id of new Set(linked)) {
    const observation = view.observations.find((candidate) => candidate.id === id);
    if (observation === undefined) return refuse(`"${id}" is not a current harness observation`);
    if (observation.decision !== undefined && observation.decision !== decision) {
      return refuse(`observation ${id} is about ${observation.decision}, not ${decision}`);
    }
    observations.push(observation);
  }
  // A fix-limit or unattributed failure may support a proposal, but cannot be all it rests on.
  if (!observations.some((observation) => observation.decision === decision)) {
    return refuse(`a proposal for ${decision} rests on at least one observation of ${decision}`);
  }

  const lessonIds = Array.isArray(draft.lessons) ? draft.lessons.filter((id) => typeof id === "string") : [];
  const lessons: Proposal["lessons"][number][] = [];
  if (lessonIds.length > 0) {
    const read = readLessons(root);
    if (!read.ok) return read;
    for (const id of new Set(lessonIds)) {
      const lesson = read.lessons.lessons.find((candidate) => candidate.id === id);
      if (lesson === undefined) return refuse(`there is no lesson "${id}"`);
      if (lesson.status !== "active") return refuse(`lesson ${id} is ${lesson.status}, not retained; only a retained lesson contributes`);
      lessons.push({ id, statement: lesson.statement, scope: lesson.scope });
    }
  }

  const replayed = await replayOf(root, decision, changed.change, dependencies);
  if ("ok" in replayed) return replayed;

  const declaration = workflowPackage.decisions[decision]!;
  const kind = changed.change.kind === "threshold" ? changed.change.for : undefined;
  const ids = proposalIds(root);
  const last = ids.length === 0 ? 0 : Number(ids[ids.length - 1]!.slice(2));
  const proposal: Proposal = {
    id: `P-${last + 1}`,
    decision,
    change: changed.change,
    rationale: draft.rationale.trim(),
    observations,
    lessons,
    base: { version: declaration.version, threshold: confidenceThreshold(workflowPackage, decision, kind), authority: declaration.authority },
    ...("report" in replayed ? { replay: replayed.report } : { replayUnavailable: replayed.unavailable }),
    proposedAt: dependencies.now(),
    status: "pending",
  };
  writeProposal(root, proposal);
  return { ok: true, outcome: { proposal, ...("askHuman" in replayed && replayed.askHuman !== undefined ? { askHuman: replayed.askHuman } : {}) } };
}

function pending(root: string, id: string): { readonly ok: true; readonly proposal: Proposal } | Refusal {
  const read = readProposal(root, id);
  if (!read.ok) return read;
  if (read.proposal.status !== "pending") return refuse(`proposal ${id} is already ${read.proposal.status}`);
  return read;
}

/** Replays a pending proposal again, for one recorded without a report or over envelopes stored since. */
export async function replayProposal(root: string, id: string, dependencies: ProposalDependencies): Promise<ProposalResult> {
  const read = pending(root, id);
  if (!read.ok) return read;
  const { proposal } = read;
  const replayed = await replayOf(root, proposal.decision, proposal.change, dependencies);
  if ("ok" in replayed) return replayed;
  if (!("report" in replayed)) return { ok: true, outcome: { proposal, ...(replayed.askHuman === undefined ? {} : { askHuman: replayed.askHuman }) } };
  const { replayUnavailable: _dropped, ...rest } = proposal;
  const updated: Proposal = { ...rest, replay: replayed.report };
  writeProposal(root, updated);
  return { ok: true, outcome: { proposal: updated } };
}

/** The sentence an accepted change adds to the basis it rests on. */
function basisNote(proposal: Proposal, note: string, now: string): string {
  const report = proposal.replay!;
  return `Changed by accepted proposal ${proposal.id} on ${now.slice(0, 10)} after replay over ${report.replayed} stored envelopes (${report.changed} changed): "${note}".`;
}

/**
 * Accepts a pending proposal in the developer's words and applies its one
 * change to the package, bumping the decision's version. Refused, with
 * nothing written, without the words, without a replay report that
 * replayed something, or once the decision has moved on since the replay.
 */
export function acceptProposal(
  root: string,
  id: string,
  input: { readonly note: string },
  dependencies: Pick<ProposalDependencies, "now" | "packageDirectory">,
): ProposalResult {
  const read = pending(root, id);
  if (!read.ok) return read;
  const { proposal } = read;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") return refuse("accepting a proposal needs the developer's words (--note)");
  const report = proposal.replay;
  if (report === undefined) {
    return refuse(`proposal ${id} has no replay report${proposal.replayUnavailable === undefined ? "" : ` (${proposal.replayUnavailable})`}; replay it before it can be accepted`);
  }
  if (report.nothingToReplay !== undefined || report.replayed === 0) {
    return refuse(`proposal ${id}'s replay replayed nothing (${report.nothingToReplay ?? "no envelope"}), so there is no shown effect to accept`);
  }

  const directory = dependencies.packageDirectory ?? SHIPPED_PACKAGE_DIRECTORY;
  const packageText = readFileSync(join(directory, PACKAGE_FILE), "utf8");
  const document = JSON.parse(packageText) as {
    decisions?: Record<string, { question?: string; version?: number; authority?: string; basis?: string }>;
    policy?: Record<string, { thresholds?: Record<string, number>; basis?: string }>;
  };
  const declared = document.decisions?.[proposal.decision];
  if (declared?.question === undefined || declared.version !== proposal.base.version) {
    return refuse(
      `${proposal.decision} is at version ${String(declared?.version)} now, not the version ${proposal.base.version} proposal ${id} was replayed against; draft it again`,
    );
  }
  // A hand edit that skipped this gate leaves the version alone; the replay no longer shows the effect either way.
  const kind = proposal.change.kind === "threshold" ? proposal.change.for : undefined;
  const thresholds = document.policy?.[proposal.decision]?.thresholds ?? {};
  const threshold = thresholds[thresholdKeyFor(kind)] ?? thresholds[thresholdKeyFor()];
  if (threshold !== proposal.base.threshold || declared.authority !== proposal.base.authority) {
    return refuse(`${proposal.decision}'s threshold or authority changed since proposal ${id} was replayed; draft it again`);
  }
  const questionPath = declared.question;
  const questionText = readQuestionFileIn(directory, questionPath);
  if (questionText === undefined) return refuse(`the ${proposal.decision} question file "${questionPath}" cannot be read`);

  const now = dependencies.now();
  const version = proposal.base.version + 1;
  const { change, decision } = proposal;
  let nextQuestion = setJsonValue(questionText, ["version"], version);
  let nextPackage = setJsonValue(packageText, ["decisions", decision, "version"], version);
  switch (change.kind) {
    case "question": {
      const current = JSON.parse(questionText) as Record<string, unknown>;
      const accepted = {
        decision,
        version,
        status: "accepted",
        ...(current["ownedBy"] === undefined ? {} : { ownedBy: current["ownedBy"] }),
        prompt: change.question.prompt,
        answers: change.question.answers,
        reasons: change.question.reasons,
        ...(change.question.descriptions === undefined ? {} : { descriptions: change.question.descriptions }),
        acceptance: { acceptedAt: now, note: `${note} (developer, accepting proposal ${id} for ${decision})` },
      };
      nextQuestion = `${JSON.stringify(accepted, null, 2)}\n`;
      break;
    }
    case "threshold": {
      nextPackage = setJsonValue(nextPackage, ["policy", decision, "thresholds", thresholdKeyFor(change.for)], change.threshold);
      const basis = document.policy?.[decision]?.basis ?? "";
      nextPackage = setJsonValue(nextPackage, ["policy", decision, "basis"], `${basis} ${basisNote(proposal, note, now)}`.trim());
      break;
    }
    case "authority": {
      nextPackage = setJsonValue(nextPackage, ["decisions", decision, "authority"], change.authority);
      nextPackage = setJsonValue(nextPackage, ["decisions", decision, "basis"], `${declared.basis ?? ""} ${basisNote(proposal, note, now)}`.trim());
      break;
    }
  }

  // The changed package must still be one jflow can load, or nothing is written.
  const validated = validateWorkflowPackage(JSON.parse(nextPackage), {
    readQuestionFile: (path) => (path === questionPath ? nextQuestion : readQuestionFileIn(directory, path)),
  });
  if (!validated.ok) return refuse(`accepting proposal ${id} would leave the package invalid; nothing was changed`, validated.issues);

  const accepted: Proposal = {
    ...proposal,
    status: "accepted",
    outcome: { outcome: "accepted", by: "developer", note, decidedAt: now, version, files: [questionPath, PACKAGE_FILE] },
  };
  // The acceptance is on record before any file changes.
  writeProposal(root, accepted);
  replaceFile(join(directory, questionPath), nextQuestion);
  replaceFile(join(directory, PACKAGE_FILE), nextPackage);
  return { ok: true, outcome: { proposal: accepted } };
}

/** Rejects a pending proposal in the developer's words; nothing else changes. */
export function rejectProposal(root: string, id: string, input: { readonly note: string }, options: { readonly now: string }): ProposalResult {
  const read = pending(root, id);
  if (!read.ok) return read;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") return refuse("rejecting a proposal needs the developer's words (--note)");
  const rejected: Proposal = {
    ...read.proposal,
    status: "rejected",
    outcome: { outcome: "rejected", by: "developer", note, decidedAt: options.now },
  };
  writeProposal(root, rejected);
  return { ok: true, outcome: { proposal: rejected } };
}
