import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runNext, type NextReport } from "../actions/next.js";
import { resolveAction, type ResolutionContext } from "../actions/resolve.js";
import type { JevApiKeyResult } from "../config/configuration.js";
import { readProjectState } from "../project/state.js";
import { routeByConfidence } from "../workflow/policy.js";
import type { DecisionAuthority, WorkflowPackage } from "../workflow/types.js";
import {
  askJev,
  jevRequestBody,
  loadDecisionQuestion,
  REQUEST_FRAME,
  type DecisionQuestion,
  type JevClientOptions,
  type JevFailure,
  type JevTransport,
  type RequestFrame,
} from "./client.js";
import { recordFailure, recordRecovery } from "./fallback.js";
import { buildEvidencePacket, sharingLimitsFrom, type EvidenceExcerpt, type EvidencePacket } from "./evidence.js";
import { kindOfPacket } from "./kinds.js";
import { ensureLocalDirectory } from "./traces.js";

/**
 * The decision runtime (issue #17, D6, D7, D36, D43): a declared decision is
 * asked by name, every answer is recorded as a decision envelope before
 * anything uses it, and the envelope's route says what the answer may do.
 *
 * - `act`: a binding decision's confident answer to accepted wording; the
 *   workflow acts on it, and only a recorded evidence-based reason gets past.
 * - `weigh`: an advisory decision's confident answer to accepted wording; the
 *   primary agent weighs it and may set it aside with such a reason.
 * - `ask-human`: the answer is recorded but not relied on, because its
 *   confidence is below the declared threshold or its wording is not yet
 *   accepted (D37); the developer decides.
 *
 * Hard rules sit outside this module on purpose: prerequisite and
 * authorization checks never read an envelope, nothing here writes a project
 * record, and consequential conflicts go to the developer through
 * `actions/conflicts.ts` without a Jev call. A chosen action outside what the
 * workflow permits is refused whatever Jev answered.
 *
 * Envelopes are kept locally under `.jflow/envelopes/`, beside the traces but
 * not cleaned with them: they hold the evidence packet, which the portable
 * project records never carry (D23), and they are the corpus replay reads
 * (D36, D46).
 */

export const ENVELOPE_DIRECTORY = ".jflow/envelopes";

export type DecisionRoute = "act" | "weigh" | "ask-human";

/**
 * Who made the recorded choice: the helper applying a binding answer, the
 * primary agent, or the developer. An agent's override needs evidence (D6);
 * the developer's recorded words are their own authority.
 */
export const CHOICE_MAKERS = ["workflow", "agent", "developer"] as const;

export type ChoiceMaker = (typeof CHOICE_MAKERS)[number];

export interface DecisionChoice {
  /** The chosen action, in the decision's own answer vocabulary. */
  readonly action: string;
  readonly by: ChoiceMaker;
  readonly followsAnswer: boolean;
  /** Why Jev's answer was set aside, or the developer's words. */
  readonly reason?: string;
  /** What the reason rests on: commands, files, records (D6). */
  readonly evidence?: readonly string[];
  readonly chosenAt: string;
}

export interface DecisionEnvelope {
  readonly id: string;
  readonly decision: string;
  readonly authority: DecisionAuthority;
  readonly askedAt: string;
  /** Everything the request was built from; `rebuildJevRequest` turns it back into the exact body. */
  readonly request: {
    readonly frame: RequestFrame;
    readonly question: DecisionQuestion;
    readonly packet: EvidencePacket;
  };
  /** The policy entry the answer was routed by; `version` is a digest of it, as the package carries no policy version. */
  readonly policy: { readonly version: string; readonly thresholds: Readonly<Record<string, number>> };
  readonly answer: {
    readonly choice: string;
    readonly reasonCode: string;
    readonly confidence?: number;
    readonly model: string;
    readonly traceReference: string;
  };
  readonly route: DecisionRoute;
  readonly routeReason: string;
  /** Absent until the chosen action is recorded. */
  readonly choice?: DecisionChoice;
}

export interface DecisionDependencies {
  readonly context: ResolutionContext;
  readonly apiKey: JevApiKeyResult;
  readonly transport: JevTransport;
  readonly now: () => string;
  /** Loads a declared decision's question; defaults to the shipped question file. */
  readonly readQuestion?: (decision: string) => DecisionQuestion;
  /** Waits between retries; defaults to a real timer. Injected by tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The stage asking, for a fallback approved for one stage (issue #18). */
  readonly stage?: string;
}

/** The first retry waits this long; each later one twice as long as the one before. */
const RETRY_BACKOFF_MS = 1000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What one decision is asked over; the packet is bounded from it (D22). */
export interface DecisionInput {
  readonly taskSummary: string;
  readonly candidates: readonly string[];
  readonly excerpts: readonly EvidenceExcerpt[];
}

export type AskDecisionResult =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "needs-configuration"; readonly askHuman: string; readonly mayProceedWithoutJev: false }
  | {
      readonly kind: "failed";
      readonly failure: JevFailure;
      /** Calls made, the first included; a failure that is not temporary is never retried. */
      readonly attempts: number;
      /**
       * `approved`: the developer approved continuing without Jev here, so the
       * agent's own assessment decides (`jev assess`). `awaiting-approval`: the
       * developer is asked first.
       */
      readonly fallback: "approved" | "awaiting-approval";
    }
  | { readonly kind: "answered"; readonly envelope: DecisionEnvelope };

/**
 * Jev answered with something that is not one of the choices it was given,
 * and the caller rejects that rather than treat it as a failure (issue
 * #28). Nothing is recorded as a Jev outage.
 */
export interface UnlistedAnswer {
  readonly kind: "unlisted";
  readonly answer: string;
  readonly traceReference: string;
}

/**
 * Routes an answer by its question's acceptance, its confidence and the
 * decision's authority. `kind` is where it was asked, for a threshold
 * declared for that kind alone (issue #30).
 */
export function routeAnswer(
  workflowPackage: WorkflowPackage,
  question: DecisionQuestion,
  answer: { readonly confidence?: number },
  kind?: string,
): { readonly route: DecisionRoute; readonly reason: string } {
  if (question.status !== "accepted") {
    return {
      route: "ask-human",
      reason: `the ${question.decision} question's wording is ${question.status}, not accepted, so its answer is recorded but not relied on`,
    };
  }
  if (answer.confidence === undefined || routeByConfidence(workflowPackage, question.decision, answer.confidence, kind) === "ask-human") {
    return {
      route: "ask-human",
      reason: `the answer's confidence is below the ${question.decision} threshold, so the developer decides`,
    };
  }
  return workflowPackage.decisions[question.decision]?.authority === "binding"
    ? { route: "act", reason: "binding decision answered with confidence at or above its threshold; the workflow acts on it" }
    : { route: "weigh", reason: "advisory decision answered with confidence at or above its threshold; weigh it with your own evidence" };
}

function envelopePath(root: string, id: string): string {
  return join(root, ENVELOPE_DIRECTORY, `${id}.json`);
}

function writeEnvelope(root: string, envelope: DecisionEnvelope): void {
  ensureLocalDirectory(root, ENVELOPE_DIRECTORY);
  const path = envelopePath(root, envelope.id);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Envelope ids on disk, oldest first. */
export function listEnvelopes(root: string): string[] {
  const directory = join(root, ENVELOPE_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => file.slice(0, -".json".length));
}

export type EnvelopeRead =
  | { readonly ok: true; readonly envelope: DecisionEnvelope }
  | { readonly ok: false; readonly reason: string };

export function readEnvelope(root: string, id: string): EnvelopeRead {
  if (!/^ENV-[A-Za-z0-9-]+$/.test(id)) return { ok: false, reason: `"${id}" is not an envelope id` };
  const path = envelopePath(root, id);
  if (!existsSync(path)) return { ok: false, reason: `no decision envelope "${id}" under ${ENVELOPE_DIRECTORY}` };
  try {
    const envelope = JSON.parse(readFileSync(path, "utf8")) as DecisionEnvelope;
    if (envelope.id !== id || typeof envelope.answer?.choice !== "string") {
      return { ok: false, reason: `decision envelope "${id}" is not a readable envelope` };
    }
    return { ok: true, envelope };
  } catch (error) {
    return { ok: false, reason: `decision envelope "${id}" cannot be read: ${(error as Error).message}` };
  }
}

/** The exact request body the envelope's answer came from, without chat history or a live call (D36). */
export function rebuildJevRequest(envelope: DecisionEnvelope): string {
  return jevRequestBody(envelope.request.question, envelope.request.packet, envelope.request.frame);
}

function policyVersion(entry: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 16)}`;
}

function questionLoader(dependencies: DecisionDependencies): (decision: string) => DecisionQuestion {
  return dependencies.readQuestion ?? ((name) => loadDecisionQuestion(dependencies.context.workflowPackage, name));
}

/** How one Jev call is made from the configuration: key, transport, timeout and clock. */
export function jevClientOptions(root: string, dependencies: DecisionDependencies): JevClientOptions {
  const timeoutMs = dependencies.context.configuration.settings["jev.timeoutMs"];
  return {
    root,
    apiKey: dependencies.apiKey,
    transport: dependencies.transport,
    timeoutMs: typeof timeoutMs === "number" ? timeoutMs : 30000,
    now: dependencies.now,
  };
}

export async function askDecision(
  root: string,
  decision: string,
  input: DecisionInput,
  dependencies: DecisionDependencies,
): Promise<AskDecisionResult> {
  const result = await ask(root, decision, input, dependencies, false);
  if (result.kind === "unlisted") throw new Error("an unlisted answer is only returned when asked for");
  return result;
}

/**
 * `askDecision` for a decision whose choices are built per call (issue
 * #28): an answer outside them comes back as `unlisted` for the caller to
 * reject and record, instead of setting the Jev fallback.
 */
export async function askDecisionRejectingUnlisted(
  root: string,
  decision: string,
  input: DecisionInput,
  dependencies: DecisionDependencies,
): Promise<AskDecisionResult | UnlistedAnswer> {
  return ask(root, decision, input, dependencies, true);
}

async function ask(
  root: string,
  decision: string,
  input: DecisionInput,
  dependencies: DecisionDependencies,
  rejectUnlisted: boolean,
): Promise<AskDecisionResult | UnlistedAnswer> {
  const { workflowPackage, configuration } = dependencies.context;
  const declaration = workflowPackage.decisions[decision];
  const policy = workflowPackage.policy[decision];
  if (declaration === undefined || policy === undefined) {
    const known = Object.keys(workflowPackage.decisions).join(", ");
    return { kind: "refused", reason: `"${decision}" is not a declared decision; declared decisions are ${known}` };
  }

  const question = questionLoader(dependencies)(decision);
  const knownSecrets = dependencies.apiKey.status === "configured" ? [dependencies.apiKey.key] : [];
  const packet = buildEvidencePacket({ decision, ...input }, sharingLimitsFrom(configuration), { knownSecrets });
  const retryCount = configuration.settings["jev.retryCount"];
  const retries = typeof retryCount === "number" ? retryCount : 2;
  const sleep = dependencies.sleep ?? realSleep;
  const options = jevClientOptions(root, dependencies);
  // A temporary failure is retried with growing backoff; any other failure is surfaced at once (D16).
  let result = await askJev({ question, evidence: packet }, options);
  let attempts = 1;
  while (result.kind === "failed" && result.failure.retryable && attempts <= retries) {
    await sleep(RETRY_BACKOFF_MS * 2 ** (attempts - 1));
    result = await askJev({ question, evidence: packet }, options);
    attempts += 1;
  }
  if (result.kind === "needs-configuration") return result;
  if (result.kind === "failed" && rejectUnlisted && result.failure.unlisted !== undefined) {
    return { kind: "unlisted", answer: result.failure.unlisted, traceReference: result.failure.traceReference };
  }
  if (result.kind === "failed") {
    const recorded = recordFailure(root, decision, result.failure, {
      now: dependencies.now(),
      ...(dependencies.stage === undefined ? {} : { stage: dependencies.stage }),
    });
    if (!recorded.ok) return { kind: "refused", reason: recorded.reason };
    return { kind: "failed", failure: result.failure, attempts, fallback: recorded.fallback };
  }
  const recovered = recordRecovery(root, decision, { now: dependencies.now() });
  if (!recovered.ok) return { kind: "refused", reason: recovered.reason };

  const { summary } = result;
  const routed = routeAnswer(workflowPackage, question, summary, kindOfPacket(decision, packet.taskSummary));
  const envelope: DecisionEnvelope = {
    id: `ENV-${summary.answeredAt.replace(/[^0-9]/g, "")}-${decision}-${randomBytes(3).toString("hex")}`,
    decision,
    authority: declaration.authority,
    askedAt: summary.answeredAt,
    request: { frame: REQUEST_FRAME, question, packet },
    policy: { version: policyVersion(policy), thresholds: policy.thresholds },
    answer: {
      choice: summary.answer,
      reasonCode: summary.reasonCode,
      ...(summary.confidence === undefined ? {} : { confidence: summary.confidence }),
      model: summary.model,
      traceReference: summary.traceReference,
    },
    route: routed.route,
    routeReason: routed.reason,
  };
  // Recorded before anyone reads the answer (issue #17).
  writeEnvelope(root, envelope);
  return { kind: "answered", envelope };
}

/**
 * The choices the workflow permits for a decision, worked out from the
 * records without Jev: the decision's answers, narrowed for `next-action`
 * to the actions whose prerequisites and authorization are met now.
 */
export function permittedChoices(root: string, decision: string, context: ResolutionContext): readonly string[] {
  if (context.workflowPackage.decisions[decision] === undefined) return [];
  const answers = loadDecisionQuestion(context.workflowPackage, decision).answers;
  if (decision !== "next-action") return answers;
  const read = readProjectState(root);
  if (read.kind === "malformed") return [];
  return answers.filter((action) => resolveAction({ action }, read.state, context).status === "eligible");
}

export interface ChoiceInput {
  readonly action: string;
  readonly by: ChoiceMaker;
  readonly reason?: string;
  readonly evidence?: readonly string[];
}

export type ChoiceResult =
  | { readonly ok: true; readonly envelope: DecisionEnvelope }
  | { readonly ok: false; readonly reason: string };

/**
 * Records the action chosen after an answer (D6). `permitted` comes from the
 * workflow's own checks (`permittedChoices`), never from Jev.
 */
export function recordChoice(
  root: string,
  envelopeId: string,
  choice: ChoiceInput,
  permitted: readonly string[],
  options: { readonly now: string },
): ChoiceResult {
  const read = readEnvelope(root, envelopeId);
  if (!read.ok) return read;
  const { envelope } = read;
  if (envelope.choice !== undefined) {
    return { ok: false, reason: `envelope ${envelopeId} already records the choice "${envelope.choice.action}"` };
  }
  if (!permitted.includes(choice.action)) {
    return {
      ok: false,
      reason: `"${choice.action}" is not permitted by the workflow rules or existing authority (permitted: ${permitted.join(", ") || "none"}); no answer or reason makes it so`,
    };
  }

  const reason = choice.reason?.trim() ?? "";
  const evidence = (choice.evidence ?? []).filter((entry) => entry.trim() !== "");
  const followsAnswer = choice.action === envelope.answer.choice;
  if (envelope.route === "ask-human") {
    if (choice.by !== "developer" || reason === "") {
      return {
        ok: false,
        reason: `${envelope.routeReason}; record the developer's decision in their words (by developer, with a reason)`,
      };
    }
  } else if (!followsAnswer && (reason === "" || (choice.by !== "developer" && evidence.length === 0))) {
    const answered = `Jev's ${envelope.authority} answer is "${envelope.answer.choice}"`;
    return {
      ok: false,
      reason: `${answered}; choosing "${choice.action}" instead needs an evidence-based reason: a reason and the evidence it rests on`,
    };
  }

  const chosen: DecisionEnvelope = {
    ...envelope,
    choice: {
      action: choice.action,
      by: choice.by,
      followsAnswer,
      ...(reason === "" ? {} : { reason }),
      ...(evidence.length === 0 ? {} : { evidence }),
      chosenAt: options.now,
    },
  };
  writeEnvelope(root, chosen);
  return { ok: true, envelope: chosen };
}

/** The short form of an asked decision that reports carry: a reference, never the packet. */
export type DecisionReport =
  | {
      readonly kind: "answered";
      readonly envelope: string;
      readonly answer: string;
      readonly reasonCode: string;
      readonly confidence?: number;
      readonly route: DecisionRoute;
      readonly routeReason: string;
    }
  | { readonly kind: "not-asked"; readonly reason: string }
  | Exclude<AskDecisionResult, { kind: "answered" }>;

export function reportDecision(result: AskDecisionResult): DecisionReport {
  if (result.kind !== "answered") return result;
  const { envelope } = result;
  return {
    kind: "answered",
    envelope: envelope.id,
    answer: envelope.answer.choice,
    reasonCode: envelope.answer.reasonCode,
    ...(envelope.answer.confidence === undefined ? {} : { confidence: envelope.answer.confidence }),
    route: envelope.route,
    routeReason: envelope.routeReason,
  };
}

/** The `next-action` packet: the recorded state, each action's eligibility, and the records' own recommendation. */
export function nextActionEvidence(
  report: Exclude<NextReport, { project: "malformed" }>,
  question: DecisionQuestion,
): DecisionInput {
  const { recommendation } = report;
  return {
    taskSummary:
      `Project ${report.project}. The records recommend ${recommendation.action}: ${recommendation.reason}` +
      (recommendation.needsDeveloper ? " (waits on the developer)." : "."),
    candidates: question.answers,
    excerpts: report.actions.map((action) => ({
      source: `actions/${action.name}`,
      text:
        action.status === "eligible"
          ? "eligible"
          : `blocked: ${action.unmet.map((entry) => entry.reason).join("; ")}`,
    })),
  };
}

export interface NextAdvice {
  readonly report: NextReport;
  readonly jev: DecisionReport;
}

/**
 * `next` with Jev's advisory `next-action` answer beside the records' own
 * recommendation. Grants nothing: it reads the records and writes only the
 * local trace and envelope.
 */
export async function adviseNext(root: string, dependencies: DecisionDependencies): Promise<NextAdvice> {
  const report = runNext(root, dependencies.context);
  if (report.project === "malformed") {
    return { report, jev: { kind: "not-asked", reason: `the record at ${report.path} cannot be read` } };
  }
  const question = questionLoader(dependencies)("next-action");
  const result = await askDecision(root, "next-action", nextActionEvidence(report, question), dependencies);
  return { report, jev: reportDecision(result) };
}

export interface ProposedAssignment {
  readonly role: string;
  readonly task: string;
  /** Files or areas the assignment touches. */
  readonly covers: readonly string[];
}

/** The `assignment` packet: the unit of work and each proposed assignment. */
export function assignmentEvidence(input: {
  readonly unit: string;
  readonly assignments: readonly ProposedAssignment[];
}): DecisionInput {
  return {
    taskSummary: input.unit,
    candidates: [],
    excerpts: input.assignments.map((assignment, index) => ({
      source: `assignments[${index}]`,
      text: `role: ${assignment.role}\ntask: ${assignment.task}\ncovers: ${assignment.covers.join(", ")}`,
    })),
  };
}

/** The `lesson-retention` packet: the candidate lesson, its evidence, and what it touches. */
export function lessonRetentionEvidence(input: {
  readonly statement: string;
  readonly scope: string;
  readonly evidence: readonly { readonly kind: string; readonly reference: string }[];
  /** Retained lessons or accepted decisions the candidate touches. */
  readonly related?: readonly string[];
}): DecisionInput {
  return {
    taskSummary: `Candidate lesson: ${input.statement}`,
    candidates: [],
    excerpts: [
      { source: "lesson/scope", text: input.scope },
      ...input.evidence.map((entry, index) => ({
        source: `lesson/evidence[${index}]`,
        text: `${entry.kind}: ${entry.reference}`,
      })),
      ...(input.related ?? []).map((text, index) => ({ source: `lesson/related[${index}]`, text })),
    ],
  };
}
