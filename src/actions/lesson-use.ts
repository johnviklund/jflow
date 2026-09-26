import type { DecisionDependencies } from "../jev/decisions.js";
import { askEscalation, type EscalationAsk } from "../jev/escalation.js";
import {
  readRecord,
  validateRecord,
  writeRecord,
  type LessonCheck,
  type LessonRecord,
  type LessonsRecord,
} from "../project/records.js";
import { hasText } from "../validation.js";
import { readLessons } from "./learn.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";

/**
 * Using a retained lesson (issue #20, SPEC.md user story 56): only active
 * lessons are offered for use, each is re-checked against the task before
 * it is applied, and one contradicted by new evidence is marked superseded
 * with that evidence and kept as history.
 *
 * Superseding a lesson the developer retained would change a human
 * decision, and a contradiction that touches an accepted decision may mean
 * that decision is wrong. The agent then asks `escalate` at
 * `lesson-conflict`; on an ask nothing changes until the developer
 * decides. On `proceed`, a lesson the developer retained stays as they
 * decided, with the contradiction recorded; otherwise it is superseded,
 * since that never writes the accepted decision. Nothing here writes the
 * specification, and only the lessons record is written.
 */

export interface LessonCheckInput {
  /** The task the lesson would be applied to. */
  readonly task: string;
  readonly outcome: "applies" | "skipped";
  readonly reason: string;
  readonly evidence?: readonly string[];
}

export type LessonCheckResult =
  | { readonly ok: true; readonly outcome: { readonly apply: boolean; readonly lesson: LessonRecord } }
  | Refusal;

export interface SupersessionInput {
  /** What supersedes the lesson: a lesson id (`L-n`) or a description of the change. */
  readonly successor: string;
  /** The new evidence that contradicts it. */
  readonly evidence: readonly string[];
  /** Accepted decisions the contradiction touches, by id. */
  readonly conflictsWith?: readonly string[];
  readonly by: "agent" | "developer";
  /** For the developer, their words. */
  readonly reason?: string;
  readonly task?: string;
}

export type SupersessionResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly superseded: boolean;
        readonly lesson: LessonRecord;
        readonly askHuman?: EscalationAsk;
      };
    }
  | Refusal;

/** A retained lesson offered for use, flagged when new evidence contradicted it and it was kept. */
export interface UsableLesson {
  readonly lesson: LessonRecord;
  readonly contradicted: boolean;
  /** The scope `classify` proposed when the lesson was assessed, to check the task against (issue #29). */
  readonly proposedScope?: string;
}

/** Whether a check recorded new evidence against the lesson; applying it again then needs evidence it still holds. */
function wasContradicted(lesson: LessonRecord): boolean {
  return (lesson.checks ?? []).some((check) => check.outcome === "contradicted");
}

/** The lessons that may be used: retained ones. Candidates and superseded lessons never are. */
export function activeLessons(root: string): { readonly ok: true; readonly lessons: readonly UsableLesson[] } | Refusal {
  const read = readLessons(root);
  if (!read.ok) return read;
  return {
    ok: true,
    lessons: read.lessons.lessons
      .filter((lesson) => lesson.status === "active")
      .map((lesson) => {
        const proposed = lesson.retention?.scope;
        return {
          lesson,
          contradicted: wasContradicted(lesson),
          ...(proposed !== undefined && "answer" in proposed ? { proposedScope: proposed.answer } : {}),
        };
      }),
  };
}

type Found = { readonly ok: true; readonly lessons: LessonsRecord; readonly lesson: LessonRecord } | Refusal;

/** The lesson by id, refused unless it is retained. */
function findActive(root: string, id: string): Found {
  const read = readLessons(root);
  if (!read.ok) return read;
  const lesson = read.lessons.lessons.find((entry) => entry.id === id);
  if (lesson === undefined) {
    const known = read.lessons.lessons.map((entry) => entry.id).join(", ") || "none";
    return refuse(`no lesson "${id}"; recorded lessons are ${known}`);
  }
  if (lesson.status === "superseded") {
    return refuse(`lesson ${id} is superseded by ${lesson.supersededBy}; it is history and is never applied`);
  }
  if (lesson.status === "candidate") return refuse(`lesson ${id} is a candidate; only a retained lesson is applied`);
  return { ok: true, lessons: read.lessons, lesson };
}

function save(root: string, lessons: LessonsRecord, updated: LessonRecord): { readonly ok: true } | Refusal {
  const validated = validateRecord("lessons", {
    lessons: lessons.lessons.map((entry) => (entry.id === updated.id ? updated : entry)),
  });
  if (!validated.ok) return refuse("the lesson cannot be recorded", validated.issues);
  writeRecord(root, "lessons", validated.record);
  return { ok: true };
}

function withCheck(lesson: LessonRecord, check: LessonCheck): LessonRecord {
  return { ...lesson, checks: [...(lesson.checks ?? []), check] };
}

export function checkLesson(root: string, id: string, input: LessonCheckInput, options: { readonly now: string }): LessonCheckResult {
  if (!hasText(input?.task)) return refuse("name the task the lesson would be applied to");
  if (input.outcome !== "applies" && input.outcome !== "skipped") return refuse("a check's outcome is applies or skipped");
  if (!hasText(input.reason)) return refuse(`record why the lesson ${input.outcome === "applies" ? "applies" : "is skipped"}`);
  const found = findActive(root, id);
  if (!found.ok) return found;

  const evidence = (input.evidence ?? []).filter(hasText);
  if (input.outcome === "applies" && wasContradicted(found.lesson) && evidence.length === 0) {
    return refuse(`new evidence contradicted lesson ${id} and it was kept; apply it only with evidence that it still holds (--evidence)`);
  }
  const lesson = withCheck(found.lesson, {
    task: input.task.trim(),
    outcome: input.outcome,
    reason: input.reason.trim(),
    ...(evidence.length === 0 ? {} : { evidence }),
    checkedAt: options.now,
  });
  const saved = save(root, found.lessons, lesson);
  if (!saved.ok) return saved;
  return { ok: true, outcome: { apply: input.outcome === "applies", lesson } };
}

/** Accepted decisions by id, with their statements. */
function acceptedDecisions(root: string): { readonly ok: true; readonly decisions: Map<string, string> } | Refusal {
  const read = readRecord(root, "specification");
  if (read.kind === "malformed") return unreadable("specification", read);
  const decisions = new Map<string, string>();
  if (read.kind === "present") {
    for (const decision of read.record.decisions) {
      if (decision.status === "confirmed") decisions.set(decision.id, decision.statement);
    }
  }
  return { ok: true, decisions };
}

export async function supersedeLesson(
  root: string,
  id: string,
  input: SupersessionInput,
  dependencies: DecisionDependencies,
): Promise<SupersessionResult> {
  if (!hasText(input?.successor)) return refuse("name what supersedes the lesson: a lesson id or the change that contradicts it");
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).filter(hasText);
  if (evidence.length === 0) return refuse("a lesson is superseded only on evidence: a command and its output, a commit, a file");
  const reason = input.reason?.trim() ?? "";
  if (input.by === "developer" && reason === "") return refuse("record the developer's decision in their words (--reason)");

  const found = findActive(root, id);
  if (!found.ok) return found;
  const successor = input.successor.trim();
  if (/^L-\d+$/.test(successor)) {
    // A successor is itself applied, so it must be retained; that also rules out chains and cycles.
    if (successor === id) return refuse(`lesson ${id} cannot supersede itself`);
    const next = found.lessons.lessons.find((entry) => entry.id === successor);
    if (next === undefined) return refuse(`no lesson "${successor}" to supersede ${id} with`);
    if (next.status !== "active") return refuse(`lesson ${successor} is ${next.status}; only a retained lesson can supersede ${id}`);
  }
  const accepted = acceptedDecisions(root);
  if (!accepted.ok) return accepted;
  const conflictsWith = [...new Set(input.conflictsWith ?? [])];
  const unknown = conflictsWith.filter((decision) => !accepted.decisions.has(decision));
  if (unknown.length > 0) {
    const known = [...accepted.decisions.keys()].join(", ") || "none";
    return refuse(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an accepted decision; those are ${known}`);
  }

  const { lesson } = found;
  const task = hasText(input.task) ? input.task.trim() : "no task: new evidence";
  const developerRetained = lesson.retention?.decision?.by === "developer";
  if (input.by === "agent" && (developerRetained || conflictsWith.length > 0)) {
    const changes = [
      ...(developerRetained ? [`the developer's decision to retain it ("${lesson.retention?.decision?.reason}")`] : []),
      ...conflictsWith.map((decision) => `accepted decision ${decision}`),
    ].join(" and ");
    const escalation = await askEscalation(
      root,
      {
        kind: "lesson-conflict",
        summary: `Lesson ${id} ("${lesson.statement}", scope ${lesson.scope}) is contradicted: ${successor}. Superseding it would change ${changes}.`,
        excerpts: [
          ...evidence.map((text) => ({ source: "contradiction/evidence", text })),
          ...conflictsWith.map((decision) => ({ source: `decision/${decision}`, text: accepted.decisions.get(decision) ?? "" })),
        ],
      },
      dependencies,
    );
    if (escalation.kind === "refused") return refuse(escalation.reason);
    if (escalation.ask) {
      // Nothing changes until the developer decides.
      return {
        ok: true,
        outcome: { superseded: false, lesson, ...(escalation.askHuman === undefined ? {} : { askHuman: escalation.askHuman }) },
      };
    }
    if (!developerRetained) {
      // Only an accepted decision was touched, and superseding a lesson never writes it: proceed supersedes.
      return supersede(root, found.lessons, lesson, {
        task,
        reason: `${successor}; escalate answered proceed`,
        successor,
        evidence,
        ...(escalation.kind === "answered" ? { escalation: escalation.envelope } : {}),
        now: dependencies.now(),
      });
    }
    const recorded = withCheck(lesson, {
      task,
      outcome: "contradicted",
      reason: `${successor}; escalate answered proceed, so ${changes} stands and the lesson is not superseded`,
      evidence,
      ...(escalation.kind === "answered" ? { escalation: escalation.envelope } : {}),
      checkedAt: dependencies.now(),
    });
    const saved = save(root, found.lessons, recorded);
    if (!saved.ok) return saved;
    return { ok: true, outcome: { superseded: false, lesson: recorded } };
  }

  return supersede(root, found.lessons, lesson, {
    task,
    reason: input.by === "developer" ? `developer: ${reason}` : successor,
    successor,
    evidence,
    now: dependencies.now(),
  });
}

/** Marks the lesson superseded, keeping everything it recorded; the contradiction joins its checks. */
function supersede(
  root: string,
  lessons: LessonsRecord,
  lesson: LessonRecord,
  change: {
    readonly task: string;
    readonly reason: string;
    readonly successor: string;
    readonly evidence: readonly string[];
    readonly escalation?: string;
    readonly now: string;
  },
): SupersessionResult {
  const superseded: LessonRecord = {
    ...withCheck(lesson, {
      task: change.task,
      outcome: "contradicted",
      reason: change.reason,
      evidence: change.evidence,
      ...(change.escalation === undefined ? {} : { escalation: change.escalation }),
      checkedAt: change.now,
    }),
    status: "superseded",
    supersededBy: change.successor,
    supersededEvidence: change.evidence.join("; "),
  };
  const saved = save(root, lessons, superseded);
  if (!saved.ok) return saved;
  return { ok: true, outcome: { superseded: true, lesson: superseded } };
}
