import {
  askDecision,
  lessonRetentionEvidence,
  recordChoice,
  reportDecision,
  type ChoiceInput,
  type DecisionDependencies,
  type DecisionReport,
} from "../jev/decisions.js";
import { askEscalation, type EscalationAsk } from "../jev/escalation.js";
import { readJev } from "../jev/fallback.js";
import {
  PROJECT_RECORD_DIRECTORY,
  readRecord,
  validateRecord,
  writeRecord,
  type LessonAdvice,
  type LessonDecision,
  type LessonEvidence,
  type LessonOutcome,
  type LessonRecord,
  type LessonsRecord,
} from "../project/records.js";
import { hasText } from "../validation.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";

/**
 * The helper's part of `learn` (issue #19, D21, D35, D44): capture a
 * candidate project lesson at any point, ask the advisory
 * `lesson-retention` decision about it, and record the decision to retain
 * it or keep it a candidate beside that advice.
 *
 * - Only the lessons record is written (plus the local envelope and trace
 *   of each Jev call), so whatever action was under way resumes as it was.
 * - A lesson that conflicts with an accepted decision or a retained lesson
 *   is a `lesson-conflict` boundary for `escalate`. The decision it
 *   conflicts with is never changed here, whichever way that goes; only
 *   the developer retains such a lesson.
 * - Lessons are project knowledge. Nothing in the workflow package, its
 *   Jev questions or its policy ever reads them, and a lesson scoped to
 *   the workflow itself is refused: that is a question-file proposal's to
 *   change, with the developer's acceptance (D35, D39).
 */

export interface LessonDraft {
  readonly statement: string;
  readonly scope: string;
  readonly evidence: readonly LessonEvidence[];
  /** Accepted decisions or retained lessons the lesson touches, by id. */
  readonly touches?: readonly string[];
  /** Those among them the agent judges it conflicts with. */
  readonly conflictsWith?: readonly string[];
}

/** What was saved, for the developer to see. */
export interface LessonReport {
  readonly saved: LessonOutcome;
  readonly lesson: string;
  readonly statement: string;
  readonly scope: string;
  readonly evidence: readonly LessonEvidence[];
  readonly record: string;
  /** The `lesson-retention` envelope, when Jev answered. */
  readonly adviceEnvelope?: string;
  /** Accepted decisions or retained lessons the lesson conflicts with, left as they were. */
  readonly unchanged?: readonly string[];
}

export type ProposeResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly lesson: LessonRecord;
        readonly advice: DecisionReport;
        readonly askHuman?: EscalationAsk;
        /** `decide`: record your decision; `developer`: theirs, once asked; `decided`: the workflow kept it a candidate. */
        readonly next: "decide" | "developer" | "decided";
        readonly report: LessonReport;
      };
    }
  | Refusal;

export interface LessonDecisionInput {
  readonly outcome: LessonOutcome;
  readonly by: "agent" | "developer";
  readonly reason?: string;
  readonly evidence?: readonly string[];
  /** Your `jev assess` record, where Jev's answer is not relied on. */
  readonly assessment?: string;
}

export type DecideResult =
  | { readonly ok: true; readonly outcome: { readonly lesson: LessonRecord; readonly report: LessonReport } }
  | Refusal;

const RECORD = `${PROJECT_RECORD_DIRECTORY}/lessons.json`;

/**
 * Scopes that name jflow's workflow rather than the project: the package,
 * its rules and gates, Jev's questions and policy. A project's own
 * workflows, skills or questions (`.github/workflows/`, `src/workflow/`)
 * are not among them. The guarantee itself is structural: nothing that
 * resolves or gates an action reads the lessons record.
 */
const WORKFLOW_SCOPES = [
  /\bjflow\b/,
  /^(the\s+)?workflow(\s+(rules?|gates?|package|definition|logic))?$/,
  /\b(workflow (rule|gate|package|definition|logic)|jev('s)? (question|polic|threshold)|question file|policy (file|threshold))/,
];

function scopesWorkflow(scope: string): boolean {
  const normalized = scope.trim().toLowerCase();
  return WORKFLOW_SCOPES.some((pattern) => pattern.test(normalized));
}

type LessonsRead = { readonly ok: true; readonly lessons: LessonsRecord } | Refusal;

function readLessons(root: string): LessonsRead {
  const read = readRecord(root, "lessons");
  if (read.kind === "malformed") return unreadable("lessons", read);
  return { ok: true, lessons: read.kind === "present" ? read.record : { lessons: [] } };
}

function nextId(lessons: LessonsRecord): string {
  const numbers = lessons.lessons.map((lesson) => Number(/^L-(\d+)$/.exec(lesson.id)?.[1] ?? 0));
  return `L-${Math.max(0, ...numbers) + 1}`;
}

/** Accepted decisions and retained lessons, by id: what a lesson may touch or conflict with. */
function settledKnowledge(root: string, lessons: LessonsRecord): { readonly ok: true; readonly known: Map<string, string> } | Refusal {
  const specification = readRecord(root, "specification");
  if (specification.kind === "malformed") return unreadable("specification", specification);
  const known = new Map<string, string>();
  if (specification.kind === "present") {
    for (const decision of specification.record.decisions) {
      if (decision.status === "confirmed") known.set(decision.id, `accepted decision: ${decision.statement}`);
    }
  }
  for (const lesson of lessons.lessons) {
    if (lesson.status === "active") known.set(lesson.id, `retained lesson (${lesson.scope}): ${lesson.statement}`);
  }
  return { ok: true, known };
}

function adviceFrom(result: Awaited<ReturnType<typeof askDecision>>): LessonAdvice | Refusal {
  switch (result.kind) {
    case "answered": {
      const { envelope } = result;
      return {
        envelope: envelope.id,
        answer: envelope.answer.choice,
        reasonCode: envelope.answer.reasonCode,
        route: envelope.route,
      };
    }
    case "failed":
      return { unavailable: result.failure.error, traceReference: result.failure.traceReference };
    case "needs-configuration":
      return { unavailable: result.askHuman };
    case "refused":
      return refuse(result.reason);
  }
}

function reportOf(lesson: LessonRecord): LessonReport {
  const retention = lesson.retention;
  const advice = retention?.advice;
  const unchanged = retention?.conflict?.with ?? [];
  return {
    saved: lesson.status === "active" ? "retained" : "candidate",
    lesson: lesson.id,
    statement: lesson.statement,
    scope: lesson.scope,
    evidence: lesson.evidence,
    record: RECORD,
    ...(advice !== undefined && "envelope" in advice ? { adviceEnvelope: advice.envelope } : {}),
    ...(unchanged.length === 0 ? {} : { unchanged }),
  };
}

export async function proposeLesson(root: string, draft: LessonDraft, dependencies: DecisionDependencies): Promise<ProposeResult> {
  // The draft arrives as a JSON file the agent wrote; read it defensively.
  if (!hasText(draft?.statement)) return refuse("a lesson needs a statement of what was learned");
  if (!hasText(draft.scope)) return refuse("a lesson needs a scope: the part of the project it applies to");
  if (scopesWorkflow(draft.scope)) {
    return refuse(
      `"${draft.scope}" is the workflow, not the project: a lesson never changes workflow logic, its Jev questions or its policy. ` +
        "Record it as an observation for a question-file proposal instead, which only the developer can accept",
    );
  }
  const evidence = Array.isArray(draft.evidence) ? draft.evidence : [];
  if (evidence.length === 0 || !evidence.every((link) => hasText(link?.kind) && hasText(link.reference))) {
    return refuse("a lesson needs at least one evidence link, each with a kind and a reference: a commit, a check's output, a file, a record");
  }

  const current = readLessons(root);
  if (!current.ok) return current;
  const settled = settledKnowledge(root, current.lessons);
  if (!settled.ok) return settled;
  const conflictsWith = [...new Set(draft.conflictsWith ?? [])];
  const touches = [...new Set([...(draft.touches ?? []), ...conflictsWith])];
  const unknown = touches.filter((id) => !settled.known.has(id));
  if (unknown.length > 0) {
    const known = [...settled.known.keys()].join(", ") || "none";
    return refuse(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an accepted decision or a retained lesson; those are ${known}`,
    );
  }
  const related = touches.map((id) => `${id}${conflictsWith.includes(id) ? " (conflicts)" : ""}: ${settled.known.get(id)}`);

  const statement = draft.statement.trim();
  const scope = draft.scope.trim();
  const asked = await askDecision(
    root,
    "lesson-retention",
    lessonRetentionEvidence({ statement, scope, evidence, related }),
    dependencies,
  );
  const advice = adviceFrom(asked);
  if ("ok" in advice) return advice;

  // An escalate from lesson-retention is Jev saying it conflicts; even an
  // uncertain one goes to escalate rather than to the agent's own judgment.
  const jevConflict = "envelope" in advice && advice.answer === "escalate";
  let conflict: NonNullable<LessonRecord["retention"]>["conflict"];
  let decision: LessonDecision | undefined;
  let askHuman: EscalationAsk | undefined;
  if (conflictsWith.length > 0 || jevConflict) {
    const against =
      conflictsWith.length > 0
        ? conflictsWith.join(", ")
        : "an accepted decision or retained lesson, by Jev's lesson-retention answer";
    const escalation = await askEscalation(
      root,
      {
        kind: "lesson-conflict",
        summary: `Candidate lesson "${statement}" (scope: ${scope}) conflicts with ${against}. The decision stands either way; asking decides whether the developer rules on the lesson.`,
        excerpts: [
          ...related.map((text) => ({ source: "lesson/touches", text })),
          ...evidence.map((link) => ({ source: "lesson/evidence", text: `${link.kind}: ${link.reference}` })),
        ],
      },
      dependencies,
    );
    if (escalation.kind === "refused") return refuse(escalation.reason);
    conflict = { with: conflictsWith, ...(escalation.kind === "answered" ? { escalation: escalation.envelope } : {}) };
    if (escalation.ask) {
      askHuman = escalation.askHuman;
    } else {
      // Proceeding without the developer cannot retain a lesson over a decision.
      decision = {
        outcome: "candidate",
        by: "workflow",
        reason: `conflicts with ${against}; escalate answered proceed, so what was accepted stands and the lesson stays a candidate`,
        ...(escalation.kind === "answered" ? { evidence: [`escalate envelope ${escalation.envelope}`] } : {}),
        decidedAt: dependencies.now(),
      };
    }
  }

  const lesson: LessonRecord = {
    id: nextId(current.lessons),
    statement,
    scope,
    evidence: evidence.map((link) => ({ kind: link.kind.trim(), reference: link.reference.trim() })),
    status: "candidate",
    retention: {
      advice,
      ...(touches.length === 0 ? {} : { touches }),
      ...(conflict === undefined ? {} : { conflict }),
      ...(decision === undefined ? {} : { decision }),
    },
  };
  const validated = validateRecord("lessons", { lessons: [...current.lessons.lessons, lesson] });
  if (!validated.ok) return refuse("the lesson cannot be recorded", validated.issues);
  if (decision !== undefined && "envelope" in advice && advice.route !== "ask-human") {
    // The workflow's choice beside Jev's answer, as escalate records its own.
    const chosen = recordChoice(root, advice.envelope, choiceOf(decision), ["retain", "discard"], { now: decision.decidedAt });
    if (!chosen.ok) return chosen;
  }
  writeRecord(root, "lessons", validated.record);
  return {
    ok: true,
    outcome: {
      lesson,
      advice: reportDecision(asked),
      ...(askHuman === undefined ? {} : { askHuman }),
      next: decision !== undefined ? "decided" : askHuman !== undefined ? "developer" : "decide",
      report: reportOf(lesson),
    },
  };
}

/**
 * A lesson decision in `lesson-retention`'s own vocabulary: kept a
 * candidate is `discard`, meaning not retained; the lesson stays recorded.
 */
function choiceOf(decision: LessonDecision): ChoiceInput {
  return {
    action: decision.outcome === "retained" ? "retain" : "discard",
    by: decision.by,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.evidence === undefined ? {} : { evidence: decision.evidence }),
  };
}

/** Whether the agent recorded its own resolved assessment standing in for this lesson's advice. */
function assessedFor(root: string, id: string, advice: LessonAdvice): { readonly ok: true } | Refusal {
  const jev = readJev(root);
  if (!jev.ok) return jev;
  const assessment = (jev.record.assessments ?? []).find((entry) => entry.id === id);
  if (assessment === undefined) return refuse(`no assessment "${id}" is recorded (jev assess)`);
  const standsIn =
    assessment.decision === "lesson-retention" &&
    ("envelope" in advice
      ? assessment.envelope === advice.envelope
      : advice.traceReference !== undefined && assessment.traceReference === advice.traceReference);
  if (!standsIn) return refuse(`assessment ${id} does not stand in for this lesson's lesson-retention advice`);
  if (assessment.status !== "resolved") return refuse(`assessment ${id} went to the developer; the decision is theirs`);
  return { ok: true };
}

export function decideLesson(
  root: string,
  id: string,
  input: LessonDecisionInput,
  options: { readonly now: string },
): DecideResult {
  const current = readLessons(root);
  if (!current.ok) return current;
  const lesson = current.lessons.lessons.find((entry) => entry.id === id);
  if (lesson === undefined) {
    const known = current.lessons.lessons.map((entry) => entry.id).join(", ") || "none";
    return refuse(`no lesson "${id}"; recorded lessons are ${known}`);
  }
  const retention = lesson.retention;
  if (retention === undefined) return refuse(`lesson ${id} was not assessed; record lessons with learn propose`);
  // Only the developer's own word reopens what the workflow decided for them.
  const reopened = retention.decision?.by === "workflow" && input.by === "developer";
  if ((retention.decision !== undefined && !reopened) || lesson.status !== "candidate") {
    const decided = retention.decision;
    return refuse(`lesson ${id} is already decided${decided === undefined ? "" : `: ${decided.outcome}, by ${decided.by}`}`);
  }

  const reason = input.reason?.trim() ?? "";
  const evidence = (input.evidence ?? []).filter(hasText);
  if (input.by === "developer" && reason === "") return refuse("record the developer's decision in their words (--reason)");
  if (input.by !== "developer" && retention.conflict !== undefined) {
    const against = retention.conflict.with.join(", ") || "an accepted decision or retained lesson";
    return refuse(
      `lesson ${id} conflicts with ${against}, so it is the developer's to decide once escalate asked them; record their words with --by developer`,
    );
  }

  const { advice } = retention;
  const relied = "envelope" in advice && advice.route !== "ask-human";
  const recordsChoice = "envelope" in advice && !reopened && (input.by === "developer" || relied);
  if (!recordsChoice && input.by === "agent" && input.outcome === "retained") {
    // Nothing relies on the advice, so the agent retains only on its own recorded assessment.
    if (!hasText(input.assessment)) {
      const why = "envelope" in advice ? `Jev's answer is not relied on (${advice.route})` : `Jev could not answer (${advice.unavailable})`;
      return refuse(`${why}; retain lesson ${id} only on the developer's words, or on your own assessment recorded with jev assess (--assessment)`);
    }
    const assessed = assessedFor(root, input.assessment, advice);
    if (!assessed.ok) return assessed;
  }

  const decision: LessonDecision = {
    outcome: input.outcome,
    by: input.by,
    ...(reason === "" ? {} : { reason }),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(hasText(input.assessment) ? { assessment: input.assessment } : {}),
    decidedAt: options.now,
  };
  const decided: LessonRecord = {
    ...lesson,
    status: input.outcome === "retained" ? "active" : "candidate",
    retention: { ...retention, decision },
  };
  const validated = validateRecord("lessons", {
    lessons: current.lessons.lessons.map((entry) => (entry.id === id ? decided : entry)),
  });
  if (!validated.ok) return refuse("the decision cannot be recorded", validated.issues);
  if (recordsChoice && "envelope" in advice) {
    // The choice beside Jev's answer; setting it aside needs a reason and evidence (D6).
    const chosen = recordChoice(root, advice.envelope, choiceOf(decision), ["retain", "discard"], options);
    if (!chosen.ok) return chosen;
  }
  writeRecord(root, "lessons", validated.record);
  return { ok: true, outcome: { lesson: decided, report: reportOf(decided) } };
}
