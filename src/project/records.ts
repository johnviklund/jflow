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
 * tickets, progress, lessons, Jev fallback status and the wrap resume record
 * live as one JSON file each under a version-controlled `jflow/` directory,
 * so a fresh conversation recovers full context from files alone.
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

export const RECORD_KINDS = ["plan", "tickets", "progress", "lessons", "jev", "resume"] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

/** The plan's content; whether it has been accepted is progress state, not plan content. */
export interface PlanRecord {
  readonly title: string;
  readonly summary: string;
  /** Where the plan came from, e.g. a spec path or tracker reference. */
  readonly source?: string;
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

/**
 * Where the workflow stands: the acceptance gates, authorization, the
 * assigned ticket, fix attempts and resume reconciliation. This is the record
 * the action resolver's `WorkflowState` is derived from.
 */
export interface ProgressRecord {
  /** The human explicitly accepted the specification (D27). */
  readonly specificationAccepted: boolean;
  /** The human explicitly accepted the ticket breakdown (D28); never authorization. */
  readonly planAccepted: boolean;
  /** The human authorized execution; distinct from plan acceptance (user stories 7, 8). */
  readonly executionAuthorized: boolean;
  /** One ticket or the whole plan (D28, D29); present exactly when authorized. */
  readonly authorizationScope?: AuthorizationScope;
  readonly assignedTicketId?: string;
  /** The assigned ticket has changes available to assess. */
  readonly ticketChangesPresent: boolean;
  /** Unsuccessful fix attempts per ticket, one shared counter (D48). */
  readonly fixAttempts?: Readonly<Record<string, number>>;
  readonly reconciliation?: {
    readonly lastReconciledAt?: string;
    readonly discrepancies: readonly ReconciliationDiscrepancy[];
  };
}

export const LESSON_STATUSES = ["candidate", "active", "superseded"] as const;

export type LessonStatus = (typeof LESSON_STATUSES)[number];

export interface LessonEvidence {
  /** What the reference points at; free text such as `commit`, `file`, `decision` or `trace`. */
  readonly kind: string;
  readonly reference: string;
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
}

export interface LessonsRecord {
  readonly lessons: readonly LessonRecord[];
}

export const FALLBACK_SCOPES = ["ticket", "stage"] as const;

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
  };
}

/** What `wrap` leaves behind so the next session can resume (D15, user story 18). */
export interface ResumeRecord {
  readonly writtenAt: string;
  readonly summary: string;
  readonly activeTicketId?: string;
  readonly unresolvedTodos?: readonly string[];
  readonly nextSteps?: readonly string[];
}

export interface ProjectRecords {
  readonly plan: PlanRecord;
  readonly tickets: TicketsRecord;
  readonly progress: ProgressRecord;
  readonly lessons: LessonsRecord;
  readonly jev: JevRecord;
  readonly resume: ResumeRecord;
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

const validatePlan: Validator<PlanRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["title", "summary", "source"], issues);
  if (!doc) return undefined;
  return withOptional<PlanRecord>(
    {
      title: requireNonEmptyString(doc["title"], "title", issues),
      summary: requireNonEmptyString(doc["summary"], "summary", issues),
    },
    { source: optionalString(doc["source"], "source", issues) },
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
      ["id", "title", "acceptanceCriteria", "dependsOn", "status", "parkedReason", "commit"],
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
        { parkedReason, commit: optionalString(ticket["commit"], `${path}.commit`, issues) },
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
      "specificationAccepted",
      "planAccepted",
      "executionAuthorized",
      "authorizationScope",
      "assignedTicketId",
      "ticketChangesPresent",
      "fixAttempts",
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
      specificationAccepted: requireBoolean(
        doc["specificationAccepted"],
        "specificationAccepted",
        issues,
      ),
      planAccepted: requireBoolean(doc["planAccepted"], "planAccepted", issues),
      executionAuthorized,
      ticketChangesPresent: requireBoolean(
        doc["ticketChangesPresent"],
        "ticketChangesPresent",
        issues,
      ),
    },
    {
      authorizationScope,
      assignedTicketId: optionalString(doc["assignedTicketId"], "assignedTicketId", issues),
      fixAttempts,
      reconciliation,
    },
  );
};

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
      ["id", "statement", "scope", "evidence", "status", "supersededBy", "supersededEvidence"],
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
        { supersededBy, supersededEvidence },
      ),
    );
  });

  return { lessons };
};

const validateJev: Validator<JevRecord> = (value, issues) => {
  const doc = requireObject(value, "", ["fallback"], issues);
  if (!doc) return undefined;
  const fallback = requireObject(
    doc["fallback"],
    "fallback",
    ["status", "pendingDecision", "reason", "scope", "scopeId", "approvedAt", "traceReference"],
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

  return {
    fallback: withOptional<JevRecord["fallback"]>(
      { status: status ?? "off" },
      {
        pendingDecision,
        reason: optionalString(fallback["reason"], "fallback.reason", issues),
        scope,
        scopeId: optionalString(fallback["scopeId"], "fallback.scopeId", issues),
        approvedAt: optionalTimestamp(fallback["approvedAt"], "fallback.approvedAt", issues),
        traceReference: optionalString(
          fallback["traceReference"],
          "fallback.traceReference",
          issues,
        ),
      },
    ),
  };
};

const validateResume: Validator<ResumeRecord> = (value, issues) => {
  const doc = requireObject(
    value,
    "",
    ["writtenAt", "summary", "activeTicketId", "unresolvedTodos", "nextSteps"],
    issues,
  );
  if (!doc) return undefined;
  return withOptional<ResumeRecord>(
    {
      writtenAt: requireTimestamp(doc["writtenAt"], "writtenAt", issues),
      summary: requireNonEmptyString(doc["summary"], "summary", issues),
    },
    {
      activeTicketId: optionalString(doc["activeTicketId"], "activeTicketId", issues),
      unresolvedTodos: optionalStringArray(doc["unresolvedTodos"], "unresolvedTodos", issues),
      nextSteps: optionalStringArray(doc["nextSteps"], "nextSteps", issues),
    },
  );
};

const validators: { readonly [K in RecordKind]: Validator<ProjectRecords[K]> } = {
  plan: validatePlan,
  tickets: validateTickets,
  progress: validateProgress,
  lessons: validateLessons,
  jev: validateJev,
  resume: validateResume,
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

type RecordValidation<K extends RecordKind> =
  | { readonly ok: true; readonly record: ProjectRecords[K] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function validateRecord<K extends RecordKind>(
  kind: K,
  document: unknown,
  options: { readonly scanForCredentials: boolean },
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
