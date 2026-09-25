import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { readRecord, writeRecord, type ProgressRecord, type TicketValidation } from "../project/records.js";
import { readWorkingTree } from "../project/worktree.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { startReview } from "./review.js";
import { applyDiagnosis, recordDiagnosis, startDiagnosis } from "./troubleshoot.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-25T14:00:00.000Z";
const FAILED = { source: "npm test -- parser", text: "1 failed: expected [] got undefined", exitCode: 1 };
const FOUND = {
  finding: "parse returns early on empty input without a value",
  evidence: ["src/parser.ts:3", "npm test -- parser: expected [] got undefined"],
  recommendation: "return [] when the input is empty",
};

/** T1 started under ticket authorization in a repository with one commit and the ticket's failing work. */
function project(progress: Partial<ProgressRecord> = {}, gitRepository = true): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository });
  harnesses.push(h);
  if (gitRepository) {
    h.writeFile("README.md", "readme\n");
    execFileSync("git", ["add", "README.md"], { cwd: h.root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: h.root });
  }
  writeRecord(h.root, "tickets", {
    tickets: [{ id: "T1", title: "Parser", acceptanceCriteria: ["parses an empty file"], dependsOn: [], status: "in-progress" }],
  });
  writeRecord(h.root, "progress", {
    executionAuthorized: true,
    authorizationScope: "ticket",
    authorizationNote: "implement T1",
    assignedTicketId: "T1",
    ticketChangesPresent: true,
    ...progress,
  });
  h.writeFile("src/parser.ts", "export const parse = (s: string) => { if (s === '') return; };\n");
  return h;
}

const diagnosesOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "diagnoses");
  return read.kind === "present" ? read.record.diagnoses : [];
};

function started(h: ProjectHarness): string {
  const result = startDiagnosis(h.root, { check: FAILED }, { now });
  if (!result.ok) throw new Error(result.reason);
  return result.outcome.diagnosis.id;
}

describe("routing a failed check to troubleshoot", () => {
  it("records the failure against the ticket with a snapshot of the working tree", () => {
    const h = project();

    const result = startDiagnosis(h.root, { check: FAILED }, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        diagnosis: {
          id: "DIAG-1",
          ticketId: "T1",
          status: "diagnosing",
          check: { source: "npm test -- parser", exitCode: 1, excerpt: FAILED.text },
          baseline: { head: expect.any(String), files: [{ path: "src/parser.ts", sha256: expect.any(String) }] },
        },
      },
    });
    expect(diagnosesOf(h)).toHaveLength(1);
  });

  it("keeps only the end of a long check output", () => {
    const h = project();

    const result = startDiagnosis(h.root, { check: { ...FAILED, text: `${"x".repeat(5000)}THE ERROR` } }, { now });

    if (!result.ok) throw new Error(result.reason);
    expect(result.outcome.diagnosis.check.excerpt.length).toBeLessThanOrEqual(2000);
    expect(result.outcome.diagnosis.check.excerpt.endsWith("THE ERROR")).toBe(true);
  });

  it("refuses a check that passed, one with no command, or one for a ticket not in the plan", () => {
    const h = project();

    expect(startDiagnosis(h.root, { check: { ...FAILED, exitCode: 0 } }, { now })).toMatchObject({ ok: false });
    expect(startDiagnosis(h.root, { check: { ...FAILED, source: " " } }, { now })).toMatchObject({ ok: false });
    expect(startDiagnosis(h.root, { ticketId: "T9", check: FAILED }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("T9"),
    });
    expect(diagnosesOf(h)).toEqual([]);
  });
});

describe("recording the diagnosis", () => {
  it("records the finding, evidence and recommended fix once the working tree is confirmed unchanged", () => {
    const h = project();
    const id = started(h);
    const files = h.snapshot();
    const tree = readWorkingTree(h.root);

    const result = recordDiagnosis(h.root, { id, ...FOUND }, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: { diagnosis: { id, status: "diagnosed", diagnosis: { ...FOUND, recordedAt: now, treeCheck: "unchanged" } } },
    });
    const { ["jflow/diagnoses.json"]: _diagnoses, ...rest } = h.snapshot();
    const { ["jflow/diagnoses.json"]: _before, ...restBefore } = files;
    expect(rest).toEqual(restBefore);
    expect(readWorkingTree(h.root)).toEqual(tree);
  });

  it("refuses the diagnosis when the working tree changed while troubleshooting, naming what changed", () => {
    const h = project();
    const id = started(h);
    h.writeFile("src/parser.ts", "export const parse = () => [];\n");
    h.writeFile("scratch.ts", "tried something\n");

    const result = recordDiagnosis(h.root, { id, ...FOUND }, { now });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("scratch.ts, src/parser.ts") });
    expect(diagnosesOf(h)[0]).toMatchObject({ status: "diagnosing" });
    expect(diagnosesOf(h)[0]).not.toHaveProperty("diagnosis");
  });

  it("says so when there is no repository to confirm the working tree against", () => {
    const h = project({}, false);
    const id = started(h);

    expect(recordDiagnosis(h.root, { id, ...FOUND }, { now })).toMatchObject({
      ok: true,
      outcome: { diagnosis: { diagnosis: { treeCheck: "unverified" } } },
    });
  });

  it("refuses a diagnosis without a finding or a recommended fix, or for an entry already diagnosed", () => {
    const h = project();
    const id = started(h);

    expect(recordDiagnosis(h.root, { id, ...FOUND, finding: "" }, { now })).toMatchObject({ ok: false });
    expect(recordDiagnosis(h.root, { id, ...FOUND, recommendation: " " }, { now })).toMatchObject({ ok: false });
    recordDiagnosis(h.root, { id, ...FOUND }, { now });
    expect(recordDiagnosis(h.root, { id, ...FOUND }, { now })).toMatchObject({ ok: false, reason: expect.stringContaining("diagnosed") });
  });
});

describe("applying the recommended fix", () => {
  it("is recorded against the authorized ticket in progress", () => {
    const h = project();
    const id = started(h);
    recordDiagnosis(h.root, { id, ...FOUND }, { now });

    const result = applyDiagnosis(h.root, { id, note: "returned [] for empty input" }, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: { diagnosis: { status: "applied", application: { ticketId: "T1", appliedAt: now, note: "returned [] for empty input" } } },
    });
  });

  it("gives a diagnosis made with no ticket assigned to the ticket that applies it, so its reviewer sees it", () => {
    const h = project();
    const progress = readRecord(h.root, "progress");
    if (progress.kind !== "present") throw new Error("no progress");
    const { assignedTicketId: _none, ...unassigned } = progress.record;
    writeRecord(h.root, "progress", unassigned);
    const id = started(h);
    expect(readRecord(h.root, "diagnoses")).toMatchObject({ record: { diagnoses: [{ id }] } });
    expect(readRecord(h.root, "diagnoses")).not.toHaveProperty("record.diagnoses.0.ticketId");
    recordDiagnosis(h.root, { id, ...FOUND }, { now });
    writeRecord(h.root, "progress", progress.record);

    expect(applyDiagnosis(h.root, { id }, { now })).toMatchObject({
      ok: true,
      outcome: { diagnosis: { ticketId: "T1", application: { ticketId: "T1" } } },
    });
  });

  it("is refused without execution authorization, before the diagnosis, or for another ticket's diagnosis", () => {
    const h = project();
    const id = started(h);

    expect(applyDiagnosis(h.root, { id }, { now })).toMatchObject({ ok: false, reason: expect.stringContaining("diagnosing") });
    recordDiagnosis(h.root, { id, ...FOUND }, { now });
    const progress = readRecord(h.root, "progress");
    if (progress.kind !== "present") throw new Error("no progress");
    writeRecord(h.root, "progress", { executionAuthorized: false, ticketChangesPresent: true, assignedTicketId: "T1" });
    expect(applyDiagnosis(h.root, { id }, { now })).toMatchObject({ ok: false, reason: expect.stringContaining("authorized") });

    writeRecord(h.root, "progress", progress.record);
    writeRecord(h.root, "diagnoses", { diagnoses: diagnosesOf(h).map((entry) => ({ ...entry, ticketId: "T9" })) });
    expect(applyDiagnosis(h.root, { id }, { now })).toMatchObject({ ok: false, reason: expect.stringContaining("T9") });
    expect(diagnosesOf(h)[0]).toMatchObject({ status: "diagnosed" });
  });
});

describe("the diagnosis as review evidence", () => {
  it("is handed to the reviewer with the ticket", () => {
    const admitted: TicketValidation = {
      disposition: "admitted-to-review",
      criteria: [{ criterion: "parses an empty file", verdict: "met", by: "jev" }],
      missingChecks: [],
      validatedAt: now,
    };
    const h = project({ validations: { T1: admitted } });
    const id = started(h);
    recordDiagnosis(h.root, { id, ...FOUND }, { now });

    expect(startReview(h.root, h.context)).toMatchObject({
      ok: true,
      outcome: { diagnoses: [{ id, diagnosis: { finding: FOUND.finding, recommendation: FOUND.recommendation } }] },
    });
  });
});
