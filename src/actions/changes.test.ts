import { afterEach, describe, expect, it } from "vitest";

import { readRecord, writeRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { claimChanges } from "./changes.js";

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** Authorized for T1, with the developer's own work already in the tree. */
function authorizedWithDeveloperWork(): ProjectHarness {
  const h = harness({
    state: {
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
    },
    gitRepository: true,
  });
  h.writeFile("notes.md", "my scratch notes\n");
  h.writeFile("src/draft.ts", "export const draft = 1;\n");
  return h;
}

describe("implement against pre-existing uncommitted changes", () => {
  it("pauses and asks the developer, naming each change, and touches nothing", () => {
    const h = authorizedWithDeveloperWork();
    const before = h.snapshot();

    const outcome = h.runAction("implement");

    expect(outcome.kind).toBe("blocked");
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.action).toBe("implement");
    expect(h.events[0]?.reasons.join(" ")).toContain("notes.md, src/draft.ts");
    expect(h.snapshot()).toEqual(before);
  });

  it("proceeds once the developer has said who owns every change", () => {
    const h = authorizedWithDeveloperWork();

    const kept = claimChanges(h.root, { owner: "developer", paths: ["notes.md"], note: "notes are mine" });
    const stillAsks = h.runAction("implement");
    const adopted = claimChanges(h.root, { owner: "ticket", note: "the draft is the start of T1" });
    const ready = h.runAction("implement");

    expect(kept).toMatchObject({ ok: true, outcome: { unclaimedChanges: ["src/draft.ts"] } });
    expect(stillAsks.kind).toBe("blocked");
    expect(adopted).toMatchObject({ ok: true, outcome: { unclaimedChanges: [] } });
    expect(ready.kind).toBe("ready");
    const progress = readRecord(h.root, "progress");
    expect(progress.kind === "present" && progress.record.changeOwnership).toEqual([
      { path: "notes.md", owner: "developer", note: "notes are mine" },
      { path: "src/draft.ts", owner: "ticket", ticketId: "T1", note: "the draft is the start of T1" },
    ]);
    expect(h.snapshot()["notes.md"]).toBe("my scratch notes\n");
  });
});

describe("claimChanges", () => {
  it("refuses without the developer's words", () => {
    const h = authorizedWithDeveloperWork();

    expect(claimChanges(h.root, { owner: "developer", note: "  " })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("developer's words"),
    });
  });

  it("refuses a path that is not an unclaimed uncommitted change", () => {
    const h = authorizedWithDeveloperWork();

    const result = claimChanges(h.root, { owner: "developer", paths: ["README.md"], note: "mine" });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("README.md") });
  });

  it("records a path named twice once", () => {
    const h = authorizedWithDeveloperWork();

    const result = claimChanges(h.root, { owner: "developer", paths: ["notes.md", "notes.md"], note: "mine" });

    expect(result).toMatchObject({ ok: true, outcome: { claimed: [{ path: "notes.md" }] } });
  });

  it("replaces a claim held for a ticket that is no longer assigned", () => {
    const h = authorizedWithDeveloperWork();
    claimChanges(h.root, { owner: "ticket", paths: ["src/draft.ts"], note: "part of T1" });
    const progress = readRecord(h.root, "progress");
    if (progress.kind !== "present") throw new Error("progress must exist");
    writeRecord(h.root, "progress", { ...progress.record, assignedTicketId: "T2" });

    const result = claimChanges(h.root, { owner: "developer", paths: ["src/draft.ts"], note: "mine now" });

    expect(result).toMatchObject({
      ok: true,
      outcome: { progress: { changeOwnership: [{ path: "src/draft.ts", owner: "developer" }] } },
    });
  });

  it("refuses to adopt changes into a ticket when none is assigned", () => {
    const h = harness({ state: { specificationAccepted: true }, gitRepository: true });
    h.writeFile("notes.md", "x\n");

    const result = claimChanges(h.root, { owner: "ticket", note: "put it in the ticket" });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("no ticket is assigned") });
  });

  it("refuses when there is nothing to claim or no repository to read", () => {
    const clean = harness({ gitRepository: true });
    const noGit = harness();

    expect(claimChanges(clean.root, { owner: "developer", note: "mine" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no uncommitted changes"),
    });
    expect(claimChanges(noGit.root, { owner: "developer", note: "mine" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Git repository"),
    });
  });

  it("records a claim on a project with no progress record yet", () => {
    const h = harness({ gitRepository: true });
    h.writeFile("notes.md", "x\n");

    expect(claimChanges(h.root, { owner: "developer", note: "mine" })).toMatchObject({ ok: true });
    expect(h.readState()).toMatchObject({ state: { unclaimedChanges: [] } });
  });
});
