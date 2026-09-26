import type { DecisionDependencies } from "../jev/decisions.js";
import { askEscalation, humanAskAt, type EscalationAsk } from "../jev/escalation.js";
import {
  judgeTicket,
  refuseInvalidEvidence,
  saveValidation,
  type TicketValidationResult,
  type ValidationInput,
} from "../jev/ticket-validation.js";
import {
  readRecord,
  validateRecord,
  writeRecord,
  type AuthorizationScope,
  type PlanRecord,
  type ProgressRecord,
  type ReconciliationDiscrepancy,
  type ResumeDiscrepancy,
  type ResumeRecord,
  type SettledDiscrepancy,
  type TicketRecord,
} from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { readWorkingTree } from "../project/worktree.js";
import { hasText } from "../validation.js";
import { readRecordedEvidence, recordEvidence } from "./implement.js";
import { runNext } from "./next.js";
import { recommendRealign } from "./realign.js";
import { refuse, unreadable, unreadableState, type Refusal } from "./refusal.js";
import type { ResolutionContext } from "./resolve.js";
import { findRecordDiscrepancies } from "./wrap.js";

/**
 * The helper's part of resuming in a fresh conversation (issue #22, D15,
 * D42, D44): the saved progress is reconciled with the project files and
 * the verification evidence before work continues.
 *
 * - `readResume` reads the resume record, if `wrap` left one, beside the
 *   records and the working tree, and writes nothing. It limits itself to
 *   the affected work: the assigned ticket, completion claims without
 *   verification evidence, and tickets a discrepancy names. The assigned
 *   ticket continues from its own uncommitted edits; nothing is restarted,
 *   and changes that appeared since wrap are not handed to it.
 * - Authorization comes from the progress record alone, never from the
 *   resume record or the conversation. One-ticket authorization for a
 *   ticket no longer being worked on does not carry over.
 * - `verifyTicket` judges a done ticket on checks run now, through
 *   `validate`. It records the validation and the evidence and never
 *   changes the ticket's status. `reconcileResume` refuses until every
 *   completion claim has been verified this way: an unverified claim is
 *   checked, never escalated away.
 * - `reconcileResume` asks `escalate` at `resume-discrepancy` for each
 *   discrepancy, with its evidence. One that changes agreed scope is a
 *   consequential conflict: the developer is asked without Jev, and one
 *   `realign` recommendation is recorded that starts nothing. A
 *   discrepancy already waiting on the developer is put to them again
 *   without asking Jev; one they settled (`settleDiscrepancies`) is not
 *   raised again.
 * - Only the progress record's `reconciliation` is written; no ticket,
 *   edit, fix counter or authorization changes.
 */

export interface UnverifiedTicket {
  readonly ticketId: string;
  /** The checks recorded for it, if any; otherwise the ticket's own test commands. */
  readonly checks: readonly string[];
}

export interface Recommendation {
  readonly action: string;
  readonly reason: string;
}

export interface ResumeReport {
  /** What `wrap` left; absent when the last session did not wrap. */
  readonly resume?: ResumeRecord;
  readonly authorization: {
    readonly executionAuthorized: boolean;
    readonly scope?: AuthorizationScope;
    readonly note?: string;
    readonly assignedTicketId?: string;
    /** Nothing may be implemented until the developer authorizes it. */
    readonly needsDeveloper: boolean;
  };
  /** The assigned ticket, to continue from its uncommitted edits rather than restart. */
  readonly continueWith?: { readonly ticketId: string; readonly uncommittedChanges: readonly string[] };
  readonly unverified: readonly UnverifiedTicket[];
  /** The tickets reconciliation concerns; every other ticket is left as it is. */
  readonly affected: readonly string[];
  /** Discrepancies not yet settled by the developer. */
  readonly discrepancies: readonly ResumeDiscrepancy[];
  /** The recommendation the session ended with, beside the current one, which is the one to act on (D15). */
  readonly recommendation: { readonly previous?: Recommendation; readonly current: Recommendation };
}

export type ResumeReadResult = { readonly ok: true; readonly report: ResumeReport } | Refusal;

interface Authorization {
  readonly executionAuthorized: boolean;
  readonly scope?: AuthorizationScope | undefined;
  readonly note?: string | undefined;
}

const describe = (authorization: Authorization) =>
  authorization.executionAuthorized
    ? `authorized for ${authorization.scope ?? "an unrecorded scope"}${authorization.note === undefined ? "" : ` ("${authorization.note}")`}`
    : "not authorized";

const sameAuthorization = (a: Authorization, b: Authorization) =>
  a.executionAuthorized === b.executionAuthorized && a.scope === b.scope && a.note === b.note;

/**
 * Whether implementing anything needs the developer's authorization now:
 * none is recorded, the plan is not accepted, or it covered one ticket that
 * is no longer ready or in progress (D28).
 */
function needsAuthorization(plan: PlanRecord | undefined, progress: ProgressRecord | undefined, tickets: readonly TicketRecord[]): boolean {
  if (plan?.status !== "accepted" || progress?.executionAuthorized !== true) return true;
  if (progress.authorizationScope !== "ticket") return false;
  const ticket = tickets.find((entry) => entry.id === progress.assignedTicketId);
  return ticket === undefined || (ticket.status !== "ready" && ticket.status !== "in-progress");
}

/** Where the working tree moved on since `wrap` recorded it. */
function treeDiscrepancies(atWrap: readonly string[], changed: readonly string[], developerKept: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const gone = atWrap.filter((path) => !changed.includes(path));
  if (gone.length > 0) found.push(`${gone.join(", ")} had uncommitted changes at wrap and ${gone.length === 1 ? "has" : "have"} none now`);
  const appeared = changed.filter((path) => !atWrap.includes(path) && !developerKept.has(path));
  if (appeared.length > 0) found.push(`${appeared.join(", ")} changed since wrap, and the resume record does not list ${appeared.length === 1 ? "it" : "them"}`);
  return found;
}

export function readResume(root: string, context: ResolutionContext): ResumeReadResult {
  const resumeRead = readRecord(root, "resume");
  if (resumeRead.kind === "malformed") return unreadable("resume", resumeRead);
  const planRead = readRecord(root, "plan");
  if (planRead.kind === "malformed") return unreadable("plan", planRead);
  const ticketsRead = readRecord(root, "tickets");
  if (ticketsRead.kind === "malformed") return unreadable("tickets", ticketsRead);
  const progressRead = readRecord(root, "progress");
  if (progressRead.kind === "malformed") return unreadable("progress", progressRead);
  const state = readProjectState(root);
  if (state.kind === "malformed") return unreadableState(state);
  const next = runNext(root, context);
  if (next.project === "malformed") return refuse(`the record at ${next.path} cannot be read (${next.problem})`);

  const resume = resumeRead.kind === "present" ? resumeRead.record : undefined;
  const plan = planRead.kind === "present" ? planRead.record : undefined;
  const tickets = ticketsRead.kind === "present" ? ticketsRead.record.tickets : [];
  const progress = progressRead.kind === "present" ? progressRead.record : undefined;
  const tree = readWorkingTree(root);
  const changed = tree.kind === "present" ? tree.changedPaths : [];

  const found = findRecordDiscrepancies(root, tickets, progress, tree, {
    unclaimed: state.state.unclaimedChanges,
    commitsExpected: context.configuration.settings["commitOnSuccess"] !== false,
  });
  const add = (summary: string, ticketId?: string, source: ResumeDiscrepancy["source"] = "records") =>
    found.push({ summary, ...(ticketId === undefined ? {} : { ticketId }), source });

  for (const ticket of tickets) {
    const disposition = progress?.validations?.[ticket.id]?.disposition;
    if (ticket.status === "done" && disposition !== undefined && disposition !== "admitted-to-review") {
      add(`${ticket.id} is recorded done, but its latest validation is ${disposition}`, ticket.id);
    }
  }

  const current: Authorization = {
    executionAuthorized: progress?.executionAuthorized ?? false,
    scope: progress?.authorizationScope,
    note: progress?.authorizationNote,
  };
  const developerKept = new Set((progress?.changeOwnership ?? []).filter((entry) => entry.owner === "developer").map((entry) => entry.path));
  if (resume !== undefined) {
    const atWrap: Authorization = {
      executionAuthorized: resume.plan?.executionAuthorized ?? false,
      scope: resume.plan?.authorizationScope,
      note: resume.plan?.authorizationNote,
    };
    if (!sameAuthorization(atWrap, current)) {
      add(`the resume record says execution was ${describe(atWrap)}, but the progress record says ${describe(current)}; the progress record stands`);
    }
    if (tree.kind === "present") for (const summary of treeDiscrepancies(resume.uncommittedChanges ?? [], changed, developerKept)) add(summary);
    for (const earlier of resume.discrepancies ?? []) if (earlier.source === "agent") add(earlier.summary, earlier.ticketId, "agent");
  }
  const settled = new Set((progress?.reconciliation?.settled ?? []).map((entry) => entry.summary));
  const discrepancies = found.filter((entry, index) => !settled.has(entry.summary) && found.findIndex((other) => other.summary === entry.summary) === index);

  const assigned = tickets.find((entry) => entry.id === progress?.assignedTicketId && entry.status === "in-progress");
  // The ticket's own edits: those it owns, or those it had at wrap; not changes that appeared since.
  const ownedByOthers = new Set(
    (progress?.changeOwnership ?? []).filter((entry) => entry.owner === "developer" || entry.ticketId !== assigned?.id).map((entry) => entry.path),
  );
  const ownedByTicket = new Set((progress?.changeOwnership ?? []).filter((entry) => entry.owner === "ticket" && entry.ticketId === assigned?.id).map((entry) => entry.path));
  const ticketEdits = changed.filter(
    (path) => ownedByTicket.has(path) || (!ownedByOthers.has(path) && (resume === undefined || (resume.uncommittedChanges ?? []).includes(path))),
  );
  const unverified = tickets
    .filter((ticket) => ticket.status === "done" && progress?.validations?.[ticket.id] === undefined)
    .map((ticket) => ({ ticketId: ticket.id, checks: readRecordedEvidence(root, ticket.id)?.checks ?? [] }));
  const affected = [
    ...new Set([
      ...(assigned === undefined ? [] : [assigned.id]),
      ...unverified.map((entry) => entry.ticketId),
      ...discrepancies.flatMap((entry) => (entry.ticketId === undefined ? [] : [entry.ticketId])),
    ]),
  ];

  return {
    ok: true,
    report: {
      ...(resume === undefined ? {} : { resume }),
      authorization: {
        executionAuthorized: current.executionAuthorized,
        ...(current.scope === undefined ? {} : { scope: current.scope }),
        ...(current.note === undefined ? {} : { note: current.note }),
        ...(progress?.assignedTicketId === undefined ? {} : { assignedTicketId: progress.assignedTicketId }),
        needsDeveloper: needsAuthorization(plan, progress, tickets),
      },
      ...(assigned === undefined ? {} : { continueWith: { ticketId: assigned.id, uncommittedChanges: ticketEdits } }),
      unverified,
      affected,
      discrepancies,
      recommendation: {
        ...(resume?.recommendation === undefined ? {} : { previous: resume.recommendation }),
        current: { action: next.recommendation.action, reason: next.recommendation.reason },
      },
    },
  };
}

/**
 * Judges a done ticket's accepted criteria on checks run now (D15): the
 * validation goes in the progress record and the evidence where
 * `implement check` keeps it. The ticket's status is not changed; a claim
 * the checks do not support is a discrepancy for `reconcileResume`.
 */
export async function verifyTicket(root: string, input: ValidationInput, dependencies: DecisionDependencies): Promise<TicketValidationResult> {
  const tickets = readRecord(root, "tickets");
  if (tickets.kind !== "present") return { kind: "refused", reason: "there is no readable ticket breakdown" };
  const ticket = tickets.record.tickets.find((entry) => entry.id === input?.ticketId);
  if (ticket === undefined) return { kind: "refused", reason: `no ticket "${String(input?.ticketId)}" in the plan` };
  if (ticket.status !== "done") {
    return { kind: "refused", reason: `${ticket.id} is ${ticket.status}; verify checks a completion claim, and implement check validates work in progress` };
  }
  const invalid = refuseInvalidEvidence(input);
  if (invalid !== undefined) return invalid;
  const judged = await judgeTicket(root, ticket, input, dependencies);
  if (judged.kind !== "validated") return judged;
  const refused = saveValidation(root, ticket.id, judged.validation);
  if (refused !== undefined) return refused;
  recordEvidence(root, input, dependencies.now());
  return judged;
}

export interface ReconcileDraft {
  /** What the agent found that the records cannot show: a failing check, a changed requirement. */
  readonly discrepancies?: readonly {
    readonly summary: string;
    readonly ticketId?: string;
    /** What it rests on: commands and their output, files. */
    readonly evidence?: readonly string[];
    /** It changes agreed scope, which only the developer settles, through realign (D7, D42). */
    readonly changesScope?: boolean;
  }[];
}

export interface ReconciledDiscrepancy extends ResumeDiscrepancy {
  /** Whether the developer is asked about it. */
  readonly ask: boolean;
  /** Asked in an earlier reconcile and still waiting on the developer; Jev was not asked again. */
  readonly awaiting?: boolean;
  /** The escalate envelope, when Jev was asked. */
  readonly escalation?: string;
  /** The realign recommendation for a scope-changing discrepancy. */
  readonly recommendation?: string;
}

export type ReconcileResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly discrepancies: readonly ReconciledDiscrepancy[];
        /** The asks to put to the developer, one per discrepancy that needs them. */
        readonly askHuman: readonly EscalationAsk[];
        readonly report: ResumeReport;
      };
    }
  | Refusal;

interface Found extends ResumeDiscrepancy {
  readonly evidence: readonly string[];
  readonly changesScope: boolean;
}

/** A ticket as a packet excerpt: its status and accepted criteria. */
function ticketText(tickets: readonly TicketRecord[], ticketId: string): string {
  const ticket = tickets.find((entry) => entry.id === ticketId);
  if (ticket === undefined) return "not in the tickets record";
  return `${ticket.title}: ${ticket.status}\ncriteria:\n${ticket.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`;
}

/**
 * Puts every unsettled discrepancy to `escalate` (or, for a scope change,
 * to the developer directly) and records the ones that ask the developer
 * in the progress record's reconciliation. It reconciles nothing itself.
 */
export async function reconcileResume(root: string, draft: ReconcileDraft, dependencies: DecisionDependencies): Promise<ReconcileResult> {
  // The draft arrives as a JSON file the agent wrote; read it defensively.
  const drafted = Array.isArray(draft?.discrepancies) ? draft.discrepancies : [];
  if (!drafted.every((entry) => hasText(entry?.summary))) return refuse("each discrepancy needs a summary");
  const read = readResume(root, dependencies.context);
  if (!read.ok) return read;
  const { report } = read;
  if (report.unverified.length > 0) {
    return refuse(
      `${report.unverified.map((entry) => entry.ticketId).join(", ")} ${report.unverified.length === 1 ? "is" : "are"} recorded done without verification evidence; run the checks and record them with resume verify before reconciling`,
    );
  }
  const progressRead = readRecord(root, "progress");
  if (progressRead.kind === "malformed") return unreadable("progress", progressRead);
  const progress = progressRead.kind === "present" ? progressRead.record : undefined;
  const ticketsRead = readRecord(root, "tickets");
  const tickets = ticketsRead.kind === "present" ? ticketsRead.record.tickets : [];
  const settled = new Set((progress?.reconciliation?.settled ?? []).map((entry) => entry.summary));
  const waiting = new Set((progress?.reconciliation?.discrepancies ?? []).map((entry) => entry.summary));

  const found: Found[] = [
    ...report.discrepancies.map((entry) => ({ ...entry, evidence: [], changesScope: false })),
    ...drafted
      .map((entry) => ({
        summary: entry.summary.trim(),
        ...(hasText(entry.ticketId) ? { ticketId: entry.ticketId.trim() } : {}),
        source: "agent" as const,
        evidence: (Array.isArray(entry.evidence) ? entry.evidence : []).filter(hasText),
        changesScope: entry.changesScope === true,
      }))
      .filter((entry) => !settled.has(entry.summary)),
  ].filter((entry, index, all) => all.findIndex((other) => other.summary === entry.summary) === index);

  const realign = readRecord(root, "realign");
  const openRecommendations = realign.kind === "present" ? realign.record.recommendations.filter((entry) => entry.status === "open") : [];
  const reconciled: ReconciledDiscrepancy[] = [];
  const askHuman: EscalationAsk[] = [];
  for (const entry of found) {
    const { evidence, changesScope, ...base } = entry;
    if (changesScope) {
      let id = openRecommendations.find((recommendation) => recommendation.summary === entry.summary)?.id;
      if (id === undefined) {
        const recommended = recommendRealign(root, { source: "resume", summary: entry.summary, evidence }, { now: dependencies.now() });
        if (!recommended.ok) return recommended;
        id = recommended.outcome.recommendation.id;
      }
      askHuman.push(humanAskAt("consequential-conflict", `At resume: ${entry.summary}`, `it changes agreed scope, so the decision is yours; realign is recommended (${id}) and nothing was started`));
      reconciled.push({ ...base, ask: true, recommendation: id });
      continue;
    }
    if (waiting.has(entry.summary)) {
      askHuman.push(humanAskAt("resume-discrepancy", `At resume: ${entry.summary}`, "asked before and still waiting on your decision; settle it with resume settle"));
      reconciled.push({ ...base, ask: true, awaiting: true });
      continue;
    }
    const escalation = await askEscalation(
      root,
      {
        kind: "resume-discrepancy",
        summary: `At resume in a fresh session: ${entry.summary}`,
        excerpts: [
          ...(report.resume === undefined ? [] : [{ source: "resume/summary", text: report.resume.summary }]),
          ...(entry.ticketId === undefined ? [] : [{ source: `tickets/${entry.ticketId}`, text: ticketText(tickets, entry.ticketId) }]),
          ...evidence.map((text, index) => ({ source: `evidence[${index}]`, text })),
        ],
      },
      dependencies,
    );
    if (escalation.kind === "refused") return refuse(escalation.reason);
    if (escalation.ask && escalation.askHuman !== undefined) askHuman.push(escalation.askHuman);
    reconciled.push({ ...base, ask: escalation.ask, ...("envelope" in escalation ? { escalation: escalation.envelope } : {}) });
  }

  if (progress !== undefined) {
    const asked: ReconciliationDiscrepancy[] = reconciled
      .filter((entry) => entry.ask)
      .map((entry) => ({ ...(entry.ticketId === undefined ? {} : { ticketId: entry.ticketId }), summary: entry.summary, consequential: true }));
    const next = validateRecord("progress", {
      ...progress,
      reconciliation: { ...progress.reconciliation, lastReconciledAt: dependencies.now(), discrepancies: asked },
    });
    if (!next.ok) return refuse("the reconciliation cannot be recorded", next.issues);
    writeRecord(root, "progress", next.record);
  }
  return { ok: true, outcome: { discrepancies: reconciled, askHuman, report } };
}

export type SettleResult = { readonly ok: true; readonly outcome: { readonly settled: readonly SettledDiscrepancy[] } } | Refusal;

/**
 * Records the developer's decision on the discrepancies waiting on them, in
 * their words, so resume does not raise them again. It changes nothing
 * else: acting on the decision is an authorized action's work.
 */
export function settleDiscrepancies(root: string, input: { readonly note: string }, options: { readonly now: string }): SettleResult {
  const note = typeof input?.note === "string" ? input.note.trim() : "";
  if (note === "") return refuse("settling a discrepancy is the developer's decision; record their words (--note)");
  const read = readRecord(root, "progress");
  if (read.kind === "malformed") return unreadable("progress", read);
  const waiting = read.kind === "present" ? (read.record.reconciliation?.discrepancies ?? []) : [];
  if (read.kind !== "present" || waiting.length === 0) return refuse("no discrepancy is waiting on the developer");
  const settled: SettledDiscrepancy[] = waiting.map((entry) => ({
    summary: entry.summary,
    ...(entry.ticketId === undefined ? {} : { ticketId: entry.ticketId }),
    note,
    settledAt: options.now,
  }));
  const reconciliation = read.record.reconciliation!;
  const next = validateRecord("progress", {
    ...read.record,
    reconciliation: { ...reconciliation, discrepancies: [], settled: [...(reconciliation.settled ?? []), ...settled] },
  });
  if (!next.ok) return refuse("the settlement cannot be recorded", next.issues);
  writeRecord(root, "progress", next.record);
  return { ok: true, outcome: { settled } };
}
