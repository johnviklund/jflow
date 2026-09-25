import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { JevTransport, TransportRequest } from "../jev/client.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import { readRecord, recordPath, writeRecord, type LessonRecord, type SpecificationRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { activeLessons, checkLesson, supersedeLesson } from "./lesson-use.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T13:00:00.000Z";
const above = (decision: string) => {
  const threshold = confidenceThreshold(pkg, decision);
  return threshold + (1 - threshold) / 2;
};

const SPECIFICATION: SpecificationRecord = {
  title: "CSV importer",
  problem: "Imports are slow.",
  scenarios: ["import a file"],
  acceptanceCriteria: ["imports a file"],
  constraints: [],
  exclusions: [],
  decisions: [{ id: "D1", statement: "Parse CSV with the standard library only.", status: "confirmed", basis: "developer" }],
  status: "accepted",
  writtenAt: "2026-09-20T10:00:00Z",
  acceptedAt: "2026-09-20T11:00:00Z",
};

const advice = { envelope: "ENV-1", answer: "retain", reasonCode: "evidence-backed", route: "weigh" };

const CLOCK: LessonRecord = {
  id: "L-1",
  statement: "Reset the fixture clock before each parser test.",
  scope: "src/parser tests",
  evidence: [{ kind: "commit", reference: "a1b2c3d" }],
  status: "active",
  retention: { advice, decision: { outcome: "retained", by: "agent", decidedAt: "2026-09-24T10:00:00Z" } },
};

const QUOTING: LessonRecord = {
  id: "L-2",
  statement: "Quoted fields need the hand-written tokenizer, not split().",
  scope: "src/parser",
  evidence: [{ kind: "check", reference: "npm test -- quoting" }],
  status: "active",
  retention: {
    advice,
    decision: { outcome: "retained", by: "developer", reason: "keep it, it bit us twice", decidedAt: "2026-09-24T10:00:00Z" },
  },
};

const SPECULATIVE: LessonRecord = {
  id: "L-3",
  statement: "The importer may be slow on Windows.",
  scope: "src/importer",
  evidence: [{ kind: "note", reference: "seen once" }],
  status: "candidate",
  retention: { advice: { ...advice, answer: "discard", reasonCode: "speculative" } },
};

const RETIRED: LessonRecord = {
  id: "L-4",
  statement: "Run the importer tests serially.",
  scope: "src/importer tests",
  evidence: [{ kind: "commit", reference: "0f0f0f0" }],
  status: "superseded",
  supersededBy: "L-1",
  supersededEvidence: "commit 9e9e9e9 made the importer tests independent",
};

/** Mid-implementation, with an accepted specification and four lessons in every state. */
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
  writeRecord(h.root, "specification", SPECIFICATION);
  writeRecord(h.root, "lessons", { lessons: [CLOCK, QUOTING, SPECULATIVE, RETIRED] });
  return h;
}

type Answer = readonly [choice: string, reason: string, confidence: number];

function jev(answers: Answer[] = []): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    const answer = answers.shift();
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
  return Object.assign(transport, { sent });
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

const proceed = (): Answer => ["proceed", "routine", above("escalate")];
const escalate = (): Answer => ["escalate", "consequential", above("escalate")];

const lessonOf = (h: ProjectHarness, id: string) => {
  const read = readRecord(h.root, "lessons");
  if (read.kind !== "present") throw new Error("no lessons record");
  return read.record.lessons.find((lesson) => lesson.id === id)!;
};

const CONTRADICTION = {
  successor: "the parser now resets the clock itself (commit 7c7c7c7)",
  evidence: ["npm test -- parser passes without the fixture reset"],
};

describe("using a lesson: only retained lessons, each re-checked", () => {
  it("offers only retained lessons for use, never candidates or superseded ones", () => {
    const h = project();

    expect(activeLessons(h.root)).toMatchObject({
      ok: true,
      lessons: [
        { lesson: { id: "L-1" }, contradicted: false },
        { lesson: { id: "L-2" }, contradicted: false },
      ],
    });
  });

  it("records a check that the lesson applies to the task before it is used", () => {
    const h = project();

    const checked = checkLesson(
      h.root,
      "L-1",
      { task: "T1: add a date column to the parser", outcome: "applies", reason: "T1 adds parser tests that read the clock" },
      { now },
    );

    expect(checked).toMatchObject({ ok: true, outcome: { apply: true } });
    expect(lessonOf(h, "L-1").checks).toEqual([
      { task: "T1: add a date column to the parser", outcome: "applies", reason: "T1 adds parser tests that read the clock", checkedAt: now },
    ]);
  });

  it("skips a lesson that does not apply, with the reason recorded", () => {
    const h = project();

    const checked = checkLesson(
      h.root,
      "L-1",
      { task: "T2: CLI help text", outcome: "skipped", reason: "T2 touches no parser tests", evidence: ["src/cli.ts"] },
      { now },
    );

    expect(checked).toMatchObject({ ok: true, outcome: { apply: false } });
    expect(lessonOf(h, "L-1").checks).toEqual([
      { task: "T2: CLI help text", outcome: "skipped", reason: "T2 touches no parser tests", evidence: ["src/cli.ts"], checkedAt: now },
    ]);
    expect(lessonOf(h, "L-1").status).toBe("active");
  });

  it("refuses a check without the task or the reason", () => {
    const h = project();

    expect(checkLesson(h.root, "L-1", { task: " ", outcome: "applies", reason: "r" }, { now })).toMatchObject({ ok: false });
    expect(checkLesson(h.root, "L-1", { task: "T1", outcome: "skipped", reason: "" }, { now })).toMatchObject({ ok: false });
    expect(lessonOf(h, "L-1").checks).toBeUndefined();
  });

  it("refuses to apply a superseded lesson or a candidate", () => {
    const h = project();

    expect(checkLesson(h.root, "L-4", { task: "T1", outcome: "applies", reason: "r" }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("superseded"),
    });
    expect(checkLesson(h.root, "L-3", { task: "T1", outcome: "applies", reason: "r" }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("candidate"),
    });
    expect(checkLesson(h.root, "L-9", { task: "T1", outcome: "applies", reason: "r" }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("L-1"),
    });
  });
});

describe("superseding a contradicted lesson", () => {
  it("marks it superseded with the evidence and keeps it in history, unchanged otherwise", async () => {
    const h = project();
    const transport = jev();

    const result = await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, by: "agent" }, dependencies(h, transport));

    expect(result).toMatchObject({ ok: true, outcome: { superseded: true } });
    const lesson = lessonOf(h, "L-1");
    expect(lesson).toMatchObject({
      ...CLOCK,
      status: "superseded",
      supersededBy: CONTRADICTION.successor,
      supersededEvidence: CONTRADICTION.evidence.join("; "),
    });
    expect(lesson.checks).toEqual([
      expect.objectContaining({ outcome: "contradicted", evidence: CONTRADICTION.evidence, checkedAt: now }),
    ]);
    expect(transport.sent).toHaveLength(0);
    expect(activeLessons(h.root)).toMatchObject({ ok: true, lessons: [{ lesson: { id: "L-2" } }] });
    expect(checkLesson(h.root, "L-1", { task: "T3", outcome: "applies", reason: "r" }, { now })).toMatchObject({ ok: false });
  });

  it("refuses without evidence or a successor, and refuses a lesson that is not retained", async () => {
    const h = project();
    const transport = jev();

    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, evidence: [], by: "agent" }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, successor: "", by: "agent" }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(await supersedeLesson(h.root, "L-4", { ...CONTRADICTION, by: "agent" }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(await supersedeLesson(h.root, "L-3", { ...CONTRADICTION, by: "agent" }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(lessonOf(h, "L-1").status).toBe("active");
  });

  it("names a successor lesson only if it exists and is not the lesson itself", async () => {
    const h = project();
    const transport = jev();

    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, successor: "L-7", by: "agent" }, dependencies(h, transport))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("L-7"),
    });
    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, successor: "L-1", by: "agent" }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, successor: "L-3", by: "agent" }, dependencies(h, transport))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("candidate"),
    });
    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, successor: "L-4", by: "agent" }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, successor: "L-2", by: "agent" }, dependencies(h, transport))).toMatchObject({ ok: true });
  });
});

describe("supersession never silently changes a human decision", () => {
  const OVERTURN = {
    successor: "the standard library parser handles quotes since Node 26",
    evidence: ["npm test -- quoting passes with split-based parsing"],
  };

  it("asks escalate for a lesson the developer retained; on proceed their decision stands", async () => {
    const h = project();
    const transport = jev([proceed()]);

    const result = await supersedeLesson(h.root, "L-2", { ...OVERTURN, by: "agent" }, dependencies(h, transport));

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.body).toContain("lesson-conflict");
    expect(result).toMatchObject({ ok: true, outcome: { superseded: false } });
    const lesson = lessonOf(h, "L-2");
    expect(lesson.status).toBe("active");
    expect(lesson.supersededBy).toBeUndefined();
    expect(lesson.checks).toEqual([
      expect.objectContaining({ outcome: "contradicted", escalation: expect.stringMatching(/^ENV-/), evidence: OVERTURN.evidence }),
    ]);
    expect(activeLessons(h.root)).toMatchObject({ lessons: [{ lesson: { id: "L-1" } }, { lesson: { id: "L-2" }, contradicted: true }] });
    expect(checkLesson(h.root, "L-2", { task: "T1", outcome: "applies", reason: "still quoting" }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--evidence"),
    });
    expect(
      checkLesson(h.root, "L-2", { task: "T1", outcome: "applies", reason: "still quoting", evidence: ["npm test -- quoting fails with split()"] }, { now }),
    ).toMatchObject({ ok: true, outcome: { apply: true } });
  });

  it("on proceed supersedes a lesson whose contradiction only touches an accepted decision, leaving that decision as it was", async () => {
    const h = project();
    const specification = readFileSync(recordPath(h.root, "specification"), "utf8");

    const result = await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, conflictsWith: ["D1"], by: "agent" }, dependencies(h, jev([proceed()])));

    expect(result).toMatchObject({ ok: true, outcome: { superseded: true } });
    expect(lessonOf(h, "L-1").checks).toEqual([expect.objectContaining({ outcome: "contradicted", escalation: expect.stringMatching(/^ENV-/) })]);
    expect(readFileSync(recordPath(h.root, "specification"), "utf8")).toBe(specification);
  });

  it("on escalate asks the developer and changes nothing until they decide", async () => {
    const h = project();
    const before = readFileSync(recordPath(h.root, "lessons"), "utf8");

    const result = await supersedeLesson(h.root, "L-2", { ...OVERTURN, by: "agent" }, dependencies(h, jev([escalate()])));

    expect(result).toMatchObject({ ok: true, outcome: { superseded: false, askHuman: { kind: "human-ask", boundary: "lesson-conflict" } } });
    expect(readFileSync(recordPath(h.root, "lessons"), "utf8")).toBe(before);

    const decided = await supersedeLesson(
      h.root,
      "L-2",
      { ...OVERTURN, by: "developer", reason: "yes, retire it" },
      dependencies(h, jev()),
    );
    expect(decided).toMatchObject({ ok: true, outcome: { superseded: true } });
    expect(lessonOf(h, "L-2")).toMatchObject({ status: "superseded", supersededBy: OVERTURN.successor });
  });

  it("asks escalate when the contradiction touches an accepted decision, and never changes that decision", async () => {
    const h = project();
    const specification = readFileSync(recordPath(h.root, "specification"), "utf8");
    const transport = jev([escalate()]);

    const result = await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, conflictsWith: ["D1"], by: "agent" }, dependencies(h, transport));

    expect(transport.sent[0]!.body).toContain("standard library only");
    expect(result).toMatchObject({ ok: true, outcome: { superseded: false, askHuman: { boundary: "lesson-conflict" } } });
    expect(readFileSync(recordPath(h.root, "specification"), "utf8")).toBe(specification);

    await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, conflictsWith: ["D1"], by: "developer", reason: "retire the lesson" }, dependencies(h, jev()));
    expect(lessonOf(h, "L-1").status).toBe("superseded");
    expect(readFileSync(recordPath(h.root, "specification"), "utf8")).toBe(specification);
  });

  it("refuses a conflict id that is not an accepted decision, and the developer's decision without their words", async () => {
    const h = project();
    const transport = jev();

    expect(await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, conflictsWith: ["D9"], by: "agent" }, dependencies(h, transport))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("D1"),
    });
    expect(await supersedeLesson(h.root, "L-2", { ...CONTRADICTION, by: "developer" }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("lesson use mid-action", () => {
  it("writes only the lessons record, so the interrupted action resumes as it was", async () => {
    const h = project();
    h.writeFile("src/app.ts", "work in progress\n");
    const state = h.readState();
    const review = h.runAction("review");
    const files = h.snapshot();

    checkLesson(h.root, "L-1", { task: "T1", outcome: "applies", reason: "parser tests" }, { now });
    await supersedeLesson(h.root, "L-1", { ...CONTRADICTION, by: "agent" }, dependencies(h, jev()));
    await supersedeLesson(h.root, "L-2", { successor: "x", evidence: ["y"], by: "agent" }, dependencies(h, jev([escalate()])));

    expect(h.readState()).toEqual(state);
    expect(h.runAction("review")).toEqual(review);
    const after = h.snapshot();
    const paths = new Set([...Object.keys(files), ...Object.keys(after)]);
    expect([...paths].filter((path) => after[path] !== files[path] && !path.startsWith(".jflow/"))).toEqual(["jflow/lessons.json"]);
    expect(h.events).toEqual([]);
  });
});
