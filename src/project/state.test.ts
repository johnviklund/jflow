import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowState } from "../actions/resolve.js";
import { writeRecord, type PlanRecord, type SpecificationRecord } from "./records.js";
import { readProjectState } from "./state.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jflow-state-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const specification: SpecificationRecord = {
  title: "t",
  problem: "p",
  scenarios: ["s"],
  acceptanceCriteria: ["a"],
  constraints: [],
  exclusions: [],
  decisions: [],
  status: "awaiting-acceptance",
  writtenAt: "2026-09-22T09:00:00Z",
};

const acceptedSpecification: SpecificationRecord = {
  ...specification,
  status: "accepted",
  acceptedAt: "2026-09-22T10:00:00Z",
};

const acceptedPlan: PlanRecord = {
  title: "t",
  summary: "s",
  status: "accepted",
  writtenAt: "2026-09-22T10:00:00Z",
  acceptedAt: "2026-09-22T11:00:00Z",
};

describe("readProjectState", () => {
  it("reports an empty directory as uninitialized with a default state", () => {
    const result = readProjectState(makeRoot());

    expect(result.kind).toBe("uninitialized");
    if (result.kind !== "uninitialized") return;
    expect(result.state).toEqual(createWorkflowState());
  });

  it("derives the state from the specification and progress records", () => {
    const root = makeRoot();
    writeRecord(root, "specification", acceptedSpecification);
    writeRecord(root, "plan", acceptedPlan);
    writeRecord(root, "progress", {
      executionAuthorized: false,
      ticketChangesPresent: false,
      assignedTicketId: "T3",
    });

    const result = readProjectState(root);

    expect(result.kind).toBe("initialized");
    if (result.kind !== "initialized") return;
    expect(result.state).toEqual(
      createWorkflowState({ specificationAccepted: true, planAccepted: true, assignedTicketId: "T3" }),
    );
  });

  it("takes each acceptance gate from its own record, never from progress", () => {
    const root = makeRoot();
    writeRecord(root, "specification", specification);
    const { acceptedAt: _at, ...openPlan } = acceptedPlan;
    writeRecord(root, "plan", { ...openPlan, status: "awaiting-acceptance" });
    writeRecord(root, "progress", { executionAuthorized: false, ticketChangesPresent: false });

    const result = readProjectState(root);

    expect(result.kind).toBe("initialized");
    if (result.kind !== "initialized") return;
    expect(result.state.specificationAccepted).toBe(false);
    expect(result.state.planAccepted).toBe(false);
    for (const key of ["specificationAccepted", "planAccepted"]) {
      expect(() =>
        writeRecord(root, "progress", {
          [key]: true,
          executionAuthorized: false,
          ticketChangesPresent: false,
        } as never),
      ).toThrow(new RegExp(key));
    }
  });

  it("detects a Git repository from the directory, never from a record", () => {
    const root = makeRoot();
    writeRecord(root, "specification", specification);
    expect(readProjectState(root)).toMatchObject({ state: { gitRepositoryPresent: false } });

    mkdirSync(join(root, ".git"));

    expect(readProjectState(root)).toMatchObject({ state: { gitRepositoryPresent: true } });
  });

  it("reports a malformed record as a recoverable error naming the file and issues", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(join(root, "jflow", "progress.json"), "{ not json");

    const result = readProjectState(root);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.path).toContain("progress.json");
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("reports a record with the wrong shape as malformed rather than defaulting it", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(join(root, "jflow", "specification.json"), JSON.stringify({ title: "x" }));

    const result = readProjectState(root);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.message).toContain("problem");
  });
});
