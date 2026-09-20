import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowState } from "../actions/resolve.js";
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
    writeFileSync(join(root, "jflow", "state.json"), "{ not json");

    const result = readProjectState(root);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.path).toContain("state.json");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("reports a record with the wrong shape as malformed rather than defaulting it", () => {
    const root = makeRoot();
    mkdirSync(join(root, "jflow"));
    writeFileSync(
      join(root, "jflow", "state.json"),
      JSON.stringify({ specificationAccepted: "yes" }),
    );

    const result = readProjectState(root);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") return;
    expect(result.message).toContain("specificationAccepted");
  });
});
