import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SECRET_KEY_PATTERN, SECRET_MESSAGE, SECRET_VALUE_PATTERN } from "../secrets.js";
import {
  IssueCollector,
  isRecord,
  joinPath,
  optionalString,
  optionalStringArray,
  optionalTimestamp,
  requireBoolean,
  requireIntegerInRange,
  requireNonEmptyString,
  requireObject,
  requireTimestamp,
  validateEnumValue,
  validateStringArray,
} from "../validation.js";
import type { ValidationIssue } from "../workflow/types.js";

/**
 * The authoritative project record store (SPEC.md D14, issue #3). Plans,
 * tickets, progress, lessons, Jev fallback status, the wrap resume record,
 * todo items, conflicts, diagnoses and worker assignments live as one JSON file each under a
 * version-controlled `jflow/` directory, so a fresh conversation recovers full context from files alone.
 *
 * Records keep summaries and trace references only (D23): every schema is
 * closed, so a raw Jev request or response body has no field of its own to
 * land in, and a credential-looking key or value is refused on write. Reads
 * are not scanned, so a record already on disk is never made unreadable by a
 * later tightening of the scan.
 *
 * Writes are atomic per record (temporary file and rename) but a
 * read-modify-write of one record by two concurrent callers is not
 * serialised; jflow runs one helper at a time.
 */
export const PROJECT_RECORD_DIRECTORY = "jflow";

export const RECORD_KINDS = [
  "specification",
  "plan",
  "tickets",
  "progress",
  "lessons",
  "jev",
  "resume",
  "todos",
  "conflicts",
  "diagnoses",
  "workers",
  "realign",
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

/** A decision is a proposal until the developer confirms or rejects it in their own words. */
export const DECISION_STATUSES = ["proposed", "confirmed", "rejected"] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** A decision the specification rests on. */
export interface SpecificationDecision {
  readonly id: string;
  readonly statement: string;
  readonly status: DecisionStatus;
  /** Where the decision came from; for a confirmed or rejected one, what the developer said. */
  readonly basis?: string;
}

export const SPECIFICATION_STATUSES = ["awaiting-acceptance", "accepted"] as const;

export type SpecificationStatus = (typeof SPECIFICATION_STATUSES)[number];

/**
 * What `brainstorm` produces and the developer accepts before `plan` may
 * run (D27). Owns the specification acceptance gate: the resolver's
 * `specificationAccepted` is derived from `status`, nowhere else.
 */
export interface SpecificationRecord {
  readonly title: string;
  readonly problem: string;
  readonly scenarios: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly exclusions: readonly string[];
  readonly decisions: readonly SpecificationDecision[];
  readonly status: SpecificationStatus;
  readonly writtenAt: string;
  readonly acceptedAt?: string;
  /** The developer's words of acceptance, recorded as said (D27). */
  readonly acceptanceNote?: string;
}

export const PLAN_STATUSES = ["awaiting-acceptance", "accepted"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * The ticket breakdown's header, written by `plan` and accepted by the
 * developer before implementation (D28). Owns the plan acceptance gate: the
 * resolver's `planAccepted` is derived from `status`, nowhere else.
 * Acceptance is never authorization; that is progress state.
 */
export interface PlanRecord {
  readonly title: string;
  readonly summary: string;
  /** Where the plan came from, e.g. a spec path or tracker reference. */
  readonly source?: string;
  readonly status: PlanStatus;
  readonly writtenAt: string;
  readonly acceptedAt?: string;
  /** The developer's words of acceptance, recorded as said (D28). */
  readonly acceptanceNote?: string;
}

export const TICKET_STATUSES = ["ready", "in-progress", "parked", "done", "withdrawn"] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface TicketRecord {
  readonly id: string;
  readonly title: string;
  /** Testable criteria accepted with the plan; a ticket without them is not valid (D41). */
  readonly acceptanceCriteria: readonly string[];
  readonly dependsOn: readonly string[];
  readonly status: TicketStatus;
  /** Why the ticket is parked rather than complete (D30). */
  readonly parkedReason?: string;
  /** The local commit created once the ticket passed checks and review (D34). */
  readonly commit?: string;
  /** Each acceptance criterion's `classify` testability, as `plan write` asked it (issue #29). */
  readonly testability?: readonly CriterionTestability[];
}

/**
 * How `classify` classed one drafted criterion (D50): Jev's answer and
 * envelope, or why there was none, and the agent's evidenced reason where
 * it set an `untestable` answer aside (D6).
 */
export interface CriterionTestability {
  readonly criterion: string;
  readonly answer?: string;
  readonly envelope?: string;
  readonly route?: string;
  readonly unavailable?: string;
  readonly setAside?: { readonly reason: string; readonly evidence: readonly string[] };
}

export interface TicketsRecord {
  readonly tickets: readonly TicketRecord[];
}

export const AUTHORIZATION_SCOPES = ["ticket", "plan"] as const;

export type AuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number];

export interface ReconciliationDiscrepancy {
  readonly ticketId?: string;
  readonly summary: string;
  /** Consequential discrepancies go to the human rather than being reconciled silently (D15). */
  readonly consequential: boolean;
}

export const CHANGE_OWNERS = ["developer", "ticket"] as const;

export type ChangeOwner = (typeof CHANGE_OWNERS)[number];

/**
 * Who owns an uncommitted change that was already in the working tree
 * (issue #7): the developer, so jflow leaves it alone, or a ticket, which
 * adopts it. Recorded only on the developer's word, never inferred; jflow
 * never absorbs pre-existing changes silently.
 */
export type ChangeOwnership =
  | { readonly path: string; readonly owner: Extract<ChangeOwner, "developer">; readonly note: string }
  | {
      readonly path: string;
      readonly owner: Extract<ChangeOwner, "ticket">;
      readonly ticketId: string;
      readonly note: string;
    };

export const CRITERION_VERDICTS = ["met", "not-met", "insufficient-evidence"] as const;

export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];

/**
 * Who settled a criterion's verdict: Jev's binding answer, a fixed rule
 * (evidence that is only the implementer's claim), or an agent or the
 * developer setting Jev's answer aside with a recorded reason.
 */
export const VERDICT_SOURCES = ["jev", "rule", "agent", "developer"] as const;

export type VerdictSource = (typeof VERDICT_SOURCES)[number];

export interface CriterionJudgment {
  /** The criterion as accepted with the plan. */
  readonly criterion: string;
  readonly verdict: CriterionVerdict;
  readonly by: VerdictSource;
  readonly reasonCode?: string;
  readonly confidence?: number;
  /** The decision envelope the verdict came from, when Jev was asked. */
  readonly envelope?: string;
  /** Why a rule decided, or why Jev's answer was set aside. */
  readonly note?: string;
}

export const VALIDATION_DISPOSITIONS = [
  "returned-to-fix",
  "admitted-to-review",
  "needs-check",
  "awaiting-developer",
] as const;

export type ValidationDisposition = (typeof VALIDATION_DISPOSITIONS)[number];

/**
 * The `validate` gate's outcome for one ticket (D41, D47, issue #26): a
 * verdict per accepted criterion and the ticket's next state.
 */
export interface TicketValidation {
  readonly disposition: ValidationDisposition;
  readonly criteria: readonly CriterionJudgment[];
  /** The ticket's checks not yet run; what `needs-check` asks for. */
  readonly missingChecks: readonly string[];
  /** The escalate envelope asked when evidence was short and no check remained. */
  readonly escalation?: string;
  readonly validatedAt: string;
}

/**
 * What a review finding is (D33). The first three are confirmed violations
 * that block the ticket; an improvement is optional and becomes a todo.
 */
export const FINDING_KINDS = ["requirement", "correctness", "standard", "improvement"] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * Where a finding stands under D33's fixed rule, never a Jev classification
 * (D50): `blocking` holds the ticket, `todo` was filed without blocking it,
 * `withdrawn` was disputed and settled against the finding, and
 * `awaiting-developer` is a dispute the developer decides.
 */
export const FINDING_DISPOSITIONS = ["blocking", "todo", "withdrawn", "awaiting-developer"] as const;

export type FindingDisposition = (typeof FINDING_DISPOSITIONS)[number];

/** Who settled a disputed finding. */
export const DISPUTE_RESOLVERS = ["agent", "workflow", "developer"] as const;

export type DisputeResolver = (typeof DISPUTE_RESOLVERS)[number];

export interface FindingDispute {
  /** Why the implementer disputes the finding. */
  readonly reason: string;
  readonly evidence: readonly string[];
  /** The escalate envelope asked at `review-dispute`. */
  readonly escalation?: string;
  /** The conflict recorded when the dispute is consequential (D7). */
  readonly conflict?: string;
  readonly resolution?: {
    readonly by: DisputeResolver;
    /** The evidence-backed finding, or the developer's words. */
    readonly note: string;
    readonly evidence?: readonly string[];
  };
}

export interface ReviewFinding {
  readonly id: string;
  readonly kind: FindingKind;
  readonly summary: string;
  /** What the reviewer's finding rests on: file and line, command, criterion. */
  readonly evidence: readonly string[];
  readonly disposition: FindingDisposition;
  /** The todo an improvement was filed as. */
  readonly todo?: string;
  readonly dispute?: FindingDispute;
}

export const REVIEW_DISPOSITIONS = ["passed", "returned-to-fix", "awaiting-developer"] as const;

export type ReviewDisposition = (typeof REVIEW_DISPOSITIONS)[number];

/**
 * The latest review of one ticket (D31-D33, issue #9): who reviewed it, its
 * findings and their fixed-rule disposition, and the ticket's next state.
 */
/** The agent that reviewed a ticket, and the model it ran on. */
export interface Reviewer {
  readonly agent: string;
  readonly model?: string;
}

export interface TicketReview {
  /** Never an agent that implemented the ticket (D32). */
  readonly reviewer: Reviewer;
  readonly disposition: ReviewDisposition;
  readonly findings: readonly ReviewFinding[];
  readonly reviewedAt: string;
}

/**
 * Where the workflow stands: the acceptance gates, authorization, the
 * assigned ticket, fix attempts and resume reconciliation. This is the record
 * the action resolver's `WorkflowState` is derived from.
 */
export interface ProgressRecord {
  /** The human authorized execution; distinct from plan acceptance (user stories 7, 8). */
  readonly executionAuthorized: boolean;
  /** One ticket or the whole plan (D28, D29); present exactly when authorized. */
  readonly authorizationScope?: AuthorizationScope;
  /** The developer's words of authorization, recorded as said (D28). */
  readonly authorizationNote?: string;
  readonly assignedTicketId?: string;
  /** The assigned ticket has changes available to assess. */
  readonly ticketChangesPresent: boolean;
  /** Unsuccessful fix attempts per ticket, one shared counter (D48). */
  readonly fixAttempts?: Readonly<Record<string, number>>;
  /** The latest `validate` outcome per ticket (issue #26). */
  readonly validations?: Readonly<Record<string, TicketValidation>>;
  /** The stage workers, besides the primary agent, that worked on each ticket; none of them may review it (D32). */
  readonly implementers?: Readonly<Record<string, readonly string[]>>;
  /** The latest review per ticket (issue #9). */
  readonly reviews?: Readonly<Record<string, TicketReview>>;
  /** The latest review of the plan as a whole (issue #13). */
  readonly planReview?: PlanReview;
  /** The latest independence check per ticket that may start beside a parked one (issue #12). */
  readonly independenceChecks?: Readonly<Record<string, IndependenceCheck>>;
  /** Owners the developer gave pre-existing uncommitted changes, one entry per path. */
  readonly changeOwnership?: readonly ChangeOwnership[];
  readonly reconciliation?: {
    readonly lastReconciledAt?: string;
    readonly discrepancies: readonly ReconciliationDiscrepancy[];
  };
}

/**
 * The review of the plan as a whole (D9, issue #13). `integrated` is the
 * review across a multi-ticket plan's tickets, checking their interactions
 * and the plan's acceptance criteria; `single-ticket` records that a
 * one-ticket plan's ticket review covered both scopes.
 */
export const PLAN_REVIEW_SCOPES = ["integrated", "single-ticket"] as const;

export type PlanReviewScope = (typeof PLAN_REVIEW_SCOPES)[number];

export interface PlanReview extends TicketReview {
  readonly scope: PlanReviewScope;
  /** The tickets the review covered; it counts only while they are the plan's tickets. */
  readonly tickets: readonly string[];
  /** The ticket whose review covered the plan, for `single-ticket`. */
  readonly ticketId?: string;
}

/**
 * Why a ticket may start while others are parked (D30, issue #12): the
 * parked tickets it was checked against, and why neither their
 * dependencies, their unresolved decisions nor their partial edits affect
 * it.
 */
export interface IndependenceCheck {
  readonly parked: readonly string[];
  readonly dependencies: string;
  readonly decisions: string;
  readonly partialEdits: string;
  /** The parked tickets' uncommitted paths when the check was made. */
  readonly partialEditPaths: readonly string[];
  readonly checkedAt: string;
}

/**
 * Whether a ticket may be reviewed (D47, issue #9): its latest `validate`
 * found every criterion met, and it has not been reviewed since. A review
 * that returned it to fix clears the validation, so an all-met validation
 * after one is the fix's; a review that passed or waits for the developer
 * holds the ticket where it is.
 */
export function admittedToReview(progress: ProgressRecord, ticketId: string): boolean {
  const review = progress.reviews?.[ticketId]?.disposition;
  return (
    progress.validations?.[ticketId]?.disposition === "admitted-to-review" &&
    (review === undefined || review === "returned-to-fix")
  );
}

/** The progress record of a project where nothing has been authorized yet. */
export const EMPTY_PROGRESS: ProgressRecord = { executionAuthorized: false, ticketChangesPresent: false };

export const LESSON_STATUSES = ["candidate", "active", "superseded"] as const;

export type LessonStatus = (typeof LESSON_STATUSES)[number];

export interface LessonEvidence {
  /** What the reference points at; free text such as `commit`, `file`, `decision` or `trace`. */
  readonly kind: string;
  readonly reference: string;
}

/**
 * Jev's advisory `lesson-retention` answer as the lesson carries it: a
 * reference to its envelope and the answer's summary, or why there was none.
 */
export type LessonAdvice =
  | {
      readonly envelope: string;
      readonly answer: string;
      readonly reasonCode: string;
      /** `weigh`, or `ask-human` when the answer is not relied on. */
      readonly route: string;
    }
  | { readonly unavailable: string; readonly traceReference?: string };

export const LESSON_OUTCOMES = ["retained", "candidate"] as const;

export type LessonOutcome = (typeof LESSON_OUTCOMES)[number];

export const LESSON_DECIDERS = ["workflow", "agent", "developer"] as const;

export type LessonDecider = (typeof LESSON_DECIDERS)[number];

/** The decision recorded beside Jev's advice (D6, D21): retained, or kept a candidate. */
export interface LessonDecision {
  readonly outcome: LessonOutcome;
  readonly by: LessonDecider;
  /** Why; for the developer, their words. */
  readonly reason?: string;
  readonly evidence?: readonly string[];
  /** The agent's `jev assess` record, where Jev's answer was not relied on. */
  readonly assessment?: string;
  readonly decidedAt: string;
}

/** How `learn` assessed a lesson (issue #19). */
export interface LessonRetention {
  readonly advice: LessonAdvice;
  /** `classify`'s proposed scope (lesson-scope), beside the scope the agent gave (issue #29). */
  readonly scope?: LessonAdvice;
  /** Accepted decisions or retained lessons the lesson touches, by id. */
  readonly touches?: readonly string[];
  /**
   * A conflict with an accepted decision or retained lesson, asked through
   * `escalate` at `lesson-conflict`. `with` is empty when Jev raised it.
   * Whatever the outcome, the decision itself is never changed (D44).
   */
  readonly conflict?: { readonly with: readonly string[]; readonly escalation?: string };
  readonly decision?: LessonDecision;
}

export const LESSON_CHECK_OUTCOMES = ["applies", "skipped", "contradicted"] as const;

export type LessonCheckOutcome = (typeof LESSON_CHECK_OUTCOMES)[number];

/**
 * One re-check of a retained lesson against the task at hand (issue #20,
 * SPEC.md user story 56): it applies, it was skipped with the reason, or
 * new evidence contradicts it. `escalation` is the envelope of an
 * `escalate` asked because superseding it would change a human decision.
 */
export interface LessonCheck {
  readonly task: string;
  readonly outcome: LessonCheckOutcome;
  readonly reason: string;
  readonly evidence?: readonly string[];
  readonly escalation?: string;
  readonly checkedAt: string;
}

export interface LessonRecord {
  readonly id: string;
  readonly statement: string;
  /** Which part of the project the lesson applies to (D21, D50). */
  readonly scope: string;
  readonly evidence: readonly LessonEvidence[];
  /** Candidates are never applied; superseded lessons keep their evidence (D21). */
  readonly status: LessonStatus;
  readonly supersededBy?: string;
  readonly supersededEvidence?: string;
  readonly retention?: LessonRetention;
  /** Every applicability check, oldest first; kept after supersession as history. */
  readonly checks?: readonly LessonCheck[];
}

export interface LessonsRecord {
  readonly lessons: readonly LessonRecord[];
}

/** `plan` is only ever the developer's explicit broadening (D17, issue #18). */
export const FALLBACK_SCOPES = ["ticket", "stage", "plan"] as const;

export type FallbackScope = (typeof FALLBACK_SCOPES)[number];

/**
 * `off`: Jev is in normal use. `awaiting-approval`: retries are exhausted and
 * the pending decision waits for the human (D16). `approved`: the human
 * approved continuing without Jev for a recorded scope (D17).
 */
export const FALLBACK_STATUSES = ["off", "awaiting-approval", "approved"] as const;

export type FallbackStatus = (typeof FALLBACK_STATUSES)[number];

/** Whether the workflow is running without Jev, and under what approval (D16, D17). */
export interface JevRecord {
  readonly fallback: {
    readonly status: FallbackStatus;
    /** The declared decision that could not be answered; kept while awaiting input (D16). */
    readonly pendingDecision?: string;
    /** What failed; a summary, never the raw exchange (D23). */
    readonly reason?: string;
    readonly scope?: FallbackScope;
    /** The ticket id or stage name the approval covers. */
    readonly scopeId?: string;
    readonly approvedAt?: string;
    /** A reference to the local trace, never its content (D23). */
    readonly traceReference?: string;
    /** The developer's words of approval, recorded as said. */
    readonly approvalNote?: string;
  };
  /** Every change of fallback status, so leaving and returning to Jev is on record (issue #18). */
  readonly history?: readonly { readonly status: FallbackStatus; readonly at: string; readonly note: string }[];
  /** The primary agent's own assessments where Jev's answer was uncertain or unusable (issue #18). */
  readonly assessments?: readonly JevAssessment[];
}

export const ASSESSMENT_STATUSES = ["resolved", "escalated"] as const;

export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/**
 * The primary agent's evidence assessment where Jev gave no usable answer:
 * an uncertain one (its envelope) or none at all (the failure's trace).
 * `escalated` went to the developer under the escalation rules.
 */
export interface JevAssessment {
  readonly id: string;
  readonly decision: string;
  readonly envelope?: string;
  readonly traceReference?: string;
  readonly assessment: string;
  readonly evidence: readonly string[];
  readonly resolution: string;
  readonly consequential: boolean;
  readonly status: AssessmentStatus;
  readonly recordedAt: string;
}

export const DISCREPANCY_SOURCES = ["records", "agent"] as const;

export type DiscrepancySource = (typeof DISCREPANCY_SOURCES)[number];

/**
 * Where the records and the project disagree, as `wrap` found it: by
 * comparing the records with the repository, or by the agent's own
 * observation. Reported, never reconciled (D15).
 */
export interface ResumeDiscrepancy {
  readonly summary: string;
  readonly ticketId?: string;
  readonly source: DiscrepancySource;
}

/** A ticket's outcome as the session left it. */
export interface ResumeOutcome {
  readonly ticketId: string;
  readonly title: string;
  readonly status: TicketStatus;
  readonly commit?: string;
  /** Where the ticket in progress stands: fix attempts, validate and review. */
  readonly note?: string;
}

/** Lesson ids by state (issues #19, #20). */
export interface ResumeLessons {
  readonly active: readonly string[];
  /** Candidates: recorded, never applied, whether or not decided. */
  readonly candidates: readonly string[];
  /** The candidates still waiting for a decision (`learn decide`). */
  readonly undecided: readonly string[];
  /** Conflicting lessons waiting on the developer. */
  readonly awaitingDeveloper: readonly string[];
  /** Retained lessons that new evidence contradicted; re-check with evidence before use. */
  readonly contradicted: readonly string[];
  readonly superseded: readonly string[];
}

/**
 * What `wrap` leaves behind so the next session can resume without chat
 * history (D15, user story 18, issue #21). Everything but `summary` and
 * `nextSteps` is derived from the other records when it is written.
 */
export interface ResumeRecord {
  readonly writtenAt: string;
  readonly summary: string;
  readonly activeTicketId?: string;
  /** Open todos, each as `id: summary`. */
  readonly unresolvedTodos?: readonly string[];
  readonly nextSteps?: readonly string[];
  readonly plan?: {
    readonly title: string;
    readonly status: PlanStatus;
    readonly executionAuthorized: boolean;
    readonly authorizationScope?: AuthorizationScope;
    readonly authorizationNote?: string;
  };
  readonly outcomes?: readonly ResumeOutcome[];
  readonly parkedTickets?: readonly { readonly ticketId: string; readonly blocker: string }[];
  readonly lessons?: ResumeLessons;
  /** What `next` recommended when the session ended. */
  readonly recommendation?: { readonly action: string; readonly reason: string };
  /** Present while jflow runs without Jev or waits for approval to (D16, D17). */
  readonly jevFallback?: {
    readonly status: FallbackStatus;
    readonly pendingDecision?: string;
    readonly scope?: FallbackScope;
    readonly scopeId?: string;
  };
  /** Paths with uncommitted changes when the session ended; wrap commits none of them. */
  readonly uncommittedChanges?: readonly string[];
  readonly discrepancies?: readonly ResumeDiscrepancy[];
}

export const TODO_STATUSES = ["open", "promoted"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

/**
 * Future work captured outside the active plan (D26, issue #14). Recording
 * one authorizes nothing and adds no ticket; `promoted` records only that
 * the developer decided, in their words, to bring it into the plan, which
 * `plan` or `realign` then does.
 */
export interface TodoItem {
  readonly id: string;
  readonly summary: string;
  /** Context worth keeping with the item: where it was seen, how to reproduce it. */
  readonly detail?: string;
  /** The ticket assigned when the item was recorded, if any. */
  readonly discoveredDuring?: string;
  readonly recordedAt: string;
  readonly status: TodoStatus;
  readonly promotion?: { readonly decidedAt: string; readonly note: string };
  /** The `classify` item-routing answer this item was weighed against (issue #29); the item itself is the choice. */
  readonly routing?: { readonly envelope: string; readonly answer: string };
}

/** Where a realign recommendation came from: resume, a review, or the agent's own reading of the records. */
export const REALIGN_SOURCES = ["resume", "review", "agent"] as const;

export type RealignSource = (typeof REALIGN_SOURCES)[number];

export const RECOMMENDATION_STATUSES = ["open", "addressed"] as const;

export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/**
 * A recommendation to realign (D42, issue #31): recorded, never acted on.
 * Only the developer invokes realign; `addressed` names the realign they
 * ran that answered it.
 */
export interface RealignRecommendation {
  readonly id: string;
  readonly source: RealignSource;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly recordedAt: string;
  readonly status: RecommendationStatus;
  readonly addressedBy?: string;
}

export const TICKET_CHANGE_ACTIONS = ["rescope", "add", "park", "withdraw"] as const;

export type TicketChangeAction = (typeof TICKET_CHANGE_ACTIONS)[number];

/** One ticket a realign changed, and how. */
export interface TicketRealignment {
  readonly action: TicketChangeAction;
  readonly ticketId: string;
  /** Why it was parked or withdrawn. */
  readonly reason?: string;
  /** For a re-scope: whether its acceptance criteria changed, which re-validates a completed ticket. */
  readonly criteriaChanged?: boolean;
  /** The ticket's status before the realign; absent for an added ticket. */
  readonly statusBefore?: TicketStatus;
}

/** A completed ticket re-validated against its changed criteria, and the status that followed. */
export interface Revalidation {
  readonly ticketId: string;
  readonly disposition: ValidationDisposition;
  readonly status: TicketStatus;
}

/**
 * One in-flight plan change the developer invoked (D42): their direction
 * in their words, what changed, the completed tickets re-validated, and
 * the authorization that ended with it, since none carries over silently.
 */
export interface Realignment {
  readonly id: string;
  readonly direction: string;
  /** The developer's instruction, recorded as said. */
  readonly note: string;
  readonly changes: readonly TicketRealignment[];
  readonly revalidated: readonly Revalidation[];
  readonly specificationRevised: boolean;
  readonly priorAuthorization?: { readonly scope: AuthorizationScope; readonly note?: string };
  /** Recommendations this realign addressed. */
  readonly recommendations?: readonly string[];
  readonly realignedAt: string;
}

export interface RealignRecord {
  readonly recommendations: readonly RealignRecommendation[];
  readonly realignments: readonly Realignment[];
}

export interface TodosRecord {
  readonly items: readonly TodoItem[];
}

/** What a conflict touches that makes it consequential: the developer's to decide (D7). */
export const CONSEQUENTIAL_AREAS = ["requirements", "scope", "workflow-rules", "permissions"] as const;

export type ConsequentialArea = (typeof CONSEQUENTIAL_AREAS)[number];

export const CONFLICT_KINDS = ["consequential", "technical"] as const;

export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const CONFLICT_STATUSES = ["awaiting-developer", "resolved"] as const;

export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/**
 * A disagreement met during the work (D7, issue #17). A consequential one
 * touches requirements, scope, workflow rules or permissions and waits for
 * the developer; a technical one is settled by investigation, or waits for
 * the developer when investigation is inconclusive. Jev is never asked.
 */
export const CONFLICT_RESOLVERS = ["investigation", "developer"] as const;

export type ConflictResolver = (typeof CONFLICT_RESOLVERS)[number];

export interface ConflictEntry {
  readonly id: string;
  readonly summary: string;
  readonly kind: ConflictKind;
  /** Present exactly for a consequential conflict. */
  readonly touches?: readonly ConsequentialArea[];
  readonly recordedAt: string;
  readonly status: ConflictStatus;
  /** What the investigation found, kept even when it was inconclusive. */
  readonly investigation?: { readonly finding: string; readonly evidence: readonly string[] };
  readonly resolution?: {
    readonly by: ConflictResolver;
    /** The finding, or the developer's words. */
    readonly note: string;
    readonly evidence?: readonly string[];
    readonly resolvedAt: string;
  };
}

export interface ConflictsRecord {
  readonly conflicts: readonly ConflictEntry[];
}

export const DIAGNOSIS_STATUSES = ["diagnosing", "diagnosed", "applied"] as const;

export type DiagnosisStatus = (typeof DIAGNOSIS_STATUSES)[number];

/** Whether the helper confirmed troubleshoot left the working tree as it was; without Git it cannot. */
export const TREE_CHECKS = ["unchanged", "unverified"] as const;

export type TreeCheck = (typeof TREE_CHECKS)[number];

/** A changed path's content when troubleshooting began; no hash means it was deleted. */
export interface TreeEntry {
  readonly path: string;
  readonly sha256?: string;
}

/**
 * A failed check's diagnosis (D8, issue #11). `troubleshoot` records the
 * failure, a snapshot of the working tree, and then its finding, the
 * evidence and a recommended fix, having edited nothing. The fix itself is
 * made by an authorized `implement` and recorded as `applied`.
 */
export interface DiagnosisEntry {
  readonly id: string;
  /** The ticket whose check failed, if one was assigned. */
  readonly ticketId?: string;
  /** The failed check: its command, exit code and an excerpt of its output. */
  readonly check: { readonly source: string; readonly exitCode?: number; readonly excerpt: string };
  readonly status: DiagnosisStatus;
  readonly startedAt: string;
  /** The working tree when troubleshooting began; absent without a Git repository. */
  readonly baseline?: { readonly head?: string; readonly files: readonly TreeEntry[] };
  readonly diagnosis?: {
    readonly finding: string;
    readonly evidence: readonly string[];
    readonly recommendation: string;
    readonly recordedAt: string;
    readonly treeCheck: TreeCheck;
  };
  /** The authorized implement that applied the recommended fix. */
  readonly application?: { readonly ticketId: string; readonly appliedAt: string; readonly note?: string };
}

export interface DiagnosesRecord {
  readonly diagnoses: readonly DiagnosisEntry[];
}

export const WORKER_STATUSES = ["active", "finished"] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/**
 * A stage worker the primary agent assigned (D18-D20, issue #15): the
 * stage and declared role it worked in, and the model reported for it (the
 * helper cannot observe the host, so it records what the agent reports).
 * `substitution` records that the configured model was unavailable and the
 * explicitly configured fallback ran instead; nothing else may run.
 */
export interface WorkerAssignment {
  readonly id: string;
  readonly stage: string;
  readonly role: string;
  readonly agent: string;
  readonly ticketId?: string;
  /** The model the worker runs on, as the primary agent reported it. */
  readonly model: string;
  readonly substitution?: { readonly unavailableModel: string; readonly reason: string };
  /** The effort it runs at, one the stage configures (issue #28). */
  readonly effort?: string;
  /** The `model-selection` envelope the choice was recorded on, when one was asked. */
  readonly selection?: string;
  readonly status: WorkerStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

/**
 * A `model-selection` recommendation outside the stage's configured set,
 * rejected by the workflow (D49, issue #28). No worker starts on it.
 */
export interface RejectedRecommendation {
  readonly stage: string;
  readonly role: string;
  readonly ticketId?: string;
  readonly answer: string;
  /** The options Jev was given. */
  readonly options: readonly string[];
  /** The trace of the call that returned it. */
  readonly traceReference: string;
  readonly rejectedAt: string;
}

export interface WorkersRecord {
  readonly assignments: readonly WorkerAssignment[];
  readonly rejections?: readonly RejectedRecommendation[];
}

export interface ProjectRecords {
  readonly specification: SpecificationRecord;
  readonly plan: PlanRecord;
  readonly tickets: TicketsRecord;
  readonly progress: ProgressRecord;
  readonly lessons: LessonsRecord;
  readonly jev: JevRecord;
  readonly resume: ResumeRecord;
  readonly todos: TodosRecord;
  readonly conflicts: ConflictsRecord;
  readonly diagnoses: DiagnosesRecord;
  readonly workers: WorkersRecord;
  readonly realign: RealignRecord;
}

export type RecordReadResult<K extends RecordKind> =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly record: ProjectRecords[K] }
  | {
      /** A record exists but cannot be trusted; no record is offered in its place. */
      readonly kind: "malformed";
      readonly path: string;
      readonly issues: readonly ValidationIssue[];
    };

export class RecordValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(kind: RecordKind, issues: readonly ValidationIssue[]) {
    super(
      `Invalid jflow ${kind} record:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "RecordValidationError";
    this.issues = issues;
  }
}

export function recordPath(root: string, kind: RecordKind): string {
  return join(root, PROJECT_RECORD_DIRECTORY, `${kind}.json`);
}

type Validator<T> = (value: unknown, issues: IssueCollector) => T | undefined;

/**
 * Adds the optional fields of `T` that are defined, so an absent field stays
 * absent rather than becoming an explicit `undefined`
 * (exactOptionalPropertyTypes). `T` is passed explicitly at each call so a
 * misspelled or wrongly typed key is a compile error.
 */
function withOptional<T extends object>(
  base: T,
  extras: { readonly [K in keyof T]?: T[K] | undefined },
): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}

const validateSpecification: Validator<SpecificationRecord> = (value, issues) => {
  const doc = requireObject(
    value,
    "",
    [
      "title",
      "problem",
      "scenarios",
      "acceptanceCriteria",
      "constraints",
      "exclusions",
      "decisions",
      "status",
      "writtenAt",
      "acceptedAt",
      "acceptanceNote",
    ],
    issues,
  );
  if (!doc) return undefined;

  const decisions: SpecificationDecision[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(doc["decisions"])) {
    issues.add("decisions", "must be an array of decisions");
  } else {
    doc["decisions"].forEach((entry, index) => {
      const path = `decisions[${index}]`;
      const decision = requireObject(entry, path, ["id", "statement", "status", "basis"], issues);
      if (!decision) return;
      const id = requireNonEmptyString(decision["id"], `${path}.id`, issues);
      if (ids.has(id)) issues.add(`${path}.id`, `duplicate decision id "${id}"`);
      ids.add(id);
      decisions.push(
        withOptional<SpecificationDecision>(
          {
            id,
            statement: requireNonEmptyString(decision["statement"], `${path}.statement`, issues),
            status:
              validateEnumValue<DecisionStatus>(
                decision["status"],
                `${path}.status`,
                DECISION_STATUSES,
                issues,
              ) ?? "proposed",
          },
          { basis: optionalString(decision["basis"], `${path}.basis`, issues) },
        ),
      );
    });
  }

  const status = validateEnumValue<SpecificationStatus>(
    doc["status"],
    "status",
    SPECIFICATION_STATUSES,
    issues,
  );
  const acceptedAt = optionalTimestamp(doc["acceptedAt"], "acceptedAt", issues);
  // Acceptance is a recorded event (D27): an accepted specification says
  // when, and one still awaiting acceptance cannot carry that record.
  if (status === "accepted" && acceptedAt === undefined) {
    issues.add("acceptedAt", "an accepted specification must record when it was accepted");
  }
  if (status === "awaiting-acceptance" && acceptedAt !== undefined) {
    issues.add("acceptedAt", "must be absent while the specification awaits acceptance");
  }
  // What was accepted must be settled: a proposal still awaiting the
  // developer's confirmation cannot be part of an accepted specification.
  if (status === "accepted") {
    decisions.forEach((decision, index) => {
      if (decision.status === "proposed") {
        issues.add(
          `decisions[${index}].status`,
          `decision "${decision.id}" is still a proposal; confirm or reject it before accepting the specification`,
        );
      }
    });
  }

  const scenarios = validateStringArray(doc["scenarios"], "scenarios", issues);
  const acceptanceCriteria = validateStringArray(
    doc["acceptanceCriteria"],
    "acceptanceCriteria",
    issues,
  );
  if (Array.isArray(doc["scenarios"]) && scenarios.length === 0) {
    issues.add("scenarios", "a specification must describe at least one scenario");
  }
  if (Array.isArray(doc["acceptanceCriteria"]) && acceptanceCriteria.length === 0) {
    issues.add("acceptanceCriteria", "a specification must state at least one acceptance criterion");
  }

  return withOptional<SpecificationRecord>(
    {
      title: requireNonEmptyString(doc["title"], "title", issues),
      problem: requireNonEmptyString(doc["problem"], "problem", issues),
      scenarios,
      acceptanceCriteria,
      constraints: validateStringArray(doc["constraints"], "constraints", issues),
      exclusions: validateStringArray(doc["exclusions"], "exclusions", issues),
      decisions,
      status: status ?? "awaiting-acceptance",
      writtenAt: requireTimestamp(doc["writtenAt"], "writtenAt", issues),
    },
    {
      acceptedAt,
      acceptanceNote: optionalString(doc["acceptanceNote"], "acceptanceNote", issues),
    },
  );
};

const validatePlan: Validator<PlanRecord> = (value, issues) => {
  const doc = requireObject(
    value,
    "",
    ["title", "summary", "source", "status", "writtenAt", "acceptedAt", "acceptanceNote"],
    issues,
  );
  if (!doc) return undefined;
  const status = validateEnumValue<PlanStatus>(doc["status"], "status", PLAN_STATUSES, issues);
  const acceptedAt = optionalTimestamp(doc["acceptedAt"], "acceptedAt", issues);
  if (status === "accepted" && acceptedAt === undefined) {
    issues.add("acceptedAt", "an accepted plan must record when it was accepted");
  }
  if (status === "awaiting-acceptance" && acceptedAt !== undefined) {
    issues.add("acceptedAt", "must be absent while the plan awaits acceptance");
  }
  return withOptional<PlanRecord>(
    {
      title: requireNonEmptyString(doc["title"], "title", issues),
      summary: requireNonEmptyString(doc["summary"], "summary", issues),
      status: status ?? "awaiting-acceptance",
      writtenAt: requireTimestamp(doc["writtenAt"], "writtenAt", issues),
    },
    {
      source: optionalString(doc["source"], "source", issues),
      acceptedAt,
      acceptanceNote: optionalString(doc["acceptanceNote"], "acceptanceNote", issues),
    },
  );
};

const validateTickets: Validator<TicketsRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["tickets"], issues);
  if (!doc) return undefined;
  const list = doc["tickets"];
  if (!Array.isArray(list)) {
    issues.add("tickets", "must be an array of tickets");
    return undefined;
  }

  const tickets: TicketRecord[] = [];
  list.forEach((entry, index) => {
    const path = `tickets[${index}]`;
    const ticket = requireObject(
      entry,
      path,
      ["id", "title", "acceptanceCriteria", "dependsOn", "status", "parkedReason", "commit", "testability"],
      issues,
    );
    if (!ticket) return;
    const status = validateEnumValue<TicketStatus>(
      ticket["status"],
      `${path}.status`,
      TICKET_STATUSES,
      issues,
    );
    const parkedReason = optionalString(ticket["parkedReason"], `${path}.parkedReason`, issues);
    if (status === "parked" && parkedReason === undefined) {
      issues.add(`${path}.parkedReason`, "a parked ticket must record why it is parked");
    }
    // A ticket without acceptance criteria is not a valid ticket (D41).
    if (Array.isArray(ticket["acceptanceCriteria"]) && ticket["acceptanceCriteria"].length === 0) {
      issues.add(
        `${path}.acceptanceCriteria`,
        "a ticket must carry at least one acceptance criterion that validate can judge",
      );
    }
    tickets.push(
      withOptional<TicketRecord>(
        {
          id: requireNonEmptyString(ticket["id"], `${path}.id`, issues),
          title: requireNonEmptyString(ticket["title"], `${path}.title`, issues),
          acceptanceCriteria: validateStringArray(
            ticket["acceptanceCriteria"],
            `${path}.acceptanceCriteria`,
            issues,
          ),
          dependsOn: validateStringArray(ticket["dependsOn"], `${path}.dependsOn`, issues),
          status: status ?? "ready",
        },
        {
          parkedReason,
          commit: optionalString(ticket["commit"], `${path}.commit`, issues),
          testability: optionalList(ticket["testability"], `${path}.testability`, issues, (entry, itemPath) => {
            const item = requireObject(entry, itemPath, ["criterion", "answer", "envelope", "route", "unavailable", "setAside"], issues);
            if (!item) return undefined;
            let setAside: CriterionTestability["setAside"];
            if (item["setAside"] !== undefined) {
              const aside = requireObject(item["setAside"], `${itemPath}.setAside`, ["reason", "evidence"], issues);
              if (aside) {
                setAside = {
                  reason: requireNonEmptyString(aside["reason"], `${itemPath}.setAside.reason`, issues),
                  evidence: validateStringArray(aside["evidence"], `${itemPath}.setAside.evidence`, issues),
                };
              }
            }
            return withOptional<CriterionTestability>(
              { criterion: requireNonEmptyString(item["criterion"], `${itemPath}.criterion`, issues) },
              {
                answer: optionalString(item["answer"], `${itemPath}.answer`, issues),
                envelope: optionalString(item["envelope"], `${itemPath}.envelope`, issues),
                route: optionalString(item["route"], `${itemPath}.route`, issues),
                unavailable: optionalString(item["unavailable"], `${itemPath}.unavailable`, issues),
                setAside,
              },
            );
          }),
        },
      ),
    );
  });

  const ids = new Set<string>();
  tickets.forEach((ticket, index) => {
    if (ids.has(ticket.id)) {
      issues.add(`tickets[${index}].id`, `duplicate ticket id "${ticket.id}"`);
    }
    ids.add(ticket.id);
  });
  tickets.forEach((ticket, index) => {
    ticket.dependsOn.forEach((dependency, dependencyIndex) => {
      if (!ids.has(dependency)) {
        issues.add(
          `tickets[${index}].dependsOn[${dependencyIndex}]`,
          `depends on unknown ticket "${dependency}"`,
        );
      }
    });
  });

  return { tickets };
};

const validateProgress: Validator<ProgressRecord> = (value, issues) => {
  const doc = requireObject(
    value,
    "",
    [
      "executionAuthorized",
      "authorizationScope",
      "authorizationNote",
      "assignedTicketId",
      "ticketChangesPresent",
      "fixAttempts",
      "validations",
      "implementers",
      "reviews",
      "independenceChecks",
      "planReview",
      "changeOwnership",
      "reconciliation",
    ],
    issues,
  );
  if (!doc) return undefined;

  const executionAuthorized = requireBoolean(
    doc["executionAuthorized"],
    "executionAuthorized",
    issues,
  );
  const authorizationScope =
    doc["authorizationScope"] === undefined
      ? undefined
      : validateEnumValue<AuthorizationScope>(
          doc["authorizationScope"],
          "authorizationScope",
          AUTHORIZATION_SCOPES,
          issues,
        );
  // Authorization is always scoped to one ticket or the whole plan (D28,
  // D29); an unscoped authorization would be a silently broadened one.
  if (!executionAuthorized && authorizationScope !== undefined) {
    issues.add("authorizationScope", "must be absent when execution is not authorized");
  }
  if (executionAuthorized && doc["authorizationScope"] === undefined) {
    issues.add("authorizationScope", "an authorized execution must record its scope");
  }
  const authorizationNote = optionalString(doc["authorizationNote"], "authorizationNote", issues);
  if (!executionAuthorized && authorizationNote !== undefined) {
    issues.add("authorizationNote", "must be absent when execution is not authorized");
  }

  let fixAttempts: Record<string, number> | undefined;
  if (doc["fixAttempts"] !== undefined) {
    if (!isRecord(doc["fixAttempts"])) {
      issues.add("fixAttempts", "must be an object keyed by ticket id");
    } else {
      fixAttempts = {};
      for (const [ticketId, attempts] of Object.entries(doc["fixAttempts"])) {
        fixAttempts[ticketId] = requireIntegerInRange(
          attempts,
          `fixAttempts.${ticketId}`,
          0,
          issues,
        );
      }
    }
  }

  let validations: Record<string, TicketValidation> | undefined;
  if (doc["validations"] !== undefined) {
    if (!isRecord(doc["validations"])) {
      issues.add("validations", "must be an object keyed by ticket id");
    } else {
      validations = {};
      for (const [ticketId, entry] of Object.entries(doc["validations"])) {
        const validation = validateTicketValidation(entry, `validations.${ticketId}`, issues);
        if (validation) validations[ticketId] = validation;
      }
    }
  }

  let implementers: Record<string, string[]> | undefined;
  if (doc["implementers"] !== undefined) {
    if (!isRecord(doc["implementers"])) {
      issues.add("implementers", "must be an object keyed by ticket id");
    } else {
      implementers = {};
      for (const [ticketId, agents] of Object.entries(doc["implementers"])) {
        implementers[ticketId] = validateStringArray(agents, `implementers.${ticketId}`, issues);
      }
    }
  }

  let reviews: Record<string, TicketReview> | undefined;
  if (doc["reviews"] !== undefined) {
    if (!isRecord(doc["reviews"])) {
      issues.add("reviews", "must be an object keyed by ticket id");
    } else {
      reviews = {};
      for (const [ticketId, entry] of Object.entries(doc["reviews"])) {
        const review = validateTicketReview(entry, `reviews.${ticketId}`, issues);
        if (review) reviews[ticketId] = review;
      }
    }
  }

  let planReview: PlanReview | undefined;
  if (doc["planReview"] !== undefined) {
    if (!isRecord(doc["planReview"])) {
      issues.add("planReview", "must be an object");
    } else {
      const { scope: rawScope, ticketId: rawTicket, tickets: rawTickets, ...review } = doc["planReview"];
      const covered = validateStringArray(rawTickets, "planReview.tickets", issues);
      const scope = validateEnumValue<PlanReviewScope>(rawScope, "planReview.scope", PLAN_REVIEW_SCOPES, issues);
      const ticketId = optionalString(rawTicket, "planReview.ticketId", issues);
      if ((scope === "single-ticket") !== (ticketId !== undefined)) {
        issues.add("planReview.ticketId", "names the ticket exactly when a single-ticket review covered the plan");
      }
      const reviewed = validateTicketReview(review, "planReview", issues);
      if (reviewed && scope) {
        planReview = { ...reviewed, scope, tickets: covered, ...(ticketId === undefined ? {} : { ticketId }) };
      }
    }
  }

  let independenceChecks: Record<string, IndependenceCheck> | undefined;
  if (doc["independenceChecks"] !== undefined) {
    if (!isRecord(doc["independenceChecks"])) {
      issues.add("independenceChecks", "must be an object keyed by ticket id");
    } else {
      independenceChecks = {};
      for (const [ticketId, entry] of Object.entries(doc["independenceChecks"])) {
        const at = `independenceChecks.${ticketId}`;
        const item = requireObject(
          entry,
          at,
          ["parked", "dependencies", "decisions", "partialEdits", "partialEditPaths", "checkedAt"],
          issues,
        );
        if (!item) continue;
        independenceChecks[ticketId] = {
          parked: validateStringArray(item["parked"], `${at}.parked`, issues),
          dependencies: requireNonEmptyString(item["dependencies"], `${at}.dependencies`, issues),
          decisions: requireNonEmptyString(item["decisions"], `${at}.decisions`, issues),
          partialEdits: requireNonEmptyString(item["partialEdits"], `${at}.partialEdits`, issues),
          partialEditPaths: validateStringArray(item["partialEditPaths"], `${at}.partialEditPaths`, issues),
          checkedAt: requireTimestamp(item["checkedAt"], `${at}.checkedAt`, issues),
        };
      }
    }
  }

  let changeOwnership: ChangeOwnership[] | undefined;
  if (doc["changeOwnership"] !== undefined) {
    const claims: ChangeOwnership[] = [];
    changeOwnership = claims;
    if (!Array.isArray(doc["changeOwnership"])) {
      issues.add("changeOwnership", "must be an array of claimed changes");
    } else {
      const paths = new Set<string>();
      doc["changeOwnership"].forEach((entry, index) => {
        const path = `changeOwnership[${index}]`;
        const item = requireObject(entry, path, ["path", "owner", "ticketId", "note"], issues);
        if (!item) return;
        const changed = requireNonEmptyString(item["path"], `${path}.path`, issues);
        if (changed !== "") {
          if (paths.has(changed)) issues.add(`${path}.path`, `"${changed}" already has an owner`);
          paths.add(changed);
        }
        const owner = validateEnumValue<ChangeOwner>(item["owner"], `${path}.owner`, CHANGE_OWNERS, issues);
        const ticketId = optionalString(item["ticketId"], `${path}.ticketId`, issues);
        const note = requireNonEmptyString(item["note"], `${path}.note`, issues);
        if (owner === "ticket") {
          if (ticketId === undefined) {
            issues.add(`${path}.ticketId`, "a change adopted by a ticket must name the ticket");
            return;
          }
          claims.push({ path: changed, owner, ticketId, note });
        } else if (owner === "developer") {
          if (ticketId !== undefined) {
            issues.add(`${path}.ticketId`, "must be absent for a change the developer keeps");
          }
          claims.push({ path: changed, owner, note });
        }
      });
    }
  }

  let reconciliation: ProgressRecord["reconciliation"];
  if (doc["reconciliation"] !== undefined) {
    const rec = requireObject(
      doc["reconciliation"],
      "reconciliation",
      ["lastReconciledAt", "discrepancies"],
      issues,
    );
    if (rec) {
      const discrepancies: ReconciliationDiscrepancy[] = [];
      if (!Array.isArray(rec["discrepancies"])) {
        issues.add("reconciliation.discrepancies", "must be an array");
      } else {
        rec["discrepancies"].forEach((entry, index) => {
          const path = `reconciliation.discrepancies[${index}]`;
          const item = requireObject(entry, path, ["ticketId", "summary", "consequential"], issues);
          if (!item) return;
          discrepancies.push(
            withOptional<ReconciliationDiscrepancy>(
              {
                summary: requireNonEmptyString(item["summary"], `${path}.summary`, issues),
                consequential: requireBoolean(
                  item["consequential"],
                  `${path}.consequential`,
                  issues,
                ),
              },
              { ticketId: optionalString(item["ticketId"], `${path}.ticketId`, issues) },
            ),
          );
        });
      }
      reconciliation = withOptional<NonNullable<ProgressRecord["reconciliation"]>>(
        { discrepancies },
        {
          lastReconciledAt: optionalTimestamp(
            rec["lastReconciledAt"],
            "reconciliation.lastReconciledAt",
            issues,
          ),
        },
      );
    }
  }

  return withOptional<ProgressRecord>(
    {
      executionAuthorized,
      ticketChangesPresent: requireBoolean(
        doc["ticketChangesPresent"],
        "ticketChangesPresent",
        issues,
      ),
    },
    {
      authorizationScope,
      authorizationNote,
      assignedTicketId: optionalString(doc["assignedTicketId"], "assignedTicketId", issues),
      changeOwnership,
      fixAttempts,
      validations,
      implementers,
      reviews,
      independenceChecks,
      planReview,
      reconciliation,
    },
  );
};

function validateTicketValidation(
  value: unknown,
  path: string,
  issues: IssueCollector,
): TicketValidation | undefined {
  const doc = requireObject(value, path, ["disposition", "criteria", "missingChecks", "escalation", "validatedAt"], issues);
  if (!doc) return undefined;
  const criteria: CriterionJudgment[] = [];
  if (!Array.isArray(doc["criteria"]) || doc["criteria"].length === 0) {
    issues.add(`${path}.criteria`, "a validation must judge at least one criterion");
  } else {
    doc["criteria"].forEach((entry, index) => {
      const at = `${path}.criteria[${index}]`;
      const item = requireObject(
        entry,
        at,
        ["criterion", "verdict", "by", "reasonCode", "confidence", "envelope", "note"],
        issues,
      );
      if (!item) return;
      const confidence = item["confidence"];
      if (confidence !== undefined && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))) {
        issues.add(`${at}.confidence`, "must be a number from 0 to 1");
      }
      criteria.push(
        withOptional<CriterionJudgment>(
          {
            criterion: requireNonEmptyString(item["criterion"], `${at}.criterion`, issues),
            verdict:
              validateEnumValue<CriterionVerdict>(item["verdict"], `${at}.verdict`, CRITERION_VERDICTS, issues) ??
              "insufficient-evidence",
            by: validateEnumValue<VerdictSource>(item["by"], `${at}.by`, VERDICT_SOURCES, issues) ?? "rule",
          },
          {
            reasonCode: optionalString(item["reasonCode"], `${at}.reasonCode`, issues),
            confidence: typeof confidence === "number" ? confidence : undefined,
            envelope: optionalString(item["envelope"], `${at}.envelope`, issues),
            note: optionalString(item["note"], `${at}.note`, issues),
          },
        ),
      );
    });
  }
  return withOptional<TicketValidation>(
    {
      disposition: validateEnumValue<ValidationDisposition>(
        doc["disposition"],
        `${path}.disposition`,
        VALIDATION_DISPOSITIONS,
        issues,
      ) ?? "awaiting-developer",
      criteria,
      missingChecks: validateStringArray(doc["missingChecks"], `${path}.missingChecks`, issues),
      validatedAt: requireTimestamp(doc["validatedAt"], `${path}.validatedAt`, issues),
    },
    { escalation: optionalString(doc["escalation"], `${path}.escalation`, issues) },
  );
}

function validateTicketReview(value: unknown, path: string, issues: IssueCollector): TicketReview | undefined {
  const doc = requireObject(value, path, ["reviewer", "disposition", "findings", "reviewedAt"], issues);
  if (!doc) return undefined;
  const reviewer = requireObject(doc["reviewer"], `${path}.reviewer`, ["agent", "model"], issues);
  const findings: ReviewFinding[] = [];
  if (!Array.isArray(doc["findings"])) {
    issues.add(`${path}.findings`, "must be an array of findings");
  } else {
    doc["findings"].forEach((entry, index) => {
      const at = `${path}.findings[${index}]`;
      const item = requireObject(entry, at, ["id", "kind", "summary", "evidence", "disposition", "todo", "dispute"], issues);
      if (!item) return;
      findings.push(
        withOptional<ReviewFinding>(
          {
            id: requireNonEmptyString(item["id"], `${at}.id`, issues),
            kind: validateEnumValue<FindingKind>(item["kind"], `${at}.kind`, FINDING_KINDS, issues) ?? "requirement",
            summary: requireNonEmptyString(item["summary"], `${at}.summary`, issues),
            evidence: validateStringArray(item["evidence"], `${at}.evidence`, issues),
            disposition:
              validateEnumValue<FindingDisposition>(
                item["disposition"],
                `${at}.disposition`,
                FINDING_DISPOSITIONS,
                issues,
              ) ?? "blocking",
          },
          {
            todo: optionalString(item["todo"], `${at}.todo`, issues),
            dispute: item["dispute"] === undefined ? undefined : validateDispute(item["dispute"], `${at}.dispute`, issues),
          },
        ),
      );
    });
  }
  return {
    reviewer: reviewer
      ? withOptional<Reviewer>(
          { agent: requireNonEmptyString(reviewer["agent"], `${path}.reviewer.agent`, issues) },
          { model: optionalString(reviewer["model"], `${path}.reviewer.model`, issues) },
        )
      : { agent: "" },
    disposition:
      validateEnumValue<ReviewDisposition>(doc["disposition"], `${path}.disposition`, REVIEW_DISPOSITIONS, issues) ??
      "awaiting-developer",
    findings,
    reviewedAt: requireTimestamp(doc["reviewedAt"], `${path}.reviewedAt`, issues),
  };
}

function validateDispute(value: unknown, path: string, issues: IssueCollector): FindingDispute | undefined {
  const doc = requireObject(value, path, ["reason", "evidence", "escalation", "conflict", "resolution"], issues);
  if (!doc) return undefined;
  let resolution: FindingDispute["resolution"];
  if (doc["resolution"] !== undefined) {
    const item = requireObject(doc["resolution"], `${path}.resolution`, ["by", "note", "evidence"], issues);
    if (item) {
      resolution = withOptional<NonNullable<FindingDispute["resolution"]>>(
        {
          by:
            validateEnumValue<DisputeResolver>(item["by"], `${path}.resolution.by`, DISPUTE_RESOLVERS, issues) ??
            "developer",
          note: requireNonEmptyString(item["note"], `${path}.resolution.note`, issues),
        },
        { evidence: optionalStringArray(item["evidence"], `${path}.resolution.evidence`, issues) },
      );
    }
  }
  return withOptional<FindingDispute>(
    {
      reason: requireNonEmptyString(doc["reason"], `${path}.reason`, issues),
      evidence: validateStringArray(doc["evidence"], `${path}.evidence`, issues),
    },
    {
      escalation: optionalString(doc["escalation"], `${path}.escalation`, issues),
      conflict: optionalString(doc["conflict"], `${path}.conflict`, issues),
      resolution,
    },
  );
}

const validateLessons: Validator<LessonsRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["lessons"], issues);
  if (!doc) return undefined;
  const list = doc["lessons"];
  if (!Array.isArray(list)) {
    issues.add("lessons", "must be an array of lessons");
    return undefined;
  }

  const lessons: LessonRecord[] = [];
  const ids = new Set<string>();
  list.forEach((entry, index) => {
    const path = `lessons[${index}]`;
    const lesson = requireObject(
      entry,
      path,
      ["id", "statement", "scope", "evidence", "status", "supersededBy", "supersededEvidence", "retention", "checks"],
      issues,
    );
    if (!lesson) return;

    const evidence: LessonEvidence[] = [];
    if (!Array.isArray(lesson["evidence"]) || lesson["evidence"].length === 0) {
      issues.add(`${path}.evidence`, "a lesson must carry at least one evidence link");
    } else {
      lesson["evidence"].forEach((item, itemIndex) => {
        const itemPath = `${path}.evidence[${itemIndex}]`;
        const link = requireObject(item, itemPath, ["kind", "reference"], issues);
        if (!link) return;
        evidence.push({
          kind: requireNonEmptyString(link["kind"], `${itemPath}.kind`, issues),
          reference: requireNonEmptyString(link["reference"], `${itemPath}.reference`, issues),
        });
      });
    }

    const status = validateEnumValue<LessonStatus>(
      lesson["status"],
      `${path}.status`,
      LESSON_STATUSES,
      issues,
    );
    const supersededBy = optionalString(lesson["supersededBy"], `${path}.supersededBy`, issues);
    const supersededEvidence = optionalString(
      lesson["supersededEvidence"],
      `${path}.supersededEvidence`,
      issues,
    );
    // A contradicted lesson is marked superseded with evidence, never
    // silently overwritten (SPEC.md user story 56), so both fields are required.
    if (status === "superseded") {
      if (supersededBy === undefined) {
        issues.add(`${path}.supersededBy`, "a superseded lesson must name what superseded it");
      }
      if (supersededEvidence === undefined) {
        issues.add(`${path}.supersededEvidence`, "a superseded lesson must record the evidence");
      }
    } else if (supersededBy !== undefined || supersededEvidence !== undefined) {
      issues.add(`${path}.status`, "only a superseded lesson may carry supersession fields");
    }

    const retention =
      lesson["retention"] === undefined ? undefined : validateRetention(lesson["retention"], `${path}.retention`, issues);
    // A lesson `learn` assessed is active only on a decision to retain it, and
    // one decided to be a candidate is never active (D21).
    const outcome = retention?.decision?.outcome;
    if (status === "active" && retention !== undefined && outcome !== "retained") {
      issues.add(`${path}.status`, "an assessed lesson is active only once the decision to retain it is recorded");
    }
    if (status === "candidate" && outcome === "retained") {
      issues.add(`${path}.status`, "a lesson decided retained is not a candidate");
    }

    const id = requireNonEmptyString(lesson["id"], `${path}.id`, issues);
    if (ids.has(id)) issues.add(`${path}.id`, `duplicate lesson id "${id}"`);
    ids.add(id);

    lessons.push(
      withOptional<LessonRecord>(
        {
          id,
          statement: requireNonEmptyString(lesson["statement"], `${path}.statement`, issues),
          scope: requireNonEmptyString(lesson["scope"], `${path}.scope`, issues),
          evidence,
          status: status ?? "candidate",
        },
        { supersededBy, supersededEvidence, retention, checks: validateChecks(lesson["checks"], `${path}.checks`, issues) },
      ),
    );
  });

  return { lessons };
};

function validateChecks(value: unknown, path: string, issues: IssueCollector): LessonCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.add(path, "must be an array of applicability checks");
    return undefined;
  }
  const checks: LessonCheck[] = [];
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = requireObject(entry, itemPath, ["task", "outcome", "reason", "evidence", "escalation", "checkedAt"], issues);
    if (!item) return;
    checks.push(
      withOptional<LessonCheck>(
        {
          task: requireNonEmptyString(item["task"], `${itemPath}.task`, issues),
          outcome:
            validateEnumValue<LessonCheckOutcome>(item["outcome"], `${itemPath}.outcome`, LESSON_CHECK_OUTCOMES, issues) ??
            "skipped",
          reason: requireNonEmptyString(item["reason"], `${itemPath}.reason`, issues),
          checkedAt: requireTimestamp(item["checkedAt"], `${itemPath}.checkedAt`, issues),
        },
        {
          evidence: optionalStringArray(item["evidence"], `${itemPath}.evidence`, issues),
          escalation: optionalString(item["escalation"], `${itemPath}.escalation`, issues),
        },
      ),
    );
  });
  return checks;
}

function validateAdvice(value: unknown, path: string, issues: IssueCollector): LessonAdvice | undefined {
  const doc = requireObject(value, path, ["envelope", "answer", "reasonCode", "route", "unavailable", "traceReference"], issues);
  if (!doc) return undefined;
  if (doc["unavailable"] !== undefined) {
    if (doc["envelope"] !== undefined) issues.add(`${path}.envelope`, "advice that was unavailable has no envelope");
    return withOptional<Extract<LessonAdvice, { unavailable: string }>>(
      { unavailable: requireNonEmptyString(doc["unavailable"], `${path}.unavailable`, issues) },
      { traceReference: optionalString(doc["traceReference"], `${path}.traceReference`, issues) },
    );
  }
  return {
    envelope: requireNonEmptyString(doc["envelope"], `${path}.envelope`, issues),
    answer: requireNonEmptyString(doc["answer"], `${path}.answer`, issues),
    reasonCode: requireNonEmptyString(doc["reasonCode"], `${path}.reasonCode`, issues),
    route: requireNonEmptyString(doc["route"], `${path}.route`, issues),
  };
}

function validateRetention(value: unknown, path: string, issues: IssueCollector): LessonRetention | undefined {
  const doc = requireObject(value, path, ["advice", "scope", "touches", "conflict", "decision"], issues);
  if (!doc) return undefined;
  const advice = validateAdvice(doc["advice"], `${path}.advice`, issues);
  const scope = doc["scope"] === undefined ? undefined : validateAdvice(doc["scope"], `${path}.scope`, issues);

  let conflict: LessonRetention["conflict"];
  if (doc["conflict"] !== undefined) {
    const item = requireObject(doc["conflict"], `${path}.conflict`, ["with", "escalation"], issues);
    if (item) {
      conflict = withOptional<NonNullable<LessonRetention["conflict"]>>(
        { with: validateStringArray(item["with"], `${path}.conflict.with`, issues) },
        { escalation: optionalString(item["escalation"], `${path}.conflict.escalation`, issues) },
      );
    }
  }

  let decision: LessonDecision | undefined;
  if (doc["decision"] !== undefined) {
    const item = requireObject(
      doc["decision"],
      `${path}.decision`,
      ["outcome", "by", "reason", "evidence", "assessment", "decidedAt"],
      issues,
    );
    if (item) {
      decision = withOptional<LessonDecision>(
        {
          outcome:
            validateEnumValue<LessonOutcome>(item["outcome"], `${path}.decision.outcome`, LESSON_OUTCOMES, issues) ??
            "candidate",
          by: validateEnumValue<LessonDecider>(item["by"], `${path}.decision.by`, LESSON_DECIDERS, issues) ?? "developer",
          decidedAt: requireTimestamp(item["decidedAt"], `${path}.decision.decidedAt`, issues),
        },
        {
          reason: optionalString(item["reason"], `${path}.decision.reason`, issues),
          evidence: optionalStringArray(item["evidence"], `${path}.decision.evidence`, issues),
          assessment: optionalString(item["assessment"], `${path}.decision.assessment`, issues),
        },
      );
      if (decision.by === "developer" && decision.reason === undefined) {
        issues.add(`${path}.decision.reason`, "the developer's decision is recorded in their words");
      }
    }
  }
  if (advice === undefined) return undefined;
  return withOptional<LessonRetention>(
    { advice },
    { scope, touches: optionalStringArray(doc["touches"], `${path}.touches`, issues), conflict, decision },
  );
}

const validateJev: Validator<JevRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["fallback", "history", "assessments"], issues);
  if (!doc) return undefined;
  const fallback = requireObject(
    doc["fallback"],
    "fallback",
    ["status", "pendingDecision", "reason", "scope", "scopeId", "approvedAt", "traceReference", "approvalNote"],
    issues,
  );
  if (!fallback) return undefined;

  const status = validateEnumValue<FallbackStatus>(
    fallback["status"],
    "fallback.status",
    FALLBACK_STATUSES,
    issues,
  );
  const scope =
    fallback["scope"] === undefined
      ? undefined
      : validateEnumValue<FallbackScope>(fallback["scope"], "fallback.scope", FALLBACK_SCOPES, issues);
  const pendingDecision = optionalString(
    fallback["pendingDecision"],
    "fallback.pendingDecision",
    issues,
  );
  // The pending decision is preserved while the human is asked (D16), and
  // approval is always scoped (D17); an approval without a scope would be a
  // silently broadened one.
  if (status === "awaiting-approval" && pendingDecision === undefined) {
    issues.add("fallback.pendingDecision", "an awaited approval must name the pending decision");
  }
  if (status === "approved" && scope === undefined) {
    issues.add("fallback.scope", "an approved fallback must record the scope the human approved");
  }
  if (status === "off" && scope !== undefined) {
    issues.add("fallback.scope", "must be absent when no fallback is in effect");
  }
  const scopeId = optionalString(fallback["scopeId"], "fallback.scopeId", issues);
  // A ticket or stage approval names which one; the whole plan only by explicit broadening, naming none.
  if ((scope === "ticket" || scope === "stage") && scopeId === undefined) {
    issues.add("fallback.scopeId", `a ${scope}-scoped approval must name the ${scope}`);
  }
  if (scope === "plan" && scopeId !== undefined) issues.add("fallback.scopeId", "must be absent for the whole plan");

  let history: JevRecord["history"];
  if (doc["history"] !== undefined) {
    const entries: { status: FallbackStatus; at: string; note: string }[] = [];
    history = entries;
    if (!Array.isArray(doc["history"])) issues.add("history", "must be an array");
    else {
      doc["history"].forEach((entry, index) => {
        const at = `history[${index}]`;
        const item = requireObject(entry, at, ["status", "at", "note"], issues);
        if (!item) return;
        entries.push({
          status: validateEnumValue<FallbackStatus>(item["status"], `${at}.status`, FALLBACK_STATUSES, issues) ?? "off",
          at: requireTimestamp(item["at"], `${at}.at`, issues),
          note: requireNonEmptyString(item["note"], `${at}.note`, issues),
        });
      });
    }
  }

  let assessments: JevAssessment[] | undefined;
  if (doc["assessments"] !== undefined) {
    const entries: JevAssessment[] = [];
    assessments = entries;
    if (!Array.isArray(doc["assessments"])) issues.add("assessments", "must be an array");
    else {
      doc["assessments"].forEach((entry, index) => {
        const at = `assessments[${index}]`;
        const item = requireObject(
          entry,
          at,
          ["id", "decision", "envelope", "traceReference", "assessment", "evidence", "resolution", "consequential", "status", "recordedAt"],
          issues,
        );
        if (!item) return;
        const evidence = validateStringArray(item["evidence"], `${at}.evidence`, issues);
        if (evidence.length === 0) issues.add(`${at}.evidence`, "an assessment rests on evidence");
        entries.push(
          withOptional<JevAssessment>(
            {
              id: requireNonEmptyString(item["id"], `${at}.id`, issues),
              decision: requireNonEmptyString(item["decision"], `${at}.decision`, issues),
              assessment: requireNonEmptyString(item["assessment"], `${at}.assessment`, issues),
              evidence,
              resolution: requireNonEmptyString(item["resolution"], `${at}.resolution`, issues),
              consequential: requireBoolean(item["consequential"], `${at}.consequential`, issues),
              status:
                validateEnumValue<AssessmentStatus>(item["status"], `${at}.status`, ASSESSMENT_STATUSES, issues) ?? "escalated",
              recordedAt: requireTimestamp(item["recordedAt"], `${at}.recordedAt`, issues),
            },
            {
              envelope: optionalString(item["envelope"], `${at}.envelope`, issues),
              traceReference: optionalString(item["traceReference"], `${at}.traceReference`, issues),
            },
          ),
        );
      });
    }
  }

  return {
    fallback: withOptional<JevRecord["fallback"]>(
      { status: status ?? "off" },
      {
        pendingDecision,
        reason: optionalString(fallback["reason"], "fallback.reason", issues),
        scope,
        scopeId,
        approvedAt: optionalTimestamp(fallback["approvedAt"], "fallback.approvedAt", issues),
        traceReference: optionalString(
          fallback["traceReference"],
          "fallback.traceReference",
          issues,
        ),
        approvalNote: optionalString(fallback["approvalNote"], "fallback.approvalNote", issues),
      },
    ),
    ...(history === undefined ? {} : { history }),
    ...(assessments === undefined ? {} : { assessments }),
  };
};

const validateResume: Validator<ResumeRecord> = (value, issues) => {
  const doc = requireObject(
    value,
    "",
    [
      "writtenAt",
      "summary",
      "activeTicketId",
      "unresolvedTodos",
      "nextSteps",
      "plan",
      "outcomes",
      "parkedTickets",
      "lessons",
      "recommendation",
      "jevFallback",
      "uncommittedChanges",
      "discrepancies",
    ],
    issues,
  );
  if (!doc) return undefined;

  let jevFallback: ResumeRecord["jevFallback"];
  if (doc["jevFallback"] !== undefined) {
    const item = requireObject(doc["jevFallback"], "jevFallback", ["status", "pendingDecision", "scope", "scopeId"], issues);
    if (item) {
      jevFallback = withOptional<NonNullable<ResumeRecord["jevFallback"]>>(
        {
          status: validateEnumValue<FallbackStatus>(item["status"], "jevFallback.status", FALLBACK_STATUSES, issues) ?? "off",
        },
        {
          pendingDecision: optionalString(item["pendingDecision"], "jevFallback.pendingDecision", issues),
          scope:
            item["scope"] === undefined
              ? undefined
              : validateEnumValue<FallbackScope>(item["scope"], "jevFallback.scope", FALLBACK_SCOPES, issues),
          scopeId: optionalString(item["scopeId"], "jevFallback.scopeId", issues),
        },
      );
    }
  }

  let plan: ResumeRecord["plan"];
  if (doc["plan"] !== undefined) {
    const item = requireObject(
      doc["plan"],
      "plan",
      ["title", "status", "executionAuthorized", "authorizationScope", "authorizationNote"],
      issues,
    );
    if (item) {
      plan = withOptional<NonNullable<ResumeRecord["plan"]>>(
        {
          title: requireNonEmptyString(item["title"], "plan.title", issues),
          status: validateEnumValue<PlanStatus>(item["status"], "plan.status", PLAN_STATUSES, issues) ?? "awaiting-acceptance",
          executionAuthorized: requireBoolean(item["executionAuthorized"], "plan.executionAuthorized", issues),
        },
        {
          authorizationScope:
            item["authorizationScope"] === undefined
              ? undefined
              : validateEnumValue<AuthorizationScope>(
                  item["authorizationScope"],
                  "plan.authorizationScope",
                  AUTHORIZATION_SCOPES,
                  issues,
                ),
          authorizationNote: optionalString(item["authorizationNote"], "plan.authorizationNote", issues),
        },
      );
    }
  }

  const outcomes = optionalList(doc["outcomes"], "outcomes", issues, (entry, path) => {
    const item = requireObject(entry, path, ["ticketId", "title", "status", "commit", "note"], issues);
    if (!item) return undefined;
    return withOptional<ResumeOutcome>(
      {
        ticketId: requireNonEmptyString(item["ticketId"], `${path}.ticketId`, issues),
        title: requireNonEmptyString(item["title"], `${path}.title`, issues),
        status: validateEnumValue<TicketStatus>(item["status"], `${path}.status`, TICKET_STATUSES, issues) ?? "ready",
      },
      {
        commit: optionalString(item["commit"], `${path}.commit`, issues),
        note: optionalString(item["note"], `${path}.note`, issues),
      },
    );
  });

  const parkedTickets = optionalList(doc["parkedTickets"], "parkedTickets", issues, (entry, path) => {
    const item = requireObject(entry, path, ["ticketId", "blocker"], issues);
    if (!item) return undefined;
    return {
      ticketId: requireNonEmptyString(item["ticketId"], `${path}.ticketId`, issues),
      blocker: requireNonEmptyString(item["blocker"], `${path}.blocker`, issues),
    };
  });

  let lessons: ResumeLessons | undefined;
  if (doc["lessons"] !== undefined) {
    const item = requireObject(
      doc["lessons"],
      "lessons",
      ["active", "candidates", "undecided", "awaitingDeveloper", "contradicted", "superseded"],
      issues,
    );
    if (item) {
      lessons = {
        active: validateStringArray(item["active"], "lessons.active", issues),
        candidates: validateStringArray(item["candidates"], "lessons.candidates", issues),
        undecided: validateStringArray(item["undecided"], "lessons.undecided", issues),
        awaitingDeveloper: validateStringArray(item["awaitingDeveloper"], "lessons.awaitingDeveloper", issues),
        contradicted: validateStringArray(item["contradicted"], "lessons.contradicted", issues),
        superseded: validateStringArray(item["superseded"], "lessons.superseded", issues),
      };
    }
  }

  let recommendation: ResumeRecord["recommendation"];
  if (doc["recommendation"] !== undefined) {
    const item = requireObject(doc["recommendation"], "recommendation", ["action", "reason"], issues);
    if (item) {
      recommendation = {
        action: requireNonEmptyString(item["action"], "recommendation.action", issues),
        reason: requireNonEmptyString(item["reason"], "recommendation.reason", issues),
      };
    }
  }

  const discrepancies = optionalList(doc["discrepancies"], "discrepancies", issues, (entry, path) => {
    const item = requireObject(entry, path, ["summary", "ticketId", "source"], issues);
    if (!item) return undefined;
    return withOptional<ResumeDiscrepancy>(
      {
        summary: requireNonEmptyString(item["summary"], `${path}.summary`, issues),
        source:
          validateEnumValue<DiscrepancySource>(item["source"], `${path}.source`, DISCREPANCY_SOURCES, issues) ?? "agent",
      },
      { ticketId: optionalString(item["ticketId"], `${path}.ticketId`, issues) },
    );
  });

  return withOptional<ResumeRecord>(
    {
      writtenAt: requireTimestamp(doc["writtenAt"], "writtenAt", issues),
      summary: requireNonEmptyString(doc["summary"], "summary", issues),
    },
    {
      activeTicketId: optionalString(doc["activeTicketId"], "activeTicketId", issues),
      unresolvedTodos: optionalStringArray(doc["unresolvedTodos"], "unresolvedTodos", issues),
      nextSteps: optionalStringArray(doc["nextSteps"], "nextSteps", issues),
      plan,
      outcomes,
      parkedTickets,
      lessons,
      recommendation,
      jevFallback,
      uncommittedChanges: optionalStringArray(doc["uncommittedChanges"], "uncommittedChanges", issues),
      discrepancies,
    },
  );
};

/** An optional array whose entries are each validated; absent stays absent. */
function optionalList<T>(
  value: unknown,
  path: string,
  issues: IssueCollector,
  entry: (item: unknown, path: string) => T | undefined,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.add(path, "must be an array");
    return undefined;
  }
  return value.flatMap((item, index) => {
    const validated = entry(item, `${path}[${index}]`);
    return validated === undefined ? [] : [validated];
  });
}

function validateRouting(value: unknown, path: string, issues: IssueCollector): TodoItem["routing"] {
  if (value === undefined) return undefined;
  const item = requireObject(value, path, ["envelope", "answer"], issues);
  if (!item) return undefined;
  return {
    envelope: requireNonEmptyString(item["envelope"], `${path}.envelope`, issues),
    answer: requireNonEmptyString(item["answer"], `${path}.answer`, issues),
  };
}

const validateTodos: Validator<TodosRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["items"], issues);
  if (!doc) return undefined;
  const items: TodoItem[] = [];
  if (!Array.isArray(doc["items"])) {
    issues.add("items", "must be an array of todo items");
    return { items };
  }
  const ids = new Set<string>();
  doc["items"].forEach((entry, index) => {
    const path = `items[${index}]`;
    const item = requireObject(
      entry,
      path,
      ["id", "summary", "detail", "discoveredDuring", "recordedAt", "status", "promotion", "routing"],
      issues,
    );
    if (!item) return;
    const id = requireNonEmptyString(item["id"], `${path}.id`, issues);
    if (ids.has(id)) issues.add(`${path}.id`, `duplicate todo id "${id}"`);
    ids.add(id);
    const status = validateEnumValue<TodoStatus>(item["status"], `${path}.status`, TODO_STATUSES, issues);

    // Promotion is a recorded decision (D26): a promoted item says when and
    // in what words, and an open one cannot carry that record.
    let promotion: TodoItem["promotion"];
    if (item["promotion"] !== undefined) {
      const decided = requireObject(item["promotion"], `${path}.promotion`, ["decidedAt", "note"], issues);
      if (decided) {
        promotion = {
          decidedAt: requireTimestamp(decided["decidedAt"], `${path}.promotion.decidedAt`, issues),
          note: requireNonEmptyString(decided["note"], `${path}.promotion.note`, issues),
        };
      }
    }
    if (status === "promoted" && item["promotion"] === undefined) {
      issues.add(`${path}.promotion`, "a promoted todo must record the developer's decision");
    }
    if (status === "open" && item["promotion"] !== undefined) {
      issues.add(`${path}.promotion`, "must be absent while the todo is open");
    }

    items.push(
      withOptional<TodoItem>(
        {
          id,
          summary: requireNonEmptyString(item["summary"], `${path}.summary`, issues),
          recordedAt: requireTimestamp(item["recordedAt"], `${path}.recordedAt`, issues),
          status: status ?? "open",
        },
        {
          detail: optionalString(item["detail"], `${path}.detail`, issues),
          discoveredDuring: optionalString(item["discoveredDuring"], `${path}.discoveredDuring`, issues),
          promotion,
          routing: validateRouting(item["routing"], `${path}.routing`, issues),
        },
      ),
    );
  });
  return { items };
};

const validateConflicts: Validator<ConflictsRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["conflicts"], issues);
  if (!doc) return undefined;
  const conflicts: ConflictEntry[] = [];
  if (!Array.isArray(doc["conflicts"])) {
    issues.add("conflicts", "must be an array of conflicts");
    return { conflicts };
  }
  const ids = new Set<string>();
  doc["conflicts"].forEach((entry, index) => {
    const path = `conflicts[${index}]`;
    const conflict = requireObject(
      entry,
      path,
      ["id", "summary", "kind", "touches", "recordedAt", "status", "investigation", "resolution"],
      issues,
    );
    if (!conflict) return;
    const id = requireNonEmptyString(conflict["id"], `${path}.id`, issues);
    if (ids.has(id)) issues.add(`${path}.id`, `duplicate conflict id "${id}"`);
    ids.add(id);
    const kind = validateEnumValue<ConflictKind>(conflict["kind"], `${path}.kind`, CONFLICT_KINDS, issues);
    const status = validateEnumValue<ConflictStatus>(conflict["status"], `${path}.status`, CONFLICT_STATUSES, issues);

    let touches: ConsequentialArea[] | undefined;
    if (conflict["touches"] !== undefined) {
      touches = validateStringArray(conflict["touches"], `${path}.touches`, issues).filter(
        (area, areaIndex): area is ConsequentialArea =>
          validateEnumValue(area, `${path}.touches[${areaIndex}]`, CONSEQUENTIAL_AREAS, issues) !== undefined,
      );
    }
    // Consequential means it touches something only the developer changes (D7).
    if (kind === "consequential" && (touches === undefined || touches.length === 0)) {
      issues.add(`${path}.touches`, "a consequential conflict names what it touches");
    }
    if (kind === "technical" && touches !== undefined) {
      issues.add(`${path}.touches`, "must be absent for a technical conflict");
    }

    let investigation: ConflictEntry["investigation"];
    if (conflict["investigation"] !== undefined) {
      const found = requireObject(conflict["investigation"], `${path}.investigation`, ["finding", "evidence"], issues);
      if (found) {
        investigation = {
          finding: requireNonEmptyString(found["finding"], `${path}.investigation.finding`, issues),
          evidence: validateStringArray(found["evidence"], `${path}.investigation.evidence`, issues),
        };
      }
    }

    let resolution: ConflictEntry["resolution"];
    if (conflict["resolution"] !== undefined) {
      const resolved = requireObject(
        conflict["resolution"],
        `${path}.resolution`,
        ["by", "note", "evidence", "resolvedAt"],
        issues,
      );
      if (resolved) {
        const by = validateEnumValue<ConflictResolver>(resolved["by"], `${path}.resolution.by`, CONFLICT_RESOLVERS, issues);
        resolution = withOptional<NonNullable<ConflictEntry["resolution"]>>(
          {
            by: by ?? "developer",
            note: requireNonEmptyString(resolved["note"], `${path}.resolution.note`, issues),
            resolvedAt: requireTimestamp(resolved["resolvedAt"], `${path}.resolution.resolvedAt`, issues),
          },
          { evidence: optionalStringArray(resolved["evidence"], `${path}.resolution.evidence`, issues) },
        );
        // Investigation settles only technical disagreements (D7).
        if (by === "investigation" && kind === "consequential") {
          issues.add(`${path}.resolution.by`, "a consequential conflict is resolved by the developer");
        }
      }
    }
    if (status === "resolved" && resolution === undefined) {
      issues.add(`${path}.resolution`, "a resolved conflict records how it was resolved");
    }
    if (status === "awaiting-developer" && conflict["resolution"] !== undefined) {
      issues.add(`${path}.resolution`, "must be absent while the conflict awaits the developer");
    }

    conflicts.push(
      withOptional<ConflictEntry>(
        {
          id,
          summary: requireNonEmptyString(conflict["summary"], `${path}.summary`, issues),
          kind: kind ?? "consequential",
          recordedAt: requireTimestamp(conflict["recordedAt"], `${path}.recordedAt`, issues),
          status: status ?? "awaiting-developer",
        },
        { touches, investigation, resolution },
      ),
    );
  });
  return { conflicts };
};

const validateDiagnoses: Validator<DiagnosesRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["diagnoses"], issues);
  if (!doc) return undefined;
  const diagnoses: DiagnosisEntry[] = [];
  if (!Array.isArray(doc["diagnoses"])) {
    issues.add("diagnoses", "must be an array of diagnoses");
    return { diagnoses };
  }
  const ids = new Set<string>();
  doc["diagnoses"].forEach((entry, index) => {
    const path = `diagnoses[${index}]`;
    const item = requireObject(
      entry,
      path,
      ["id", "ticketId", "check", "status", "startedAt", "baseline", "diagnosis", "application"],
      issues,
    );
    if (!item) return;
    const id = requireNonEmptyString(item["id"], `${path}.id`, issues);
    if (ids.has(id)) issues.add(`${path}.id`, `duplicate diagnosis id "${id}"`);
    ids.add(id);
    const status =
      validateEnumValue<DiagnosisStatus>(item["status"], `${path}.status`, DIAGNOSIS_STATUSES, issues) ?? "diagnosing";

    const check = requireObject(item["check"], `${path}.check`, ["source", "exitCode", "excerpt"], issues);
    const exitCode = check?.["exitCode"];
    if (exitCode !== undefined && !Number.isInteger(exitCode)) issues.add(`${path}.check.exitCode`, "must be an integer");

    let baseline: DiagnosisEntry["baseline"];
    if (item["baseline"] !== undefined) {
      const tree = requireObject(item["baseline"], `${path}.baseline`, ["head", "files"], issues);
      if (tree) {
        const files: TreeEntry[] = [];
        if (!Array.isArray(tree["files"])) issues.add(`${path}.baseline.files`, "must be an array");
        else {
          tree["files"].forEach((file, fileIndex) => {
            const at = `${path}.baseline.files[${fileIndex}]`;
            const f = requireObject(file, at, ["path", "sha256"], issues);
            if (!f) return;
            files.push(
              withOptional<TreeEntry>(
                { path: requireNonEmptyString(f["path"], `${at}.path`, issues) },
                { sha256: optionalString(f["sha256"], `${at}.sha256`, issues) },
              ),
            );
          });
        }
        baseline = withOptional<NonNullable<DiagnosisEntry["baseline"]>>(
          { files },
          { head: optionalString(tree["head"], `${path}.baseline.head`, issues) },
        );
      }
    }

    let diagnosis: DiagnosisEntry["diagnosis"];
    if (item["diagnosis"] !== undefined) {
      const d = requireObject(
        item["diagnosis"],
        `${path}.diagnosis`,
        ["finding", "evidence", "recommendation", "recordedAt", "treeCheck"],
        issues,
      );
      if (d) {
        const treeCheck =
          validateEnumValue<TreeCheck>(d["treeCheck"], `${path}.diagnosis.treeCheck`, TREE_CHECKS, issues) ?? "unverified";
        diagnosis = {
          finding: requireNonEmptyString(d["finding"], `${path}.diagnosis.finding`, issues),
          evidence: validateStringArray(d["evidence"], `${path}.diagnosis.evidence`, issues),
          recommendation: requireNonEmptyString(d["recommendation"], `${path}.diagnosis.recommendation`, issues),
          recordedAt: requireTimestamp(d["recordedAt"], `${path}.diagnosis.recordedAt`, issues),
          treeCheck,
        };
      }
    }
    if (status !== "diagnosing" && diagnosis === undefined) {
      issues.add(`${path}.diagnosis`, "a diagnosed or applied entry must record its diagnosis");
    }

    let application: DiagnosisEntry["application"];
    if (item["application"] !== undefined) {
      const a = requireObject(item["application"], `${path}.application`, ["ticketId", "appliedAt", "note"], issues);
      if (a) {
        application = withOptional<NonNullable<DiagnosisEntry["application"]>>(
          {
            ticketId: requireNonEmptyString(a["ticketId"], `${path}.application.ticketId`, issues),
            appliedAt: requireTimestamp(a["appliedAt"], `${path}.application.appliedAt`, issues),
          },
          { note: optionalString(a["note"], `${path}.application.note`, issues) },
        );
      }
    }
    if ((status === "applied") !== (application !== undefined)) {
      issues.add(`${path}.application`, "must be present exactly when the fix was applied");
    }

    diagnoses.push(
      withOptional<DiagnosisEntry>(
        {
          id,
          check: withOptional<DiagnosisEntry["check"]>(
            {
              source: requireNonEmptyString(check?.["source"], `${path}.check.source`, issues),
              excerpt: typeof check?.["excerpt"] === "string" ? check["excerpt"] : "",
            },
            { exitCode: typeof exitCode === "number" ? exitCode : undefined },
          ),
          status,
          startedAt: requireTimestamp(item["startedAt"], `${path}.startedAt`, issues),
        },
        {
          ticketId: optionalString(item["ticketId"], `${path}.ticketId`, issues),
          baseline,
          diagnosis,
          application,
        },
      ),
    );
  });
  return { diagnoses };
};

const validateWorkers: Validator<WorkersRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["assignments", "rejections"], issues);
  if (!doc) return undefined;
  const assignments: WorkerAssignment[] = [];
  if (!Array.isArray(doc["assignments"])) {
    issues.add("assignments", "must be an array of worker assignments");
    return { assignments };
  }
  const ids = new Set<string>();
  doc["assignments"].forEach((entry, index) => {
    const path = `assignments[${index}]`;
    const item = requireObject(
      entry,
      path,
      ["id", "stage", "role", "agent", "ticketId", "model", "substitution", "effort", "selection", "status", "startedAt", "finishedAt"],
      issues,
    );
    if (!item) return;
    const id = requireNonEmptyString(item["id"], `${path}.id`, issues);
    if (ids.has(id)) issues.add(`${path}.id`, `duplicate assignment id "${id}"`);
    ids.add(id);
    const status = validateEnumValue<WorkerStatus>(item["status"], `${path}.status`, WORKER_STATUSES, issues) ?? "active";
    const finishedAt = optionalTimestamp(item["finishedAt"], `${path}.finishedAt`, issues);
    if ((status === "finished") !== (finishedAt !== undefined)) {
      issues.add(`${path}.finishedAt`, "must be present exactly when the worker has finished");
    }
    let substitution: WorkerAssignment["substitution"];
    if (item["substitution"] !== undefined) {
      const sub = requireObject(item["substitution"], `${path}.substitution`, ["unavailableModel", "reason"], issues);
      if (sub) {
        substitution = {
          unavailableModel: requireNonEmptyString(sub["unavailableModel"], `${path}.substitution.unavailableModel`, issues),
          reason: requireNonEmptyString(sub["reason"], `${path}.substitution.reason`, issues),
        };
      }
    }
    assignments.push(
      withOptional<WorkerAssignment>(
        {
          id,
          stage: requireNonEmptyString(item["stage"], `${path}.stage`, issues),
          role: requireNonEmptyString(item["role"], `${path}.role`, issues),
          agent: requireNonEmptyString(item["agent"], `${path}.agent`, issues),
          model: requireNonEmptyString(item["model"], `${path}.model`, issues),
          status,
          startedAt: requireTimestamp(item["startedAt"], `${path}.startedAt`, issues),
        },
        {
          ticketId: optionalString(item["ticketId"], `${path}.ticketId`, issues),
          substitution,
          effort: optionalString(item["effort"], `${path}.effort`, issues),
          selection: optionalString(item["selection"], `${path}.selection`, issues),
          finishedAt,
        },
      ),
    );
  });
  const rejections = optionalList(doc["rejections"], "rejections", issues, (entry, path) => {
    const item = requireObject(entry, path, ["stage", "role", "ticketId", "answer", "options", "traceReference", "rejectedAt"], issues);
    if (!item) return undefined;
    return withOptional<RejectedRecommendation>(
      {
        stage: requireNonEmptyString(item["stage"], `${path}.stage`, issues),
        role: requireNonEmptyString(item["role"], `${path}.role`, issues),
        answer: requireNonEmptyString(item["answer"], `${path}.answer`, issues),
        options: validateStringArray(item["options"], `${path}.options`, issues),
        traceReference: requireNonEmptyString(item["traceReference"], `${path}.traceReference`, issues),
        rejectedAt: requireTimestamp(item["rejectedAt"], `${path}.rejectedAt`, issues),
      },
      { ticketId: optionalString(item["ticketId"], `${path}.ticketId`, issues) },
    );
  });
  return rejections === undefined ? { assignments } : { assignments, rejections };
};

function validateRecommendation(value: unknown, path: string, issues: IssueCollector): RealignRecommendation | undefined {
  const entry = requireObject(value, path, ["id", "source", "summary", "evidence", "recordedAt", "status", "addressedBy"], issues);
  if (!entry) return undefined;
  const status = validateEnumValue<RecommendationStatus>(entry["status"], `${path}.status`, RECOMMENDATION_STATUSES, issues);
  const addressedBy = optionalString(entry["addressedBy"], `${path}.addressedBy`, issues);
  if (status === "addressed" && addressedBy === undefined) issues.add(`${path}.addressedBy`, "an addressed recommendation names the realign that addressed it");
  if (status === "open" && addressedBy !== undefined) issues.add(`${path}.addressedBy`, "must be absent while the recommendation is open");
  return withOptional<RealignRecommendation>(
    {
      id: requireNonEmptyString(entry["id"], `${path}.id`, issues),
      source: validateEnumValue<RealignSource>(entry["source"], `${path}.source`, REALIGN_SOURCES, issues) ?? "agent",
      summary: requireNonEmptyString(entry["summary"], `${path}.summary`, issues),
      evidence: validateStringArray(entry["evidence"], `${path}.evidence`, issues),
      recordedAt: requireTimestamp(entry["recordedAt"], `${path}.recordedAt`, issues),
      status: status ?? "open",
    },
    { addressedBy },
  );
}

function validateRealignment(value: unknown, path: string, issues: IssueCollector): Realignment | undefined {
  const entry = requireObject(
    value,
    path,
    ["id", "direction", "note", "changes", "revalidated", "specificationRevised", "priorAuthorization", "recommendations", "realignedAt"],
    issues,
  );
  if (!entry) return undefined;
  const changes =
    optionalList(entry["changes"], `${path}.changes`, issues, (item, at) => {
      const change = requireObject(item, at, ["action", "ticketId", "reason", "criteriaChanged", "statusBefore"], issues);
      if (!change) return undefined;
      return withOptional<TicketRealignment>(
        {
          action: validateEnumValue<TicketChangeAction>(change["action"], `${at}.action`, TICKET_CHANGE_ACTIONS, issues) ?? "rescope",
          ticketId: requireNonEmptyString(change["ticketId"], `${at}.ticketId`, issues),
        },
        {
          reason: optionalString(change["reason"], `${at}.reason`, issues),
          criteriaChanged: change["criteriaChanged"] === undefined ? undefined : requireBoolean(change["criteriaChanged"], `${at}.criteriaChanged`, issues),
          statusBefore:
            change["statusBefore"] === undefined ? undefined : validateEnumValue<TicketStatus>(change["statusBefore"], `${at}.statusBefore`, TICKET_STATUSES, issues),
        },
      );
    }) ?? [];
  const revalidated =
    optionalList(entry["revalidated"], `${path}.revalidated`, issues, (item, at) => {
      const result = requireObject(item, at, ["ticketId", "disposition", "status"], issues);
      if (!result) return undefined;
      return {
        ticketId: requireNonEmptyString(result["ticketId"], `${at}.ticketId`, issues),
        disposition: validateEnumValue<ValidationDisposition>(result["disposition"], `${at}.disposition`, VALIDATION_DISPOSITIONS, issues) ?? "awaiting-developer",
        status: validateEnumValue<TicketStatus>(result["status"], `${at}.status`, TICKET_STATUSES, issues) ?? "ready",
      };
    }) ?? [];
  if (!Array.isArray(entry["changes"])) issues.add(`${path}.changes`, "must be an array of ticket changes");
  if (!Array.isArray(entry["revalidated"])) issues.add(`${path}.revalidated`, "must be an array of re-validations");
  let priorAuthorization: Realignment["priorAuthorization"];
  if (entry["priorAuthorization"] !== undefined) {
    const prior = requireObject(entry["priorAuthorization"], `${path}.priorAuthorization`, ["scope", "note"], issues);
    if (prior) {
      priorAuthorization = withOptional<NonNullable<Realignment["priorAuthorization"]>>(
        { scope: validateEnumValue<AuthorizationScope>(prior["scope"], `${path}.priorAuthorization.scope`, AUTHORIZATION_SCOPES, issues) ?? "ticket" },
        { note: optionalString(prior["note"], `${path}.priorAuthorization.note`, issues) },
      );
    }
  }
  return withOptional<Realignment>(
    {
      id: requireNonEmptyString(entry["id"], `${path}.id`, issues),
      direction: requireNonEmptyString(entry["direction"], `${path}.direction`, issues),
      note: requireNonEmptyString(entry["note"], `${path}.note`, issues),
      changes,
      revalidated,
      specificationRevised: requireBoolean(entry["specificationRevised"], `${path}.specificationRevised`, issues),
      realignedAt: requireTimestamp(entry["realignedAt"], `${path}.realignedAt`, issues),
    },
    {
      priorAuthorization,
      recommendations: optionalStringArray(entry["recommendations"], `${path}.recommendations`, issues),
    },
  );
}

const validateRealign: Validator<RealignRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["recommendations", "realignments"], issues);
  if (!doc) return undefined;
  if (!Array.isArray(doc["recommendations"])) issues.add("recommendations", "must be an array of recommendations");
  if (!Array.isArray(doc["realignments"])) issues.add("realignments", "must be an array of realignments");
  return {
    recommendations: optionalList(doc["recommendations"], "recommendations", issues, (item, at) => validateRecommendation(item, at, issues)) ?? [],
    realignments: optionalList(doc["realignments"], "realignments", issues, (item, at) => validateRealignment(item, at, issues)) ?? [],
  };
};

const validators: { readonly [K in RecordKind]: Validator<ProjectRecords[K]> } = {
  specification: validateSpecification,
  plan: validatePlan,
  tickets: validateTickets,
  progress: validateProgress,
  lessons: validateLessons,
  jev: validateJev,
  resume: validateResume,
  todos: validateTodos,
  conflicts: validateConflicts,
  diagnoses: validateDiagnoses,
  workers: validateWorkers,
  realign: validateRealign,
};

/** Walks the whole document so a credential cannot hide in a nested field (D14, D23). */
function scanForCredentials(value: unknown, path: string, issues: IssueCollector): void {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value)) {
      issues.add(path, `${SECRET_MESSAGE}; the value looks like a credential`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForCredentials(entry, `${path}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = joinPath(path, key);
    if (SECRET_KEY_PATTERN.test(key)) {
      issues.add(entryPath, SECRET_MESSAGE);
      continue;
    }
    scanForCredentials(entry, entryPath, issues);
  }
}

export type RecordValidation<K extends RecordKind> =
  | { readonly ok: true; readonly record: ProjectRecords[K] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * Validates a record as `writeRecord` would, without writing. For callers
 * that must validate several records before committing any of them.
 */
export function validateRecord<K extends RecordKind>(
  kind: K,
  document: unknown,
  options: { readonly scanForCredentials: boolean } = { scanForCredentials: true },
): RecordValidation<K> {
  const issues = new IssueCollector();
  if (options.scanForCredentials) scanForCredentials(document, "", issues);
  const record = validators[kind](document, issues);
  if (!issues.ok || record === undefined) {
    return { ok: false, issues: issues.issues };
  }
  return { ok: true, record };
}

/**
 * Reads one record from a project directory. An absent file is `absent`, not
 * an error; a present file that is not valid JSON or not a valid record is
 * `malformed` with the offending paths, and is never read as empty.
 */
export function readRecord<K extends RecordKind>(root: string, kind: K): RecordReadResult<K> {
  const path = recordPath(root, kind);
  if (!existsSync(path)) return { kind: "absent" };

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "malformed",
      path,
      issues: [{ path: "", message: `record is not valid JSON: ${message}` }],
    };
  }

  const result = validateRecord(kind, document, { scanForCredentials: false });
  return result.ok
    ? { kind: "present", record: result.record }
    : { kind: "malformed", path, issues: result.issues };
}

/**
 * Validates and writes one record. The write goes through a temporary file
 * and a rename, so a crash mid-write leaves the previous record intact
 * rather than a truncated one.
 *
 * @throws {RecordValidationError} when the record is invalid or carries a
 *   credential; nothing is written in that case.
 */
export function writeRecord<K extends RecordKind>(
  root: string,
  kind: K,
  record: ProjectRecords[K],
): void {
  const result = validateRecord(kind, record, { scanForCredentials: true });
  if (!result.ok) throw new RecordValidationError(kind, result.issues);

  const path = recordPath(root, kind);
  mkdirSync(join(root, PROJECT_RECORD_DIRECTORY), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(result.record, null, 2)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
