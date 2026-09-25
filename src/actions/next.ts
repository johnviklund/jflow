import { EMPTY_PROGRESS, readRecord, type RecordKind, type RecordReadResult, type TodoItem } from "../project/records.js";
import { planCompletion } from "./plan-review.js";
import { resolveAction, type ResolutionContext, type UnmetPrerequisite } from "./resolve.js";
import { runStatus, type ActionStatus } from "./status.js";

/**
 * The always-available `next` action (issue #14, D25): which actions could
 * run now and why, and one recommended action with its reason. A
 * recommendation is not authorization (CONTEXT.md): what only the developer
 * can grant is reported as theirs to decide, and `next` writes nothing.
 *
 * The recommendation is a fixed reading of the records. Jev's advisory
 * `next-action` decision (#17) is weighed by the primary agent alongside it.
 * Review is not recommended from here yet: that a ticket has changes does
 * not mean it is finished, and the record that says so arrives with
 * implement's validate gate (#8).
 */

export interface Recommendation {
  readonly action: string;
  readonly reason: string;
  /** The recommended action waits on a decision only the developer can make. */
  readonly needsDeveloper: boolean;
  /** Prerequisites standing between the recommended action and running it. */
  readonly unmet: readonly UnmetPrerequisite[];
}

export type NextReport =
  | {
      readonly project: "uninitialized" | "initialized";
      readonly recommendation: Recommendation;
      readonly actions: readonly ActionStatus[];
      /** Future work outside the plan, authorized by nothing. */
      readonly openTodos: readonly TodoItem[];
      /** Items the developer decided to promote, waiting for `plan` or `realign` to add a ticket. */
      readonly promotedTodos: readonly TodoItem[];
    }
  | { readonly project: "malformed"; readonly path: string; readonly problem: string };

type Malformed = Extract<NextReport, { project: "malformed" }>;

function malformed(read: Extract<RecordReadResult<RecordKind>, { kind: "malformed" }>): Malformed {
  return {
    project: "malformed",
    path: read.path,
    problem: read.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
  };
}

export function runNext(root: string, context: ResolutionContext): NextReport {
  const status = runStatus(root, context);
  if (status.project === "malformed") return status;
  const specification = readRecord(root, "specification");
  if (specification.kind === "malformed") return malformed(specification);
  const plan = readRecord(root, "plan");
  if (plan.kind === "malformed") return malformed(plan);
  const tickets = readRecord(root, "tickets");
  if (tickets.kind === "malformed") return malformed(tickets);
  const todos = readRecord(root, "todos");
  if (todos.kind === "malformed") return malformed(todos);
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return malformed(progress);

  const recommend = (action: string, reason: string, awaitsDeveloper = false): Recommendation => {
    const resolution = resolveAction({ action }, status.state, context);
    const unmet = resolution.status === "blocked" ? resolution.unmet : [];
    return { action, reason, needsDeveloper: awaitsDeveloper || unmet.some((entry) => entry.needsHuman), unmet };
  };

  const { state } = status;
  const ticketList = tickets.kind === "present" ? tickets.record.tickets : [];
  const remaining = ticketList.filter((ticket) => ticket.status === "ready" || ticket.status === "in-progress");
  const parked = ticketList.filter((ticket) => ticket.status === "parked");

  let recommendation: Recommendation;
  if (specification.kind === "absent") {
    recommendation = recommend("brainstorm", "there is no specification yet; brainstorm defines what to build");
  } else if (specification.record.status === "awaiting-acceptance") {
    recommendation = recommend("brainstorm", "the specification awaits your acceptance before planning can start", true);
  } else if (plan.kind === "absent") {
    recommendation = recommend("plan", "the specification is accepted and has no ticket breakdown yet");
  } else if (plan.record.status === "awaiting-acceptance") {
    recommendation = recommend("plan", "the ticket breakdown awaits your acceptance before implementation can start", true);
  } else if (state.assignedTicketId !== undefined && state.ticketAdmittedToReview) {
    recommendation = recommend(
      "review",
      `ticket ${state.assignedTicketId} passed validate with every criterion met; an independent reviewer assesses it next`,
    );
  } else if (state.assignedTicketId !== undefined) {
    recommendation = recommend(
      "implement",
      state.ticketChangesPresent
        ? `ticket ${state.assignedTicketId} is in progress`
        : `ticket ${state.assignedTicketId} is assigned and has no changes yet`,
    );
  } else if (ticketList.length > 0 && remaining.length === 0 && parked.length > 0) {
    recommendation = recommend(
      "implement",
      `only parked tickets remain (${parked.map((ticket) => ticket.id).join(", ")}); each waits on the decision recorded as its reason`,
      true,
    );
  } else if (ticketList.length > 0 && remaining.length === 0) {
    const completion = planCompletion(
      { tickets: ticketList },
      progress.kind === "present" ? progress.record : EMPTY_PROGRESS,
    );
    // The integrated review is plan-scoped, so the ticket-scoped review prerequisites do not apply to it.
    recommendation = completion.complete
      ? recommend("wrap", "every ticket is done or withdrawn; wrap reconciles the session")
      : {
          action: "review",
          reason: `${completion.reason}; the integrated review across the tickets comes next (review plan)`,
          needsDeveloper: progress.kind === "present" && progress.record.planReview !== undefined,
          unmet: [],
        };
  } else {
    recommendation = recommend("implement", "the plan is accepted; implementation works one assigned ticket at a time");
  }

  const items = todos.kind === "present" ? todos.record.items : [];
  return {
    project: status.project,
    recommendation,
    actions: status.actions,
    openTodos: items.filter((item) => item.status === "open"),
    promotedTodos: items.filter((item) => item.status === "promoted"),
  };
}
