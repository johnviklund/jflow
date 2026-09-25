import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  readRecord,
  writeRecord,
  type LessonRecord,
  type PlanRecord,
  type ProgressRecord,
  type ResumeRecord,
  type TicketRecord,
} from "../project/records.js";
import { ensureLocalDirectory, TRACE_DIRECTORY } from "../jev/traces.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { wrapSession } from "./wrap.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-25T18:00:00.000Z";
const git = (h: ProjectHarness, ...args: string[]) => execFileSync("git", args, { cwd: h.root, encoding: "utf8" });

const PLAN: PlanRecord = {
  title: "CSV importer",
  summary: "Import CSV files into the store.",
  status: "accepted",
  writtenAt: "2026-09-20T10:00:00Z",
  acceptedAt: "2026-09-20T11:00:00Z",
};

const ticket = (id: string, status: TicketRecord["status"], extra: Partial<TicketRecord> = {}): TicketRecord => ({
  id,
  title: `Ticket ${id}`,
  acceptanceCriteria: [`${id} works`],
  dependsOn: [],
  status,
  ...extra,
});

const advice = { envelope: "ENV-1", answer: "retain", reasonCode: "evidence-backed", route: "weigh" };
const LESSONS: LessonRecord[] = [
  {
    id: "L-1",
    statement: "Reset the fixture clock.",
    scope: "src/parser tests",
    evidence: [{ kind: "commit", reference: "a1b2c3d" }],
    status: "active",
    retention: { advice, decision: { outcome: "retained", by: "agent", decidedAt: "2026-09-24T10:00:00Z" } },
  },
  {
    id: "L-2",
    statement: "Windows may be slow.",
    scope: "src/importer",
    evidence: [{ kind: "note", reference: "seen once" }],
    status: "candidate",
    retention: { advice },
  },
  {
    id: "L-3",
    statement: "Use a CSV library.",
    scope: "src/parser",
    evidence: [{ kind: "check", reference: "npm test -- quoting" }],
    status: "candidate",
    retention: { advice, conflict: { with: ["D1"], escalation: "ENV-2" } },
  },
  {
    id: "L-4",
    statement: "Run importer tests serially.",
    scope: "src/importer tests",
    evidence: [{ kind: "commit", reference: "0f0f0f0" }],
    status: "superseded",
    supersededBy: "L-1",
    supersededEvidence: "commit 9e9e9e9",
  },
  {
    id: "L-5",
    statement: "Quoted fields need the tokenizer.",
    scope: "src/parser",
    evidence: [{ kind: "check", reference: "npm test -- quoting" }],
    status: "active",
    retention: { advice, decision: { outcome: "retained", by: "developer", reason: "keep", decidedAt: "2026-09-24T10:00:00Z" } },
    checks: [{ task: "T2", outcome: "contradicted", reason: "split() passes now", evidence: ["npm test"], checkedAt: "2026-09-25T10:00:00Z" }],
  },
  {
    id: "L-6",
    statement: "The importer might leak file handles.",
    scope: "src/importer",
    evidence: [{ kind: "note", reference: "seen once" }],
    status: "candidate",
    retention: { advice, decision: { outcome: "candidate", by: "agent", reason: "speculative", decidedAt: "2026-09-24T10:00:00Z" } },
  },
];

/**
 * Mid-plan under whole-plan authorization: T1 done at a real commit, T2 in
 * progress with changes, T3 parked on a blocker, T4 ready; todos, lessons in
 * every state and a raw trace on disk.
 */
function project(progress: Partial<ProgressRecord> = {}): { readonly h: ProjectHarness; readonly commit: string } {
  const h = createProjectHarness({ gitRepository: true });
  harnesses.push(h);
  h.writeFile("README.md", "importer\n");
  git(h, "add", "README.md");
  git(h, "commit", "--quiet", "-m", "T1");
  const commit = git(h, "rev-parse", "HEAD").trim();

  writeRecord(h.root, "specification", {
    title: "CSV importer",
    problem: "Imports are slow.",
    scenarios: ["import"],
    acceptanceCriteria: ["imports"],
    constraints: [],
    exclusions: [],
    decisions: [{ id: "D1", statement: "Standard library only.", status: "confirmed", basis: "developer" }],
    status: "accepted",
    writtenAt: "2026-09-20T09:00:00Z",
    acceptedAt: "2026-09-20T09:30:00Z",
  });
  writeRecord(h.root, "plan", PLAN);
  writeRecord(h.root, "tickets", {
    tickets: [
      ticket("T1", "done", { commit }),
      ticket("T2", "in-progress"),
      ticket("T3", "parked", { parkedReason: "waiting on the export format decision" }),
      ticket("T4", "ready", { dependsOn: ["T2"] }),
    ],
  });
  writeRecord(h.root, "progress", {
    executionAuthorized: true,
    authorizationScope: "plan",
    authorizationNote: "implement the whole plan",
    assignedTicketId: "T2",
    ticketChangesPresent: true,
    fixAttempts: { T2: 1 },
    ...progress,
  });
  writeRecord(h.root, "todos", {
    items: [
      { id: "TODO-1", summary: "CSV export drops the header row", recordedAt: "2026-09-24T10:00:00Z", status: "open", discoveredDuring: "T2" },
      { id: "TODO-2", summary: "Rename tok", recordedAt: "2026-09-24T10:00:00Z", status: "promoted", promotion: { decidedAt: "2026-09-24T11:00:00Z", note: "yes" } },
    ],
  });
  writeRecord(h.root, "lessons", { lessons: LESSONS });
  h.writeFile("src/parser.ts", "work in progress\n");
  ensureLocalDirectory(h.root, TRACE_DIRECTORY);
  h.writeFile(`${TRACE_DIRECTORY}/TRACE-1.json`, "{}\n");
  return { h, commit };
}

const DRAFT = {
  summary: "T2's date parsing is half done; the fix for the timezone test is next.",
  nextSteps: ["finish T2's timezone handling", "run npm test -- parser"],
};

const resumeOf = (h: ProjectHarness): ResumeRecord => {
  const read = readRecord(h.root, "resume");
  if (read.kind !== "present") throw new Error("no resume record");
  return read.record;
};

describe("wrap writes a resume record a fresh session can continue from", () => {
  it("covers the plan, outcomes, the active ticket, parked tickets with blockers, unresolved todos, lesson state and the next step", () => {
    const { h, commit } = project();

    const result = wrapSession(h.root, DRAFT, h.context, { now });

    expect(result).toMatchObject({ ok: true, outcome: { record: "jflow/resume.json", discrepancies: [] } });
    expect(resumeOf(h)).toEqual({
      writtenAt: now,
      summary: DRAFT.summary,
      nextSteps: DRAFT.nextSteps,
      plan: { title: "CSV importer", status: "accepted", executionAuthorized: true, authorizationScope: "plan", authorizationNote: "implement the whole plan" },
      activeTicketId: "T2",
      outcomes: [
        { ticketId: "T1", title: "Ticket T1", status: "done", commit },
        { ticketId: "T2", title: "Ticket T2", status: "in-progress", note: "1 fix attempt; not yet validated" },
        { ticketId: "T3", title: "Ticket T3", status: "parked" },
        { ticketId: "T4", title: "Ticket T4", status: "ready" },
      ],
      parkedTickets: [{ ticketId: "T3", blocker: "waiting on the export format decision" }],
      unresolvedTodos: ["TODO-1: CSV export drops the header row (found during T2)"],
      lessons: {
        active: ["L-1", "L-5"],
        candidates: ["L-2", "L-6"],
        undecided: ["L-2"],
        awaitingDeveloper: ["L-3"],
        contradicted: ["L-5"],
        superseded: ["L-4"],
      },
      recommendation: { action: expect.any(String), reason: expect.any(String) },
      uncommittedChanges: ["src/parser.ts"],
      discrepancies: [],
    });
  });

  it("needs a summary of the session, and refuses nothing else it cannot read", () => {
    const { h } = project();

    expect(wrapSession(h.root, { summary: " " }, h.context, { now })).toMatchObject({ ok: false, reason: expect.stringContaining("summary") });
    expect(wrapSession(h.root, { summary: "s", nextSteps: "run tests" as never }, h.context, { now })).toMatchObject({ ok: false });
    expect(readRecord(h.root, "resume").kind).toBe("absent");
  });

  it("works before any plan exists", () => {
    const h = createProjectHarness();
    harnesses.push(h);

    const result = wrapSession(h.root, { summary: "explored the problem; nothing recorded yet" }, h.context, { now });

    expect(result).toMatchObject({ ok: true });
    expect(resumeOf(h)).toMatchObject({ summary: "explored the problem; nothing recorded yet", recommendation: { action: "brainstorm" } });
  });
});

describe("wrap reports discrepancies and reconciles none of them", () => {
  it("reports a done ticket whose commit the repository does not have, and leaves the ticket as recorded", () => {
    const { h } = project();
    const tickets = readRecord(h.root, "tickets");
    if (tickets.kind !== "present") throw new Error("no tickets");
    writeRecord(h.root, "tickets", {
      tickets: tickets.record.tickets.map((entry) => (entry.id === "T1" ? { ...entry, commit: "0123456789abcdef0123456789abcdef01234567" } : entry)),
    });
    const before = h.snapshot()["jflow/tickets.json"];

    const result = wrapSession(h.root, DRAFT, h.context, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: { discrepancies: [{ ticketId: "T1", source: "records", summary: expect.stringContaining("0123456") }] },
    });
    expect(resumeOf(h).discrepancies).toHaveLength(1);
    expect(h.snapshot()["jflow/tickets.json"]).toBe(before);
  });

  it("reports an assigned ticket that is not in progress, and changes recorded present on a clean tree", () => {
    const { h } = project({ assignedTicketId: "T4" });
    execFileSync("rm", [h.path("src/parser.ts")]);

    const result = wrapSession(h.root, DRAFT, h.context, { now });

    if (!result.ok) throw new Error(result.reason);
    const summaries = result.outcome.discrepancies.map((entry) => entry.summary).join("\n");
    expect(summaries).toContain("T4");
    expect(summaries).toContain("T2");
    expect(summaries).toContain("no uncommitted changes");
  });

  it("reports uncommitted changes no one owns, and a ticket that passed review but is not recorded done", () => {
    const { h } = project({
      ticketChangesPresent: false,
      reviews: {
        T2: {
          reviewer: { agent: "reviewer-1", model: "m" },
          disposition: "passed",
          findings: [],
          reviewedAt: "2026-09-25T12:00:00Z",
        },
      },
    });

    const result = wrapSession(h.root, DRAFT, h.context, { now });

    if (!result.ok) throw new Error(result.reason);
    const summaries = result.outcome.discrepancies.map((entry) => entry.summary).join("\n");
    expect(summaries).toContain("src/parser.ts");
    expect(summaries).toContain("passed review");
  });

  it("reports a done ticket without a commit, and keeps reporting discrepancies recorded earlier", () => {
    const { h } = project({
      reconciliation: { discrepancies: [{ ticketId: "T3", summary: "T3's blocker was lifted upstream", consequential: true }] },
    });
    const tickets = readRecord(h.root, "tickets");
    if (tickets.kind !== "present") throw new Error("no tickets");
    writeRecord(h.root, "tickets", {
      tickets: tickets.record.tickets.map((entry) => (entry.id === "T4" ? { ...entry, status: "done" as const } : entry)),
    });

    const result = wrapSession(h.root, DRAFT, h.context, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        discrepancies: [
          { ticketId: "T3", source: "records", summary: "T3's blocker was lifted upstream" },
          { ticketId: "T4", source: "records", summary: "T4 is recorded done without a commit" },
        ],
      },
    });
  });

  it("carries a Jev fallback waiting for approval into the resume record", () => {
    const { h } = project();
    writeRecord(h.root, "jev", {
      fallback: { status: "awaiting-approval", pendingDecision: "validate", reason: "timeout", traceReference: ".jflow/traces/TRACE-1.json" },
    });

    wrapSession(h.root, DRAFT, h.context, { now });

    expect(resumeOf(h).jevFallback).toEqual({ status: "awaiting-approval", pendingDecision: "validate" });
  });

  it("records the discrepancies the agent found beside the helper's, as the agent's", () => {
    const { h } = project();

    const result = wrapSession(
      h.root,
      { ...DRAFT, discrepancies: [{ ticketId: "T1", summary: "npm test -- importer fails on main although T1 is done" }] },
      h.context,
      { now },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { discrepancies: [{ ticketId: "T1", source: "agent", summary: "npm test -- importer fails on main although T1 is done" }] },
    });
    const tickets = readRecord(h.root, "tickets");
    expect(tickets.kind === "present" && tickets.record.tickets[0]).toMatchObject({ id: "T1", status: "done" });
  });
});

describe("wrap never acts outside the resume record", () => {
  it("writes only jflow/resume.json: no commit, push, merge or cleanup, and raw traces stay", () => {
    const { h } = project();
    const files = h.snapshot();
    const head = git(h, "rev-parse", "HEAD");
    const refs = git(h, "for-each-ref");
    const status = () => git(h, "status", "--porcelain=v1", "--untracked-files=all").split("\n").filter(Boolean).sort();
    const before = status();

    wrapSession(h.root, DRAFT, h.context, { now });

    const after = h.snapshot();
    const paths = new Set([...Object.keys(files), ...Object.keys(after)]);
    expect([...paths].filter((path) => after[path] !== files[path])).toEqual(["jflow/resume.json"]);
    expect(after[`${TRACE_DIRECTORY}/TRACE-1.json`]).toBe("{}\n");
    expect(git(h, "rev-parse", "HEAD")).toBe(head);
    expect(git(h, "for-each-ref")).toBe(refs);
    expect(status()).toEqual([...before, "?? jflow/resume.json"].sort());
  });
});
