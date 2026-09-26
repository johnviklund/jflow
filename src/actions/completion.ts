import {
  readRecord,
  validateRecord,
  writeRecord,
  type ProgressRecord,
  type TicketRecord,
  type TicketsRecord,
} from "../project/records.js";
import { commitPaths, readChangedRecords, readWorkingTree, TICKET_TRAILER } from "../project/worktree.js";
import { readWorkingTicket } from "./implement.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";
import type { ResolutionContext } from "./resolve.js";

/**
 * Completing a ticket (issue #10, D29, D34): once it has passed `validate`
 * with every criterion met and an independent review, the ticket is
 * recorded done and, with `commitOnSuccess` on (the default), committed
 * locally with only its own changes and the project records. A change the
 * developer kept, or one another ticket adopted, is left out, as is
 * anything the developer staged. A ticket that has not passed is refused
 * and nothing is committed.
 *
 * Nothing here pushes, publishes or merges; those stay separately
 * authorized. A ticket-scope authorization covers this one ticket, so it
 * ends here; whole-plan authorization carries on to the next ticket (D28,
 * D29). The commit names its ticket in a `Jflow-Ticket` trailer, so the
 * records it carries are complete and nothing is left to write after it.
 */

const COMMIT_SETTING = "commitOnSuccess";

export interface CompletedTicket {
  readonly ticket: TicketRecord;
  /** The local commit, absent when commit-on-success is off. */
  readonly commit?: { readonly hash: string; readonly paths: readonly string[] };
  /** Changed paths that are not the ticket's and stay uncommitted. */
  readonly leftOut: readonly string[];
  /** Whether execution authorization ended with this ticket or continues to the next. */
  readonly authorization: "ended" | "continues";
}

export type CompletionResult = { readonly ok: true; readonly outcome: CompletedTicket } | Refusal;

/** Which changed paths are the ticket's: all but those the developer kept or another ticket adopted. */
function splitChanges(progress: ProgressRecord, ticketId: string, changed: readonly string[]) {
  const notOurs = new Set(
    (progress.changeOwnership ?? [])
      .filter((entry) => entry.owner === "developer" || entry.ticketId !== ticketId)
      .map((entry) => entry.path),
  );
  return {
    ticketChanges: changed.filter((path) => !notOurs.has(path)),
    leftOut: changed.filter((path) => notOurs.has(path)),
  };
}

/**
 * Progress once the ticket is done: nothing assigned, a one-ticket
 * authorization spent, and the changes the ticket adopted released, since
 * they are committed and a later ticket's edits to them are its own.
 */
function progressAfter(progress: ProgressRecord, ticketId: string): ProgressRecord {
  const {
    assignedTicketId: _assigned,
    executionAuthorized,
    authorizationScope,
    authorizationNote,
    changeOwnership,
    ...rest
  } = progress;
  const continues = executionAuthorized && authorizationScope === "plan";
  const kept = (changeOwnership ?? []).filter((entry) => entry.owner === "developer" || entry.ticketId !== ticketId);
  return {
    ...rest,
    ...(changeOwnership === undefined ? {} : { changeOwnership: kept }),
    ticketChangesPresent: false,
    executionAuthorized: continues,
    ...(continues ? { authorizationScope, ...(authorizationNote === undefined ? {} : { authorizationNote }) } : {}),
  };
}

function withTicket(tickets: TicketsRecord, ticket: TicketRecord): TicketsRecord {
  return { tickets: tickets.tickets.map((entry) => (entry.id === ticket.id ? ticket : entry)) };
}

/**
 * Records the ticket done and makes its local commit. Refused unless the
 * ticket is the one in progress, its latest `validate` found every
 * criterion met, and its latest review passed. When Git refuses the commit
 * (a failing hook, say), the records are put back as they were.
 */
export function completeTicket(
  root: string,
  request: { readonly ticketId?: string },
  context: ResolutionContext,
  options: { readonly now: string },
): CompletionResult {
  const progressRead = readRecord(root, "progress");
  if (progressRead.kind === "malformed") return unreadable("progress", progressRead);
  const ticketId = request.ticketId ?? (progressRead.kind === "present" ? progressRead.record.assignedTicketId : undefined);
  if (ticketId === undefined) return refuse("no ticket is in progress to complete");
  const working = readWorkingTicket(root, ticketId);
  if (!working.ok) return working;
  const { ticket, progress, tickets } = working;
  if (progress.validations?.[ticket.id]?.disposition !== "admitted-to-review") {
    return refuse(`ticket ${ticket.id} has not passed validate with every criterion met; it is not complete`);
  }
  const review = progress.reviews?.[ticket.id];
  if (review?.disposition !== "passed") {
    return refuse(
      review === undefined
        ? `ticket ${ticket.id} has not been reviewed; an independent review must pass before it is complete`
        : `ticket ${ticket.id}'s review is ${review.disposition}; only a passed review completes it`,
    );
  }

  const commitOn = context.configuration.settings[COMMIT_SETTING] !== false;
  let changed: readonly string[] = [];
  if (commitOn) {
    const tree = readWorkingTree(root);
    if (tree.kind !== "present") {
      return refuse(
        tree.kind === "absent"
          ? "there is no Git repository to commit to; turn commitOnSuccess off to complete without a commit"
          : `the Git repository cannot be read (${tree.message}); nothing was committed`,
      );
    }
    changed = tree.changedPaths;
  }
  const { ticketChanges, leftOut } = splitChanges(progress, ticket.id, changed);

  const done: TicketRecord = { ...ticket, status: "done" };
  const nextTickets = validateRecord("tickets", withTicket(tickets, done));
  if (!nextTickets.ok) return refuse("the ticket cannot be recorded done", nextTickets.issues);
  const nextProgress = validateRecord("progress", progressAfter(progress, ticket.id));
  if (!nextProgress.ok) return refuse("the progress record cannot be updated", nextProgress.issues);
  writeRecord(root, "tickets", nextTickets.record);
  writeRecord(root, "progress", nextProgress.record);
  const authorization = nextProgress.record.executionAuthorized ? "continues" : "ended";
  if (!commitOn) return { ok: true, outcome: { ticket: done, leftOut, authorization } };

  const paths = [...ticketChanges, ...readChangedRecords(root)];
  const message = [
    `${ticket.id}: ${ticket.title}`,
    `Passed validate and review by ${review.reviewer.agent}; committed by jflow on ${options.now}.`,
    `${TICKET_TRAILER}: ${ticket.id}`,
  ].join("\n\n");
  let hash: string;
  try {
    hash = commitPaths(root, paths, message);
  } catch (error) {
    writeRecord(root, "tickets", tickets);
    writeRecord(root, "progress", progress);
    return refuse(`Git refused the commit, so ticket ${ticket.id} is not complete: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, outcome: { ticket: done, commit: { hash, paths }, leftOut, authorization } };
}
