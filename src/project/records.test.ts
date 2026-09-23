import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RECORD_KINDS,
  RecordValidationError,
  readRecord,
  recordPath,
  writeRecord,
  type JevRecord,
  type LessonsRecord,
  type PlanRecord,
  type ProgressRecord,
  type ProjectRecords,
  type ResumeRecord,
  type SpecificationRecord,
  type TicketsRecord,
} from "./records.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jflow-records-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One fully populated example of every record kind, for round-trip checks. */
const examples: ProjectRecords = {
  specification: {
    title: "Export to CSV",
    problem: "Users cannot get their data out.",
    scenarios: ["A user exports a filtered list", "An empty list exports a header only"],
    acceptanceCriteria: ["The file opens in a spreadsheet", "Filters apply to the export"],
    constraints: ["No new runtime dependency"],
    exclusions: ["Scheduled exports"],
    decisions: [
      { id: "D1", statement: "UTF-8 with BOM", status: "confirmed", basis: "Excel default" },
      { id: "D2", statement: "Semicolon separator in sv-SE", status: "rejected" },
    ],
    status: "accepted",
    writtenAt: "2026-09-22T09:00:00Z",
    acceptedAt: "2026-09-22T10:00:00Z",
    acceptanceNote: "yes, that is what I want",
  },
  plan: {
    title: "Foundation slice",
    summary: "Workflow package, records and the action seam.",
    source: "SPEC.md",
    status: "accepted",
    writtenAt: "2026-09-22T09:00:00Z",
    acceptedAt: "2026-09-22T10:00:00Z",
    acceptanceNote: "looks good",
  },
  tickets: {
    tickets: [
      {
        id: "T1",
        title: "Project scaffold",
        acceptanceCriteria: ["npm test passes on an empty suite"],
        dependsOn: [],
        status: "done",
        commit: "8c73d74",
      },
      {
        id: "T2",
        title: "Record store",
        acceptanceCriteria: ["every record round-trips"],
        dependsOn: ["T1"],
        status: "parked",
        parkedReason: "waiting on a decision about lesson scope",
      },
    ],
  },
  progress: {
    executionAuthorized: true,
    authorizationScope: "ticket",
    authorizationNote: "approved, implement ticket 2",
    assignedTicketId: "T2",
    ticketChangesPresent: true,
    fixAttempts: { T2: 1 },
    changeOwnership: [
      { path: "notes.md", owner: "developer", note: "that's mine, leave it" },
      { path: "src/draft.ts", owner: "ticket", ticketId: "T2", note: "part of ticket 2" },
    ],
    reconciliation: {
      lastReconciledAt: "2026-09-20T10:00:00Z",
      discrepancies: [
        { ticketId: "T2", summary: "test file missing", consequential: false },
      ],
    },
  },
  lessons: {
    lessons: [
      {
        id: "L1",
        statement: "Vitest needs isolate:false for speed here.",
        scope: "test tooling",
        evidence: [{ kind: "commit", reference: "7c7ec7b" }],
        status: "active",
      },
      {
        id: "L2",
        statement: "Records live in .jflow",
        scope: "records",
        evidence: [{ kind: "file", reference: "src/project/state.ts" }],
        status: "superseded",
        supersededBy: "L3",
        supersededEvidence: "D23 keeps .jflow local-only; records live in jflow/",
      },
      {
        id: "L3",
        statement: "Records live in jflow/",
        scope: "records",
        evidence: [{ kind: "decision", reference: "D23" }],
        status: "candidate",
      },
    ],
  },
  jev: {
    fallback: {
      status: "approved",
      pendingDecision: "escalate",
      reason: "retries exhausted",
      scope: "ticket",
      scopeId: "T2",
      approvedAt: "2026-09-20T11:00:00Z",
      traceReference: "traces/2026-09-20T11-00-00Z-escalate.json",
    },
  },
  resume: {
    writtenAt: "2026-09-20T12:00:00Z",
    summary: "T1 done, T2 parked.",
    activeTicketId: "T2",
    unresolvedTodos: ["split classify by kind"],
    nextSteps: ["resolve the lesson-scope decision, then resume T2"],
  },
};

describe("readRecord", () => {
  it("reports every record of an empty project as absent", () => {
    const root = makeRoot();

    for (const kind of RECORD_KINDS) {
      expect(readRecord(root, kind).kind, kind).toBe("absent");
    }
  });

  it.each(RECORD_KINDS)("round-trips a %s record losslessly", (kind) => {
    const root = makeRoot();

    writeRecord(root, kind, examples[kind]);
    const result = readRecord(root, kind);

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.record).toEqual(examples[kind]);
  });

  it("reads a record written by hand, so a fresh session depends on the file alone", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(
      recordPath(root, "resume"),
      `{\n  "writtenAt": "2026-09-20T12:00:00Z",\n  "summary": "T1 done.",\n  "nextSteps": ["start T2"]\n}\n`,
    );

    expect(readRecord(root, "resume")).toEqual({
      kind: "present",
      record: { writtenAt: "2026-09-20T12:00:00Z", summary: "T1 done.", nextSteps: ["start T2"] },
    });
  });

  it("reports an empty file as malformed rather than as an absent record", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(recordPath(root, "plan"), "");

    expect(readRecord(root, "plan").kind).toBe("malformed");
  });

  it("keeps a pending Jev decision while approval is awaited, and requires its name", () => {
    const root = makeRoot();
    writeRecord(root, "jev", {
      fallback: { status: "awaiting-approval", pendingDecision: "validate", reason: "timeout" },
    });
    expect(readRecord(root, "jev").kind).toBe("present");

    expect(() =>
      writeRecord(root, "jev", { fallback: { status: "awaiting-approval", reason: "timeout" } }),
    ).toThrow(/pendingDecision/);
  });

  it("requires an approved fallback and an authorized execution to record their scope", () => {
    const root = makeRoot();

    expect(() => writeRecord(root, "jev", { fallback: { status: "approved" } })).toThrow(
      /fallback\.scope/,
    );
    expect(() =>
      writeRecord(root, "progress", { executionAuthorized: true, ticketChangesPresent: false }),
    ).toThrow(/authorizationScope/);
  });

  it("requires each claimed change to name one owner in the developer's words", () => {
    const root = makeRoot();
    const progress = (changeOwnership: unknown) =>
      writeRecord(root, "progress", {
        executionAuthorized: false,
        ticketChangesPresent: false,
        changeOwnership,
      } as never);

    expect(() => progress([{ path: "a.ts", owner: "ticket", note: "yes" }])).toThrow(
      /changeOwnership\[0\]\.ticketId/,
    );
    expect(() =>
      progress([{ path: "a.ts", owner: "developer", ticketId: "T1", note: "mine" }]),
    ).toThrow(/changeOwnership\[0\]\.ticketId/);
    expect(() => progress([{ path: "a.ts", owner: "someone", note: "?" }])).toThrow(
      /changeOwnership\[0\]\.owner/,
    );
    expect(() => progress([{ path: "a.ts", owner: "developer" }])).toThrow(
      /changeOwnership\[0\]\.note/,
    );
    expect(() =>
      progress([
        { path: "a.ts", owner: "developer", note: "mine" },
        { path: "a.ts", owner: "ticket", ticketId: "T1", note: "no, the ticket's" },
      ]),
    ).toThrow(/changeOwnership\[1\]\.path/);
  });

  it("rejects a timestamp that is not ISO 8601", () => {
    const root = makeRoot();

    expect(() =>
      writeRecord(root, "resume", { writtenAt: "yesterday", summary: "s" }),
    ).toThrow(/ISO 8601/);
  });

  it("reports invalid JSON as malformed, naming the file", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(recordPath(root, "plan"), "{ truncated");

    const result = readRecord(root, "plan");

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.path).toBe(recordPath(root, "plan"));
    expect(result.issues[0]?.message).toContain("not valid JSON");
  });

  it("reports a record with the wrong shape as malformed with the offending path", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(
      recordPath(root, "tickets"),
      JSON.stringify({
        tickets: [{ id: "T1", title: "x", status: "finished", acceptanceCriteria: [], dependsOn: [] }],
      }),
    );

    const result = readRecord(root, "tickets");

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("tickets[0].status");
    expect(paths).toContain("tickets[0].acceptanceCriteria");
  });

  it("rejects a ticket depending on a ticket the plan does not contain", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(
      recordPath(root, "tickets"),
      JSON.stringify({
        tickets: [
          { id: "T1", title: "x", acceptanceCriteria: ["a"], dependsOn: ["T9"], status: "ready" },
        ],
      }),
    );

    const result = readRecord(root, "tickets");

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.issues).toContainEqual({
      path: "tickets[0].dependsOn[0]",
      message: 'depends on unknown ticket "T9"',
    });
  });

  it("rejects an accepted specification that still carries a proposal or lacks its acceptance time", () => {
    const root = makeRoot();
    const base = examples.specification;

    expect(() =>
      writeRecord(root, "specification", {
        ...base,
        decisions: [{ id: "D9", statement: "maybe", status: "proposed" }],
      }),
    ).toThrow(/D9.*still a proposal/);
    const { acceptedAt: _at, ...withoutTime } = base;
    expect(() => writeRecord(root, "specification", withoutTime)).toThrow(/acceptedAt/);
    expect(() =>
      writeRecord(root, "specification", { ...base, status: "awaiting-acceptance" }),
    ).toThrow(/acceptedAt/);
  });

  it("requires a specification to carry scenarios and acceptance criteria", () => {
    const root = makeRoot();

    expect(() =>
      writeRecord(root, "specification", { ...examples.specification, scenarios: [] }),
    ).toThrow(/scenarios/);
    expect(() =>
      writeRecord(root, "specification", { ...examples.specification, acceptanceCriteria: [] }),
    ).toThrow(/acceptanceCriteria/);
  });

  it("rejects an accepted plan without its acceptance time", () => {
    const root = makeRoot();
    const { acceptedAt: _at, ...withoutTime } = examples.plan;

    expect(() => writeRecord(root, "plan", withoutTime)).toThrow(/acceptedAt/);
  });

  it("rejects a superseded lesson that names no successor or evidence", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(
      recordPath(root, "lessons"),
      JSON.stringify({
        lessons: [
          {
            id: "L1",
            statement: "x",
            scope: "y",
            evidence: [{ kind: "file", reference: "z" }],
            status: "superseded",
          },
        ],
      }),
    );

    const result = readRecord(root, "lessons");

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("lessons[0].supersededBy");
    expect(paths).toContain("lessons[0].supersededEvidence");
  });

  it("never treats a malformed record as empty", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(recordPath(root, "lessons"), "null");

    const result = readRecord(root, "lessons");

    expect(result.kind).toBe("malformed");
  });
});

describe("writeRecord", () => {
  it("refuses an invalid record and leaves the file untouched", () => {
    const root = makeRoot();
    writeRecord(root, "plan", examples.plan);
    const before = readRecord(root, "plan");

    expect(() =>
      writeRecord(root, "plan", { ...examples.plan, title: 7 } as unknown as PlanRecord),
    ).toThrow(RecordValidationError);
    expect(readRecord(root, "plan")).toEqual(before);
  });

  it("rejects an undeclared key so a raw trace body cannot land in a record", () => {
    const root = makeRoot();
    const withTrace = {
      ...examples.jev,
      fallback: { ...examples.jev.fallback, response: { body: "raw Jev reply" } },
    } as unknown as JevRecord;

    let caught: unknown;
    try {
      writeRecord(root, "jev", withTrace);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordValidationError);
    expect((caught as RecordValidationError).issues.map((issue) => issue.path)).toContain(
      "fallback.response",
    );
  });

  it("rejects a credential-looking key anywhere in a record", () => {
    const root = makeRoot();
    const leaking = {
      lessons: [
        {
          ...examples.lessons.lessons[0]!,
          evidence: [{ kind: "note", reference: "x", apiKey: "sk-secret" }],
        },
      ],
    } as unknown as LessonsRecord;

    let caught: unknown;
    try {
      writeRecord(root, "lessons", leaking);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordValidationError);
    expect((caught as RecordValidationError).issues).toContainEqual({
      path: "lessons[0].evidence[0].apiKey",
      message: expect.stringContaining("secrets must never be stored") as string,
    });
  });

  it("rejects a credential-looking value in a string field", () => {
    const root = makeRoot();
    const leaking: ResumeRecord = {
      ...examples.resume,
      summary: "Use JFLOW_JEV_API_KEY=sk-live-abcdef0123456789 to continue",
    };

    let caught: unknown;
    try {
      writeRecord(root, "resume", leaking);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordValidationError);
    expect((caught as RecordValidationError).issues.map((issue) => issue.path)).toEqual([
      "summary",
    ]);
  });

  it("does not mistake ordinary prose about tokens or passwords for a credential", () => {
    const root = makeRoot();

    writeRecord(root, "resume", {
      ...examples.resume,
      summary: "The password: rotated quarterly; the review token: acceptance criteria.",
    });

    expect(readRecord(root, "resume").kind).toBe("present");
  });

  it("does not scan on read, so an already written record stays readable", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(
      recordPath(root, "resume"),
      JSON.stringify({ writtenAt: "2026-09-20T12:00:00Z", summary: "token=abcdefghijklmnopqrstu" }),
    );

    expect(readRecord(root, "resume").kind).toBe("present");
  });

  it("writes through a temporary file and leaves only the record behind", () => {
    const root = makeRoot();

    writeRecord(root, "progress", examples.progress);

    expect(readdirSync(join(root, "jflow"))).toEqual(["progress.json"]);
    expect(existsSync(recordPath(root, "progress"))).toBe(true);
  });

  it("keeps each record kind in its own file under jflow/", () => {
    for (const kind of RECORD_KINDS) {
      expect(recordPath("/p", kind)).toBe(`/p/jflow/${kind}.json`);
    }
  });
});

describe("record types", () => {
  it("accept the minimal shape of each record", () => {
    const root = makeRoot();
    const minimal: ProjectRecords = {
      specification: {
        title: "t",
        problem: "p",
        scenarios: ["s"],
        acceptanceCriteria: ["a"],
        constraints: [],
        exclusions: [],
        decisions: [],
        status: "awaiting-acceptance",
        writtenAt: "2026-09-22T09:00:00Z",
      },
      plan: { title: "t", summary: "s", status: "awaiting-acceptance", writtenAt: "2026-09-22T09:00:00Z" },
      tickets: { tickets: [] },
      progress: {
        executionAuthorized: false,
        ticketChangesPresent: false,
      },
      lessons: { lessons: [] },
      jev: { fallback: { status: "off" } },
      resume: { writtenAt: "2026-09-20T12:00:00Z", summary: "s" },
    };

    for (const kind of RECORD_KINDS) {
      writeRecord(root, kind, minimal[kind]);
      const result = readRecord(root, kind);
      expect(result.kind, kind).toBe("present");
      if (result.kind !== "present") continue;
      expect(result.record, kind).toEqual(minimal[kind]);
    }

    const _typed: [
      SpecificationRecord,
      PlanRecord,
      TicketsRecord,
      ProgressRecord,
      LessonsRecord,
      JevRecord,
      ResumeRecord,
    ] = [
      minimal.specification,
      minimal.plan,
      minimal.tickets,
      minimal.progress,
      minimal.lessons,
      minimal.jev,
      minimal.resume,
    ];
    expect(_typed).toHaveLength(7);
  });
});
