import { afterEach, describe, expect, it } from "vitest";

import { readRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { acceptPlan, authorizeExecution, writePlan, type PlanDraft } from "./plan.js";

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const NOW = "2026-09-22T10:00:00Z";
const LATER = "2026-09-22T11:00:00Z";

const draft: PlanDraft = {
  title: "CSV export",
  summary: "Export the current list as CSV.",
  tickets: [
    { id: "T1", title: "Serialise rows", acceptanceCriteria: ["a row round-trips"], dependsOn: [] },
    { id: "T2", title: "Download button", acceptanceCriteria: ["clicking downloads a file"], dependsOn: ["T1"] },
  ],
};

function specAccepted() {
  return harness({ state: { specificationAccepted: true }, gitRepository: true });
}

describe("writePlan", () => {
  it("is refused with the reason while the specification is unaccepted", () => {
    const h = harness();

    const result = writePlan(h.root, draft, { now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("specification");
    expect(readRecord(h.root, "tickets").kind).toBe("absent");
  });

  it("keeps a ticket's review notes, what the reviewer checks in the code that no criterion can show", () => {
    const h = specAccepted();
    const notes = ["tests go through the public argument parser", "the tests never import the renderer"];

    const result = writePlan(h.root, { ...draft, tickets: [{ ...draft.tickets[0]!, reviewNotes: notes }, draft.tickets[1]!] }, { now: NOW });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "tickets")).toMatchObject({ record: { tickets: [{ id: "T1", reviewNotes: notes }, { id: "T2" }] } });
    const bad = writePlan(h.root, { ...draft, tickets: [{ ...draft.tickets[0]!, reviewNotes: "one string" as unknown as string[] }] }, { now: NOW });
    expect(bad.ok).toBe(false);
  });

  it("writes the breakdown awaiting acceptance with every ticket ready, so implement is refused", () => {
    const h = specAccepted();

    const result = writePlan(h.root, draft, { now: NOW });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "plan")).toMatchObject({
      record: { title: "CSV export", status: "awaiting-acceptance", writtenAt: NOW },
    });
    expect(readRecord(h.root, "tickets")).toMatchObject({
      record: { tickets: [{ id: "T1", status: "ready" }, { id: "T2", status: "ready", dependsOn: ["T1"] }] },
    });
    const implement = h.runAction("implement");
    expect(implement.kind).toBe("blocked");
    if (implement.kind !== "blocked") return;
    expect(implement.resolution.unmet.map((u) => u.condition)).toContain("plan.accepted");
  });

  it("refuses a ticket without acceptance criteria, naming it, and writes nothing", () => {
    const h = specAccepted();
    const bare = {
      ...draft,
      tickets: [draft.tickets[0]!, { ...draft.tickets[1]!, acceptanceCriteria: [] }],
    };

    const result = writePlan(h.root, bare, { now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues?.map((issue) => issue.path)).toContain("tickets[1].acceptanceCriteria");
    expect(readRecord(h.root, "plan").kind).toBe("absent");
    expect(readRecord(h.root, "tickets").kind).toBe("absent");
  });

  it("refuses an empty breakdown and a dependency cycle", () => {
    const h = specAccepted();

    const empty = writePlan(h.root, { ...draft, tickets: [] }, { now: NOW });
    const cyclic = writePlan(
      h.root,
      {
        ...draft,
        tickets: [
          { ...draft.tickets[0]!, dependsOn: ["T2"] },
          { ...draft.tickets[1]!, dependsOn: ["T1"] },
        ],
      },
      { now: NOW },
    );

    expect(empty).toMatchObject({ ok: false });
    expect(cyclic.ok).toBe(false);
    if (cyclic.ok) return;
    expect(cyclic.reason).toMatch(/cycle/);
    expect(cyclic.reason).toContain("T1");
  });

  it("refuses a malformed draft with the offending paths rather than crashing", () => {
    const h = specAccepted();

    const result = writePlan(h.root, { ...draft, tickets: [null, { id: "T2", dependsOn: 5 }] } as never, {
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues?.map((issue) => issue.path) ?? [];
    expect(paths).toContain("tickets[0]");
    expect(paths).toContain("tickets[1].dependsOn");
  });

  it("refuses to rewrite an accepted plan; that change belongs to realign", () => {
    const h = specAccepted();
    writePlan(h.root, draft, { now: NOW });
    acceptPlan(h.root, { now: LATER });

    const result = writePlan(h.root, { ...draft, title: "Revised" }, { now: LATER });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("realign");
  });
});

describe("acceptPlan", () => {
  it("records acceptance without authorizing execution, so implement still asks", () => {
    const h = specAccepted();
    writePlan(h.root, draft, { now: NOW });

    const result = acceptPlan(h.root, { now: LATER, note: "looks good" });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "plan")).toMatchObject({
      record: { status: "accepted", acceptedAt: LATER, acceptanceNote: "looks good" },
    });
    expect(readRecord(h.root, "progress")).toMatchObject({
      record: { executionAuthorized: false },
    });
    const implement = h.runAction("implement");
    expect(implement.kind).toBe("blocked");
    if (implement.kind !== "blocked") return;
    expect(implement.resolution.unmet.map((u) => u.condition)).toEqual([
      "execution.authorized",
      "ticket.assigned",
    ]);
    expect(implement.resolution.requiresHumanAsk).toBe(true);
  });

  it("records acceptance and whole-plan authorization in one step", () => {
    const h = specAccepted();
    writePlan(h.root, draft, { now: NOW });

    const result = acceptPlan(h.root, {
      now: LATER,
      note: "approved, implement the whole plan",
      authorize: { scope: "plan", note: "approved, implement the whole plan" },
    });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "progress")).toMatchObject({
      record: {
        executionAuthorized: true,
        authorizationScope: "plan",
        authorizationNote: "approved, implement the whole plan",
        firstStartAuthorized: true,
      },
    });
    expect(readRecord(h.root, "plan")).toMatchObject({ record: { status: "accepted" } });
  });

  it("records acceptance and one-ticket authorization, assigning that ticket", () => {
    const h = specAccepted();
    writePlan(h.root, draft, { now: NOW });

    const result = acceptPlan(h.root, {
      now: LATER,
      note: "approved, implement ticket 1",
      authorize: { scope: "ticket", ticketId: "T1", note: "approved, implement ticket 1" },
    });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "progress")).toMatchObject({
      record: { executionAuthorized: true, authorizationScope: "ticket", assignedTicketId: "T1" },
    });
    expect(h.runAction("implement").kind).toBe("ready");
  });

  it("refuses acceptance with no plan, or twice", () => {
    const h = specAccepted();

    expect(acceptPlan(h.root, { now: NOW })).toMatchObject({ ok: false });
    writePlan(h.root, draft, { now: NOW });
    acceptPlan(h.root, { now: LATER });

    const again = acceptPlan(h.root, { now: LATER });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain("already");
  });
});

describe("authorizeExecution", () => {
  it("is refused until the plan is accepted", () => {
    const h = specAccepted();
    writePlan(h.root, draft, { now: NOW });

    const result = authorizeExecution(h.root, { scope: "plan", note: "go" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("accepted");
    expect(readRecord(h.root, "progress")).toMatchObject({ record: { executionAuthorized: false } });
  });

  it("records a later authorization after a bare acceptance", () => {
    const h = specAccepted();
    writePlan(h.root, draft, { now: NOW });
    acceptPlan(h.root, { now: LATER, note: "looks good" });

    const result = authorizeExecution(h.root, { scope: "ticket", ticketId: "T2", note: "do T2" });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "progress")).toMatchObject({
      record: {
        executionAuthorized: true,
        authorizationScope: "ticket",
        assignedTicketId: "T2",
        authorizationNote: "do T2",
      },
    });
  });

  it("refuses a ticket authorization naming no ticket or an unknown one", () => {
    const h = specAccepted();
    writePlan(h.root, draft, { now: NOW });
    acceptPlan(h.root, { now: LATER });

    expect(authorizeExecution(h.root, { scope: "ticket", note: "go" })).toMatchObject({ ok: false });
    expect(authorizeExecution(h.root, { scope: "plan", ticketId: "T1", note: "go" })).toMatchObject({
      ok: false,
    });
    const unknown = authorizeExecution(h.root, { scope: "ticket", ticketId: "T9", note: "go" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.reason).toContain("T9");
  });
});
