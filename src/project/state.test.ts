import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowState } from "../actions/resolve.js";
import { readRecord, writeRecord } from "./records.js";
import { readProjectState, writeProjectState } from "./state.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jflow-state-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readProjectState", () => {
  it("reports an empty directory as uninitialized with a default state", () => {
    const result = readProjectState(makeRoot());

    expect(result.kind).toBe("uninitialized");
    if (result.kind !== "uninitialized") return;
    expect(result.state).toEqual(createWorkflowState());
  });

  it("round-trips a written state losslessly", () => {
    const root = makeRoot();
    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      assignedTicketId: "T3",
    });

    writeProjectState(root, state);
    const result = readProjectState(root);

    expect(result.kind).toBe("initialized");
    if (result.kind !== "initialized") return;
    expect(result.state).toEqual(state);
  });

  it("detects a Git repository from the directory, not from the record", () => {
    const root = makeRoot();
    writeProjectState(root, createWorkflowState({ gitRepositoryPresent: true }));
    mkdirSync(join(root, ".git"));

    const result = readProjectState(root);

    expect(result.kind).toBe("initialized");
    if (result.kind !== "initialized") return;
    expect(result.state.gitRepositoryPresent).toBe(true);
  });

  it("does not report a Git repository the directory lacks, whatever the record says", () => {
    const root = makeRoot();
    writeProjectState(root, createWorkflowState({ gitRepositoryPresent: true }));

    const result = readProjectState(root);

    expect(result.kind).toBe("initialized");
    if (result.kind !== "initialized") return;
    expect(result.state.gitRepositoryPresent).toBe(false);
  });

  it("reports a malformed record as a recoverable error naming the file", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(join(root, "jflow", "progress.json"), "{ not json");

    const result = readProjectState(root);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.path).toContain("progress.json");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("reports a record with the wrong shape as malformed rather than defaulting it", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(
      join(root, "jflow", "progress.json"),
      JSON.stringify({ specificationAccepted: "yes" }),
    );

    const result = readProjectState(root);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.message).toContain("specificationAccepted");
  });

  it("keeps the rest of the progress record when the flags are updated", () => {
    const root = makeRoot();
    writeRecord(root, "progress", {
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      authorizationScope: "plan",
      ticketChangesPresent: false,
      fixAttempts: { T1: 2 },
    });

    writeProjectState(root, createWorkflowState({ specificationAccepted: true, planAccepted: true }));
    const result = readRecord(root, "progress");

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.record.fixAttempts).toEqual({ T1: 2 });
    expect(result.record.executionAuthorized).toBe(false);
    expect(result.record).not.toHaveProperty("authorizationScope");
  });

  it("refuses to overwrite a malformed progress record from a flag update", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(join(root, "jflow", "progress.json"), "{ broken");

    expect(() => writeProjectState(root, createWorkflowState())).toThrow(/malformed/);
    expect(readProjectState(root).kind).toBe("malformed");
  });

  it("records a fresh authorization at ticket scope, never silently whole-plan", () => {
    const root = makeRoot();

    writeProjectState(
      root,
      createWorkflowState({ specificationAccepted: true, planAccepted: true, executionAuthorized: true }),
    );
    const result = readRecord(root, "progress");

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.record.authorizationScope).toBe("ticket");
  });
});
