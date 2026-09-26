import { readJev } from "../jev/fallback.js";
import {
  PROJECT_RECORD_DIRECTORY,
  readRecord,
  validateRecord,
  writeRecord,
  type LessonRecord,
  type ProgressRecord,
  type ResumeDiscrepancy,
  type ResumeLessons,
  type ResumeOutcome,
  type ResumeRecord,
  type TicketRecord,
} from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { commitExists, readWorkingTree, ticketCommitExists, type WorkingTree } from "../project/worktree.js";
import { hasText } from "../validation.js";
import { runNext } from "./next.js";
import { refuse, unreadable, unreadableState, type Refusal } from "./refusal.js";
import type { ResolutionContext } from "./resolve.js";

/**
 * The helper's part of `wrap` (issue #21, D15, user stories 18 and 19):
 * write a resume record a fresh session can continue from without chat
 * history, and report where the records and the project disagree.
 *
 * - The record is derived from the other records (plan and authorization,
 *   ticket outcomes, parked tickets and their blockers, open todos, lesson
 *   state, `next`'s recommendation) plus the agent's summary and next steps.
 * - Discrepancies are reported and recorded, never reconciled: no other
 *   record is touched.
 * - Only `jflow/resume.json` is written. Git is only read; nothing is
 *   committed, pushed, merged, published or cleaned up, raw traces included.
 */

export interface WrapDraft {
  /** What happened this session, in a few sentences. */
  readonly summary: string;
  readonly nextSteps?: readonly string[];
  /** Discrepancies the agent found that the records cannot show, such as a failing check. */
  readonly discrepancies?: readonly { readonly summary: string; readonly ticketId?: string }[];
}

export type WrapResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly record: string;
        readonly resume: ResumeRecord;
        /** Every discrepancy, the helper's and the agent's; none was reconciled. */
        readonly discrepancies: readonly ResumeDiscrepancy[];
      };
    }
  | Refusal;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Where the assigned ticket stands: fix attempts, validate and review. */
function progressNote(progress: ProgressRecord, ticketId: string): string {
  const attempts = progress.fixAttempts?.[ticketId] ?? 0;
  const validation = progress.validations?.[ticketId]?.disposition;
  const review = progress.reviews?.[ticketId]?.disposition;
  return [
    ...(attempts > 0 ? [plural(attempts, "fix attempt")] : []),
    validation === undefined ? "not yet validated" : `validate: ${validation}`,
    ...(review === undefined ? [] : [`review: ${review}`]),
  ].join("; ");
}

function outcomesOf(tickets: readonly TicketRecord[], progress: ProgressRecord | undefined): ResumeOutcome[] {
  return tickets.map((ticket) => ({
    ticketId: ticket.id,
    title: ticket.title,
    status: ticket.status,
    ...(ticket.commit === undefined ? {} : { commit: ticket.commit }),
    ...(progress !== undefined && ticket.id === progress.assignedTicketId ? { note: progressNote(progress, ticket.id) } : {}),
  }));
}

function lessonStateOf(lessons: readonly LessonRecord[]): ResumeLessons {
  const ids = (predicate: (lesson: LessonRecord) => boolean) => lessons.filter(predicate).map((lesson) => lesson.id);
  const undecided = (lesson: LessonRecord) => lesson.status === "candidate" && lesson.retention?.decision === undefined;
  return {
    active: ids((lesson) => lesson.status === "active"),
    candidates: ids((lesson) => lesson.status === "candidate" && !(undecided(lesson) && lesson.retention?.conflict !== undefined)),
    undecided: ids((lesson) => undecided(lesson) && lesson.retention?.conflict === undefined),
    awaitingDeveloper: ids((lesson) => undecided(lesson) && lesson.retention?.conflict !== undefined),
    contradicted: ids(
      (lesson) => lesson.status === "active" && (lesson.checks ?? []).some((check) => check.outcome === "contradicted"),
    ),
    superseded: ids((lesson) => lesson.status === "superseded"),
  };
}

/** Where the records and the repository disagree. Read-only; resume checks the same again (issue #22). */
export function findRecordDiscrepancies(
  root: string,
  tickets: readonly TicketRecord[],
  progress: ProgressRecord | undefined,
  tree: WorkingTree,
  observed: { readonly unclaimed: readonly string[]; readonly commitsExpected: boolean },
): ResumeDiscrepancy[] {
  const found: ResumeDiscrepancy[] = [];
  const add = (summary: string, ticketId?: string) =>
    found.push({ summary, ...(ticketId === undefined ? {} : { ticketId }), source: "records" });

  // Discrepancies an earlier check recorded and nobody has settled stay reported.
  for (const earlier of progress?.reconciliation?.discrepancies ?? []) add(earlier.summary, earlier.ticketId);

  const committed = tickets.filter((ticket) => ticket.commit !== undefined);
  if (committed.length > 0 && tree.kind !== "present") {
    add(`${committed.map((ticket) => ticket.id).join(", ")} record commits, but there is no readable repository to check them in`);
  }
  for (const ticket of tickets) {
    if (ticket.commit === undefined) {
      // The tickets record cannot hold its own commit's hash; the commit is found by its ticket trailer.
      if (ticket.status === "done" && observed.commitsExpected && !(tree.kind === "present" && ticketCommitExists(root, ticket.id))) {
        add(`${ticket.id} is recorded done without a commit`, ticket.id);
      }
    } else if (tree.kind === "present" && !commitExists(root, ticket.commit)) {
      add(`${ticket.id} is recorded ${ticket.status} at commit ${ticket.commit}, which the repository does not have`, ticket.id);
    }
  }

  const assigned = progress?.assignedTicketId;
  if (assigned !== undefined) {
    const ticket = tickets.find((entry) => entry.id === assigned);
    if (ticket === undefined) add(`the assigned ticket ${assigned} is not in the tickets record`, assigned);
    else if (ticket.status !== "in-progress") add(`the assigned ticket ${assigned} is ${ticket.status}, not in progress`, assigned);
    if (progress?.ticketChangesPresent && tree.kind === "present" && tree.changedPaths.length === 0) {
      add(`the records say ${assigned} has changes, but the working tree has no uncommitted changes`, assigned);
    }
  }
  for (const ticket of tickets) {
    if (ticket.status === "in-progress" && ticket.id !== assigned) {
      add(`${ticket.id} is in progress but is not the assigned ticket`, ticket.id);
    }
    if (progress?.reviews?.[ticket.id]?.disposition === "passed" && ticket.status !== "done") {
      add(`${ticket.id} passed review but is recorded ${ticket.status}, not done`, ticket.id);
    }
  }
  if (observed.unclaimed.length > 0) add(`uncommitted changes no one owns: ${observed.unclaimed.join(", ")}`);
  return found;
}

export function wrapSession(
  root: string,
  draft: WrapDraft,
  context: ResolutionContext,
  options: { readonly now: string },
): WrapResult {
  // The draft arrives as a JSON file the agent wrote; read it defensively.
  if (!hasText(draft?.summary)) return refuse("a resume record needs a summary of what happened this session");
  const agentFound = Array.isArray(draft.discrepancies) ? draft.discrepancies : [];
  if (!agentFound.every((entry) => hasText(entry?.summary))) return refuse("each discrepancy needs a summary");
  if (draft.nextSteps !== undefined && !Array.isArray(draft.nextSteps)) return refuse("nextSteps is a list of steps");

  const planRead = readRecord(root, "plan");
  if (planRead.kind === "malformed") return unreadable("plan", planRead);
  const ticketsRead = readRecord(root, "tickets");
  if (ticketsRead.kind === "malformed") return unreadable("tickets", ticketsRead);
  const progressRead = readRecord(root, "progress");
  if (progressRead.kind === "malformed") return unreadable("progress", progressRead);
  const todosRead = readRecord(root, "todos");
  if (todosRead.kind === "malformed") return unreadable("todos", todosRead);
  const lessonsRead = readRecord(root, "lessons");
  if (lessonsRead.kind === "malformed") return unreadable("lessons", lessonsRead);
  const state = readProjectState(root);
  if (state.kind === "malformed") return unreadableState(state);
  const next = runNext(root, context);
  if (next.project === "malformed") return refuse(`the record at ${next.path} cannot be read (${next.problem})`);
  const jev = readJev(root);
  if (!jev.ok) return jev;

  const plan = planRead.kind === "present" ? planRead.record : undefined;
  const tickets = ticketsRead.kind === "present" ? ticketsRead.record.tickets : [];
  const progress = progressRead.kind === "present" ? progressRead.record : undefined;
  const todos = todosRead.kind === "present" ? todosRead.record.items : [];
  const lessons = lessonsRead.kind === "present" ? lessonsRead.record.lessons : [];

  const tree = readWorkingTree(root);
  const parked = tickets.filter((ticket) => ticket.status === "parked");
  const { fallback } = jev.record;
  const discrepancies: ResumeDiscrepancy[] = [
    ...findRecordDiscrepancies(root, tickets, progress, tree, {
      unclaimed: state.state.unclaimedChanges,
      commitsExpected: context.configuration.settings["commitOnSuccess"] !== false,
    }),
    ...agentFound.map((entry) => ({
      summary: entry.summary.trim(),
      ...(hasText(entry.ticketId) ? { ticketId: entry.ticketId.trim() } : {}),
      source: "agent" as const,
    })),
  ];
  const nextSteps = (draft.nextSteps ?? []).filter(hasText);
  const resume: ResumeRecord = {
    writtenAt: options.now,
    summary: draft.summary.trim(),
    ...(nextSteps.length === 0 ? {} : { nextSteps }),
    ...(plan === undefined
      ? {}
      : {
          plan: {
            title: plan.title,
            status: plan.status,
            executionAuthorized: progress?.executionAuthorized ?? false,
            ...(progress?.authorizationScope === undefined ? {} : { authorizationScope: progress.authorizationScope }),
            ...(progress?.authorizationNote === undefined ? {} : { authorizationNote: progress.authorizationNote }),
          },
        }),
    ...(progress?.assignedTicketId === undefined ? {} : { activeTicketId: progress.assignedTicketId }),
    ...(tickets.length === 0 ? {} : { outcomes: outcomesOf(tickets, progress) }),
    ...(parked.length === 0
      ? {}
      : { parkedTickets: parked.map((ticket) => ({ ticketId: ticket.id, blocker: ticket.parkedReason ?? "no blocker recorded" })) }),
    unresolvedTodos: todos
      .filter((item) => item.status === "open")
      .map((item) => `${item.id}: ${item.summary}${item.discoveredDuring === undefined ? "" : ` (found during ${item.discoveredDuring})`}`),
    lessons: lessonStateOf(lessons),
    recommendation: { action: next.recommendation.action, reason: next.recommendation.reason },
    ...(fallback.status === "off"
      ? {}
      : {
          jevFallback: {
            status: fallback.status,
            ...(fallback.pendingDecision === undefined ? {} : { pendingDecision: fallback.pendingDecision }),
            ...(fallback.scope === undefined ? {} : { scope: fallback.scope }),
            ...(fallback.scopeId === undefined ? {} : { scopeId: fallback.scopeId }),
          },
        }),
    ...(tree.kind === "present" && tree.changedPaths.length > 0 ? { uncommittedChanges: tree.changedPaths } : {}),
    discrepancies,
  };

  const validated = validateRecord("resume", resume);
  if (!validated.ok) return refuse("the resume record cannot be written", validated.issues);
  writeRecord(root, "resume", validated.record);
  return {
    ok: true,
    outcome: { record: `${PROJECT_RECORD_DIRECTORY}/resume.json`, resume: validated.record, discrepancies },
  };
}
