import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowState } from "../actions/resolve.js";
import { writeRecord, type PlanRecord, type SpecificationRecord, type TicketValidation } from "./records.js";
import { readProjectState } from "./state.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jflow-state-"));
  roots.push(root);
  return root;
}

/** The test creates the repository; jflow never initializes one. */
function initRepository(root: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
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

  it("detects a Git repository by asking Git, never from a record", () => {
    const root = makeRoot();
    writeRecord(root, "specification", specification);
    expect(readProjectState(root)).toMatchObject({ state: { gitRepositoryPresent: false } });

    initRepository(root);

    expect(readProjectState(root)).toMatchObject({ state: { gitRepositoryPresent: true } });
  });

  it("reports a .git Git cannot read as unreadable rather than as a repository", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".git"));

    const result = readProjectState(root);

    expect(result.kind).toBe("uninitialized");
    if (result.kind !== "uninitialized") return;
    expect(result.state.gitRepositoryPresent).toBe(false);
    expect(result.state.gitRepositoryUnreadable).toEqual(expect.any(String));
  });

  it("lists uncommitted changes nobody has claimed, leaving out jflow's own records", () => {
    const root = makeRoot();
    initRepository(root);
    writeRecord(root, "progress", { executionAuthorized: false, ticketChangesPresent: false });
    writeFileSync(join(root, "notes.md"), "mine\n");

    expect(readProjectState(root)).toMatchObject({ state: { unclaimedChanges: ["notes.md"] } });
  });

  it("treats changes the developer assigned an owner to as claimed", () => {
    const root = makeRoot();
    initRepository(root);
    writeFileSync(join(root, "notes.md"), "mine\n");
    writeFileSync(join(root, "draft.ts"), "adopted\n");
    writeFileSync(join(root, "later.txt"), "new\n");
    writeRecord(root, "progress", {
      executionAuthorized: false,
      ticketChangesPresent: false,
      assignedTicketId: "T1",
      changeOwnership: [
        { path: "notes.md", owner: "developer", note: "that's my scratch file" },
        { path: "draft.ts", owner: "ticket", ticketId: "T1", note: "fold it into T1" },
      ],
    });

    expect(readProjectState(root)).toMatchObject({ state: { unclaimedChanges: ["later.txt"] } });
  });

  it("does not count a change adopted by another ticket as claimed for the assigned one", () => {
    const root = makeRoot();
    initRepository(root);
    writeFileSync(join(root, "draft.ts"), "adopted by T1\n");
    writeRecord(root, "progress", {
      executionAuthorized: false,
      ticketChangesPresent: false,
      assignedTicketId: "T2",
      changeOwnership: [{ path: "draft.ts", owner: "ticket", ticketId: "T1", note: "fold it into T1" }],
    });

    expect(readProjectState(root)).toMatchObject({ state: { unclaimedChanges: ["draft.ts"] } });
  });

  it("presumes changes made after the ticket's work began are the ticket's", () => {
    const root = makeRoot();
    initRepository(root);
    writeFileSync(join(root, "src.ts"), "ticket work\n");
    writeRecord(root, "progress", {
      executionAuthorized: true,
      authorizationScope: "ticket",
      ticketChangesPresent: true,
      assignedTicketId: "T1",
    });

    expect(readProjectState(root)).toMatchObject({ state: { unclaimedChanges: [] } });
  });

  it("admits the assigned ticket to review only from its own all-met validation", () => {
    const root = makeRoot();
    const validation = (disposition: "admitted-to-review" | "returned-to-fix"): TicketValidation => ({
      disposition,
      criteria: [{ criterion: "c", verdict: disposition === "admitted-to-review" ? "met" : "not-met", by: "jev" }],
      missingChecks: [],
      validatedAt: "2026-09-25T10:00:00Z",
    });
    const progress = {
      executionAuthorized: true,
      authorizationScope: "ticket",
      ticketChangesPresent: true,
      assignedTicketId: "T1",
    } as const;

    writeRecord(root, "progress", { ...progress, validations: { T1: validation("returned-to-fix"), T2: validation("admitted-to-review") } });
    expect(readProjectState(root)).toMatchObject({ state: { ticketAdmittedToReview: false } });

    writeRecord(root, "progress", { ...progress, validations: { T1: validation("admitted-to-review") } });
    expect(readProjectState(root)).toMatchObject({ state: { ticketAdmittedToReview: true } });

    const reviewed = (disposition: "passed" | "awaiting-developer" | "returned-to-fix") => ({
      reviewer: { agent: "reviewer-1" },
      disposition,
      findings: [],
      reviewedAt: "2026-09-25T11:00:00Z",
    });
    for (const [disposition, admitted] of [["passed", false], ["awaiting-developer", false], ["returned-to-fix", true]] as const) {
      writeRecord(root, "progress", {
        ...progress,
        validations: { T1: validation("admitted-to-review") },
        reviews: { T1: reviewed(disposition) },
      });
      expect(readProjectState(root)).toMatchObject({ state: { ticketAdmittedToReview: admitted } });
    }
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
