import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { JevTransport, TransportRequest } from "../jev/client.js";
import { readEnvelope, type DecisionDependencies } from "../jev/decisions.js";
import { assessWithoutJev } from "../jev/assessment.js";
import { readRecord, recordPath, writeRecord, type SpecificationRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { decideLesson, proposeLesson, type LessonDraft } from "./learn.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T12:00:00.000Z";
const above = (decision: string) => {
  const threshold = confidenceThreshold(pkg, decision);
  return threshold + (1 - threshold) / 2;
};
const below = (decision: string) => confidenceThreshold(pkg, decision) / 2;

const SPECIFICATION: SpecificationRecord = {
  title: "CSV importer",
  problem: "Imports are slow.",
  scenarios: ["import a file"],
  acceptanceCriteria: ["imports a file"],
  constraints: [],
  exclusions: [],
  decisions: [
    { id: "D1", statement: "Parse CSV with the standard library only.", status: "confirmed", basis: "developer: no new dependencies" },
    { id: "D2", statement: "Stream large files.", status: "proposed" },
  ],
  status: "awaiting-acceptance",
  writtenAt: "2026-09-20T10:00:00Z",
};

/** Mid-implementation: T1 authorized and assigned, with changes under way, and a specification with one accepted decision. */
function project(): ProjectHarness {
  const h = createProjectHarness({
    state: {
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
      ticketChangesPresent: true,
    },
    gitRepository: true,
  });
  harnesses.push(h);
  writeRecord(h.root, "specification", { ...SPECIFICATION, decisions: [SPECIFICATION.decisions[0]!], status: "accepted", acceptedAt: "2026-09-20T11:00:00Z" });
  return h;
}

type Answer = readonly [choice: string, reason: string, confidence: number];

/** A Jev answering each decision from its own queue, one answer per call. */
function jev(
  answers: Partial<Record<"lesson-retention" | "escalate" | "classify", Answer[]>> = {},
): JevTransport & { readonly asked: (decision: string) => TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const decisionOf = (request: TransportRequest) =>
    Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const decision = decisionOf(request);
    // classify's lesson-scope agrees with the agent's own scope, the first choice, unless a test scripts it.
    const agentsScope = () =>
      Object.keys((JSON.parse(request.body) as { questions: { classify: { criteria: object } } }).questions.classify.criteria)[0]!;
    const answer =
      answers[decision as "lesson-retention" | "escalate" | "classify"]?.shift() ??
      (decision === "classify" ? ([agentsScope(), "clear-match", above("classify")] as const) : undefined);
    if (answer === undefined) return { status: 500, body: "no scripted answer" };
    const [choice, reason, confidence] = answer;
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          [decision]: { type: "choice", choice, confidence },
          [`${decision}.reason`]: { type: "choice", choice: reason, confidence },
        },
      }),
    };
  };
  const asked = (decision: string) => sent.filter((request) => decisionOf(request) === decision);
  return Object.assign(transport, { asked });
}

function dependencies(h: ProjectHarness, transport: JevTransport): DecisionDependencies {
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async () => undefined,
  };
}

const retain = (): Answer => ["retain", "evidence-backed", above("lesson-retention")];
const speculative = (): Answer => ["discard", "speculative", above("lesson-retention")];
const conflicting = (): Answer => ["escalate", "conflicts-with-decision", above("lesson-retention")];
const proceed = (): Answer => ["proceed", "routine", above("escalate")];
const escalate = (): Answer => ["escalate", "consequential", above("escalate")];

const LESSON: LessonDraft = {
  statement: "The fixture loader must reset the clock before each parser test.",
  scope: "src/parser tests",
  evidence: [
    { kind: "commit", reference: "a1b2c3d" },
    { kind: "check", reference: "npm test -- parser: 3 failed before the reset, 12 passed after" },
  ],
};

/** Every file of the shipped workflow package and the skill, by path. */
function workflowFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const directory of ["../../workflow/", "../../skill/"]) {
    const root = fileURLToPath(new URL(directory, import.meta.url));
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[`${entry.parentPath}/${entry.name}`] = readFileSync(`${entry.parentPath}/${entry.name}`, "utf8");
    }
  }
  return files;
}

/** The lesson-retention envelope a proposal recorded. */
function adviceOf(proposed: Awaited<ReturnType<typeof proposeLesson>>): { readonly envelope: string; readonly route: string } {
  if (!proposed.ok) throw new Error(proposed.reason);
  const advice = proposed.outcome.lesson.retention?.advice;
  if (advice === undefined || !("envelope" in advice)) throw new Error("Jev did not answer");
  return advice;
}

const lessonsOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "lessons");
  return read.kind === "present" ? read.record.lessons : [];
};

describe("learn: retaining an evidence-backed lesson", () => {
  it("records the lesson with Jev's advisory answer, then retains it on the agent's decision with a visible report", async () => {
    const h = project();
    const transport = jev({ "lesson-retention": [retain()] });

    const proposed = await proposeLesson(h.root, LESSON, dependencies(h, transport));

    expect(proposed).toMatchObject({
      ok: true,
      outcome: {
        lesson: { id: "L-1", status: "candidate", retention: { advice: { answer: "retain", reasonCode: "evidence-backed", route: "weigh" } } },
        next: "decide",
      },
    });
    const { envelope } = adviceOf(proposed);
    expect(transport.asked("lesson-retention")[0]!.body).toContain("a1b2c3d");
    expect(transport.asked("escalate")).toHaveLength(0);

    const decided = decideLesson(h.root, "L-1", { outcome: "retained", by: "agent", reason: "the reset fixed three failing tests" }, { now });

    expect(decided).toMatchObject({
      ok: true,
      outcome: {
        lesson: { id: "L-1", status: "active", retention: { advice: { envelope }, decision: { outcome: "retained", by: "agent" } } },
        report: {
          saved: "retained",
          lesson: "L-1",
          statement: LESSON.statement,
          scope: LESSON.scope,
          evidence: LESSON.evidence,
          record: "jflow/lessons.json",
          adviceEnvelope: envelope,
        },
      },
    });
    expect(lessonsOf(h)).toEqual([expect.objectContaining({ id: "L-1", status: "active" })]);
    const read = readEnvelope(h.root, envelope);
    expect(read.ok && read.envelope.choice).toMatchObject({ action: "retain", by: "agent", followsAnswer: true });
  });

  it("refuses to decide a lesson twice, or one that does not exist", async () => {
    const h = project();
    await proposeLesson(h.root, LESSON, dependencies(h, jev({ "lesson-retention": [retain()] })));
    decideLesson(h.root, "L-1", { outcome: "retained", by: "agent" }, { now });

    expect(decideLesson(h.root, "L-1", { outcome: "candidate", by: "agent", reason: "second thoughts" }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already"),
    });
    expect(decideLesson(h.root, "L-9", { outcome: "retained", by: "agent" }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("L-1"),
    });
  });

  it("refuses a lesson without a statement, a scope or an evidence link", async () => {
    const h = project();
    const transport = jev();
    for (const draft of [
      { ...LESSON, statement: " " },
      { ...LESSON, scope: "" },
      { ...LESSON, evidence: [] },
      { ...LESSON, evidence: [{ kind: "commit", reference: " " }] },
    ]) {
      expect(await proposeLesson(h.root, draft, dependencies(h, transport))).toMatchObject({ ok: false });
    }
    expect(transport.asked("lesson-retention")).toHaveLength(0);
    expect(lessonsOf(h)).toEqual([]);
  });
});

describe("learn: classify proposes the lesson's scope", () => {
  it("asks classify with content kind lesson-scope over the agent's scope and alternatives, and records the proposal", async () => {
    const h = project();
    const transport = jev({ "lesson-retention": [retain()], classify: [["src/parser", "clear-match", above("classify")]] });

    const proposed = await proposeLesson(h.root, { ...LESSON, scope: "src/parser tests", scopeAlternatives: ["src/parser"] }, dependencies(h, transport));

    const [request] = transport.asked("classify");
    expect(request!.body).toContain("Content: lesson-scope.");
    expect(Object.keys((JSON.parse(request!.body) as { questions: { classify: { criteria: object } } }).questions.classify.criteria)).toEqual([
      "src/parser tests",
      "src/parser",
      "unclear",
    ]);
    expect(proposed).toMatchObject({
      ok: true,
      outcome: {
        lesson: {
          scope: "src/parser tests",
          retention: { scope: { answer: "src/parser", reasonCode: "clear-match", route: "weigh", envelope: expect.stringMatching(/^ENV-/) } },
        },
        report: { proposedScope: "src/parser" },
      },
    });
  });

  it("retains a lesson classify confidently found no clear scope for only with evidence", async () => {
    const h = project();
    await proposeLesson(h.root, LESSON, dependencies(h, jev({ "lesson-retention": [retain()], classify: [["unclear", "ambiguous", above("classify")]] })));

    const bare = decideLesson(h.root, "L-1", { outcome: "retained", by: "agent" }, { now });
    const evidenced = decideLesson(h.root, "L-1", { outcome: "retained", by: "agent", evidence: ["only src/parser tests read the fixture clock"] }, { now });

    expect(bare).toMatchObject({ ok: false, reason: expect.stringContaining("no clear scope") });
    expect(evidenced).toMatchObject({ ok: true, outcome: { lesson: { status: "active" } } });
  });
});

describe("learn: a speculative lesson stays a candidate", () => {
  it("keeps the lesson a candidate, never retained, when the agent agrees it is speculative", async () => {
    const h = project();
    await proposeLesson(h.root, LESSON, dependencies(h, jev({ "lesson-retention": [speculative()] })));

    const decided = decideLesson(h.root, "L-1", { outcome: "candidate", by: "agent", reason: "seen once, cause unconfirmed" }, { now });

    expect(decided).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "candidate", retention: { decision: { outcome: "candidate" } } }, report: { saved: "candidate" } },
    });
    expect(lessonsOf(h).filter((lesson) => lesson.status === "active")).toEqual([]);
  });

  it("retains against Jev's discard only with a reason and the evidence it rests on", async () => {
    const h = project();
    await proposeLesson(h.root, LESSON, dependencies(h, jev({ "lesson-retention": [speculative()] })));

    const unexplained = decideLesson(h.root, "L-1", { outcome: "retained", by: "agent", reason: "I am sure" }, { now });
    const evidenced = decideLesson(
      h.root,
      "L-1",
      { outcome: "retained", by: "agent", reason: "reproduced twice since", evidence: ["npm test -- parser (run 2 and 3)"] },
      { now },
    );

    expect(unexplained).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
    expect(evidenced).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "active", retention: { decision: { by: "agent", evidence: ["npm test -- parser (run 2 and 3)"] } } } },
    });
  });

  it("does not let the agent retain a lesson whose answer is not relied on, unless its own assessment is recorded", async () => {
    const h = project();
    const proposed = await proposeLesson(
      h.root,
      LESSON,
      dependencies(h, jev({ "lesson-retention": [["retain", "evidence-backed", below("lesson-retention")]] })),
    );
    const { envelope, route } = adviceOf(proposed);
    expect(route).toBe("ask-human");

    const unassessed = decideLesson(h.root, "L-1", { outcome: "retained", by: "agent", reason: "looks right" }, { now });
    const assessment = assessWithoutJev(
      h.root,
      {
        decision: "lesson-retention",
        envelope,
        assessment: "the reset fixed three failing tests and nothing else changed",
        evidence: ["npm test -- parser"],
        resolution: "retain",
        consequential: false,
      },
      { now },
    );
    if (!assessment.ok) throw new Error(assessment.reason);
    const assessed = decideLesson(
      h.root,
      "L-1",
      { outcome: "retained", by: "agent", reason: "my assessment", assessment: assessment.outcome.assessment.id },
      { now },
    );

    expect(unassessed).toMatchObject({ ok: false, reason: expect.stringContaining("jev assess") });
    expect(assessed).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "active", retention: { decision: { assessment: "A-1" } } } },
    });
  });

  it("records the lesson as a candidate even when Jev cannot be asked", async () => {
    const h = project();
    const proposed = await proposeLesson(h.root, LESSON, {
      ...dependencies(h, jev()),
      apiKey: { status: "missing", askHuman: "Set JFLOW_JEV_API_KEY" } as never,
    });

    expect(proposed).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "candidate", retention: { advice: { unavailable: expect.any(String) } } } },
    });
    expect(decideLesson(h.root, "L-1", { outcome: "retained", by: "agent", reason: "sure" }, { now })).toMatchObject({ ok: false });
    expect(decideLesson(h.root, "L-1", { outcome: "retained", by: "developer", reason: "keep it" }, { now })).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "active" } },
    });
  });
});

describe("learn: a lesson conflicting with an accepted decision", () => {
  const CONFLICT: LessonDraft = {
    statement: "Use a CSV library for quoted fields; hand parsing keeps breaking.",
    scope: "src/parser",
    evidence: [{ kind: "trace", reference: "npm test -- quoting: 4 failed" }],
    conflictsWith: ["D1"],
  };

  it("asks escalate at lesson-conflict; on proceed the decision stands and the lesson stays a candidate", async () => {
    const h = project();
    const specification = readFileSync(recordPath(h.root, "specification"), "utf8");
    const transport = jev({ "lesson-retention": [retain()], escalate: [proceed()] });

    const proposed = await proposeLesson(h.root, CONFLICT, dependencies(h, transport));

    expect(transport.asked("escalate")).toHaveLength(1);
    expect(transport.asked("escalate")[0]!.body).toContain("lesson-conflict");
    expect(transport.asked("escalate")[0]!.body).toContain("standard library only");
    expect(proposed).toMatchObject({
      ok: true,
      outcome: {
        lesson: {
          status: "candidate",
          retention: { conflict: { with: ["D1"], escalation: expect.stringMatching(/^ENV-/) }, decision: { outcome: "candidate", by: "workflow" } },
        },
        next: "decided",
      },
    });
    expect(decideLesson(h.root, "L-1", { outcome: "retained", by: "agent", reason: "r", evidence: ["e"] }, { now })).toMatchObject({ ok: false });
    expect(readFileSync(recordPath(h.root, "specification"), "utf8")).toBe(specification);
  });

  it("records the workflow's choice beside Jev's answer, and lets only the developer reopen it", async () => {
    const h = project();
    const proposed = await proposeLesson(h.root, CONFLICT, dependencies(h, jev({ "lesson-retention": [retain()], escalate: [proceed()] })));
    const { envelope } = adviceOf(proposed);

    const read = readEnvelope(h.root, envelope);
    expect(read.ok && read.envelope.choice).toMatchObject({ action: "discard", by: "workflow", followsAnswer: false });
    expect(decideLesson(h.root, "L-1", { outcome: "retained", by: "developer", reason: "keep it anyway" }, { now })).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "active", retention: { decision: { by: "developer" } } }, report: { unchanged: ["D1"] } },
    });
  });

  it("asks escalate even when Jev's conflict answer is below its threshold", async () => {
    const h = project();
    const transport = jev({ "lesson-retention": [["escalate", "conflicts-with-decision", below("lesson-retention")]], escalate: [escalate()] });

    const proposed = await proposeLesson(h.root, LESSON, dependencies(h, transport));

    expect(transport.asked("escalate")).toHaveLength(1);
    expect(proposed).toMatchObject({ ok: true, outcome: { next: "developer" } });
  });

  it("on escalate asks the developer, and even their retention leaves the decision untouched", async () => {
    const h = project();
    const specification = readFileSync(recordPath(h.root, "specification"), "utf8");
    const proposed = await proposeLesson(h.root, CONFLICT, dependencies(h, jev({ "lesson-retention": [retain()], escalate: [escalate()] })));

    expect(proposed).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "candidate" }, askHuman: { kind: "human-ask", boundary: "lesson-conflict" }, next: "developer" },
    });
    expect(decideLesson(h.root, "L-1", { outcome: "retained", by: "agent", reason: "r", evidence: ["e"] }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("developer"),
    });

    const decided = decideLesson(h.root, "L-1", { outcome: "retained", by: "developer", reason: "keep it as a known pain point" }, { now });

    expect(decided).toMatchObject({
      ok: true,
      outcome: { lesson: { status: "active" }, report: { saved: "retained", unchanged: ["D1"] } },
    });
    expect(readFileSync(recordPath(h.root, "specification"), "utf8")).toBe(specification);
  });

  it("treats Jev's confident escalate answer as a conflict and asks escalate", async () => {
    const h = project();
    const transport = jev({ "lesson-retention": [conflicting()], escalate: [escalate()] });

    const proposed = await proposeLesson(h.root, { ...CONFLICT, conflictsWith: [], touches: ["D1"] }, dependencies(h, transport));

    expect(transport.asked("escalate")).toHaveLength(1);
    expect(proposed).toMatchObject({ ok: true, outcome: { lesson: { retention: { conflict: { with: [] } } }, next: "developer" } });
  });

  it("refuses to name as touched or conflicting anything but an accepted decision or a retained lesson", async () => {
    const h = project();
    writeRecord(h.root, "specification", { ...SPECIFICATION });
    const transport = jev();

    const proposal = await proposeLesson(h.root, { ...CONFLICT, conflictsWith: ["D2"] }, dependencies(h, transport));
    const unknown = await proposeLesson(h.root, { ...CONFLICT, conflictsWith: [], touches: ["D9"] }, dependencies(h, transport));

    expect(proposal).toMatchObject({ ok: false, reason: expect.stringContaining("D1") });
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining("D9") });
    expect(transport.asked("lesson-retention")).toHaveLength(0);
  });
});

describe("learn never changes the workflow", () => {
  it("refuses a lesson scoped to the workflow, its rules, its Jev questions or its policy", async () => {
    const h = project();
    const transport = jev();
    for (const scope of ["workflow rules", "the workflow", "the jflow skill", "Jev questions", "policy thresholds", "workflow/jflow.workflow.json"]) {
      const result = await proposeLesson(h.root, { ...LESSON, scope }, dependencies(h, transport));
      expect(result, scope).toMatchObject({ ok: false, reason: expect.stringContaining("question-file proposal") });
    }
    expect(transport.asked("lesson-retention")).toHaveLength(0);
  });

  it("accepts a scope in the project's own workflows, skills or questions", async () => {
    const h = project();
    const scopes = ["workflow engine", ".github/workflows/ci.yml", "skill/tree.ts", "questions/ survey module"];
    const transport = jev({ "lesson-retention": scopes.map(() => retain()) });
    for (const scope of scopes) {
      expect(await proposeLesson(h.root, { ...LESSON, scope }, dependencies(h, transport)), scope).toMatchObject({ ok: true });
    }
  });

  it("leaves the workflow package and every gate as they were after a lesson about skipping review is retained", async () => {
    const h = project();
    const workflow = workflowFiles();
    const review = h.runAction("review");
    await proposeLesson(
      h.root,
      { ...LESSON, statement: "Review can be skipped for small parser changes." },
      dependencies(h, jev({ "lesson-retention": [retain()] })),
    );
    decideLesson(h.root, "L-1", { outcome: "retained", by: "agent" }, { now });

    expect(lessonsOf(h)[0]).toMatchObject({ status: "active" });
    expect(workflowFiles()).toEqual(workflow);
    expect(h.runAction("review")).toEqual(review);
  });
});

describe("learn mid-action", () => {
  it("writes only the lessons record, so the interrupted action resumes as it was", async () => {
    const h = project();
    h.writeFile("src/app.ts", "work in progress\n");
    const state = h.readState();
    const review = h.runAction("review");
    const files = h.snapshot();

    await proposeLesson(h.root, LESSON, dependencies(h, jev({ "lesson-retention": [retain()] })));
    decideLesson(h.root, "L-1", { outcome: "retained", by: "agent" }, { now });

    expect(h.readState()).toEqual(state);
    expect(h.runAction("review")).toEqual(review);
    const after = h.snapshot();
    const paths = new Set([...Object.keys(files), ...Object.keys(after)]);
    const changed = [...paths].filter((path) => after[path] !== files[path] && !path.startsWith(".jflow/"));
    expect(changed).toEqual(["jflow/lessons.json"]);
    expect(h.events).toEqual([]);
  });

  it("is reached from a conversational request and asks for no authorization", () => {
    const h = project();

    expect(h.request("we learned that the fixture clock must be reset")).toMatchObject({ kind: "ready", action: "learn" });
    expect(h.events).toEqual([]);
  });
});
