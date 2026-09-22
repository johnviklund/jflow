import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowState } from "../actions/resolve.js";
import { writeRecord, type SpecificationRecord } from "./records.js";
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
    writeRecord(root, "progress", {
      planAccepted: true,
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

  it("takes the specification gate from the specification's status, not from progress", () => {
    const root = makeRoot();
    writeRecord(root, "specification", specification);
    writeRecord(root, "progress", {
      planAccepted: true,
      executionAuthorized: false,
      ticketChangesPresent: false,
    });

    const result = readProjectState(root);

    expect(result.kind).toBe("initialized");
    if (result.kind !== "initialized") return;
    expect(result.state.specificationAccepted).toBe(false);
    expect(result.state.planAccepted).toBe(true);
    expect(() =>
      writeRecord(root, "progress", {
        specificationAccepted: true,
        planAccepted: true,
        executionAuthorized: false,
        ticketChangesPresent: false,
      } as never),
    ).toThrow(/specificationAccepted/);
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
