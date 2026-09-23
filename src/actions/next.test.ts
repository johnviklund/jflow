import { afterEach, describe, expect, it } from "vitest";

import { createProjectHarness, type HarnessOptions, type ProjectHarness } from "../testing/harness.js";
import type { NextReport } from "./next.js";
import { promoteTodo, recordTodo } from "./todo.js";

const harnesses: ProjectHarness[] = [];

function harness(options?: HarnessOptions): ProjectHarness {
  const created = createProjectHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-23T10:00:00Z";

/** Runs `next` as the developer would ask for it and returns its report. */
function next(h: ProjectHarness, request = "next"): NextReport {
  const outcome = h.request(request);
  if (outcome.kind !== "completed" || outcome.action !== "next") {
    throw new Error(`expected next to complete, got ${outcome.kind}`);
  }
  return outcome.report;
}

function recommended(report: NextReport) {
  if (report.project === "malformed") throw new Error("unexpected malformed project");
  return report.recommendation;
}

describe("next", () => {
  it("recommends brainstorm in a project with no records", () => {
    const report = next(harness());

    expect(recommended(report)).toMatchObject({ action: "brainstorm", needsDeveloper: false });
  });

  it.each([
    ["an unaccepted specification", "jflow/specification.json", "brainstorm", "specification awaits your acceptance"],
    ["an unaccepted plan", "jflow/plan.json", "plan", "ticket breakdown awaits your acceptance"],
  ])("asks the developer to accept %s", (_label, path, action, reason) => {
    const h = harness(action === "plan" ? { state: { specificationAccepted: true } } : {});
    h.writeFile(
      path,
      JSON.stringify(
        action === "plan"
          ? { title: "t", summary: "s", status: "awaiting-acceptance", writtenAt: now }
          : {
              title: "t",
              problem: "p",
              scenarios: ["s"],
              acceptanceCriteria: ["a"],
              constraints: [],
              exclusions: [],
              decisions: [],
              status: "awaiting-acceptance",
              writtenAt: now,
            },
      ),
    );

    expect(recommended(next(h))).toMatchObject({ action, needsDeveloper: true, reason: expect.stringContaining(reason) });
  });

  it("recommends plan once the specification is accepted", () => {
    expect(recommended(next(harness({ state: { specificationAccepted: true } })))).toMatchObject({
      action: "plan",
      needsDeveloper: false,
    });
  });

  it("reports implement's missing authorization as the developer's to give, and grants nothing", () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
    const before = h.snapshot();
    const state = h.readState();

    const report = next(h, "what should I do next?");

    expect(recommended(report)).toMatchObject({
      action: "implement",
      needsDeveloper: true,
      unmet: expect.arrayContaining([expect.objectContaining({ condition: "execution.authorized" })]),
    });
    expect(h.snapshot()).toEqual(before);
    expect(h.readState()).toEqual(state);
    expect(h.runAction("implement").kind).toBe("blocked");
  });

  it("keeps recommending implement while the assigned ticket is in progress, never review early", () => {
    const assigned = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    const changed = harness({
      state: {
        specificationAccepted: true,
        planAccepted: true,
        executionAuthorized: true,
        assignedTicketId: "T1",
        ticketChangesPresent: true,
      },
      gitRepository: true,
    });

    expect(recommended(next(assigned))).toMatchObject({ action: "implement", needsDeveloper: false, unmet: [] });
    expect(recommended(next(changed))).toMatchObject({
      action: "implement",
      needsDeveloper: false,
      reason: expect.stringContaining("T1 is in progress"),
    });
  });

  it.each([
    ["every ticket is done", ["done", "withdrawn"], "wrap", false],
    ["only parked tickets remain", ["done", "parked"], "implement", true],
  ] as const)("recommends the right step when %s", (_label, statuses, action, needsDeveloper) => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true },
      gitRepository: true,
    });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({
        tickets: statuses.map((status, index) => ({
          id: `T${index + 1}`,
          title: "t",
          acceptanceCriteria: ["c"],
          dependsOn: [],
          status,
          ...(status === "parked" ? { parkedReason: "waiting on a decision" } : {}),
        })),
      }),
    );

    expect(recommended(next(h))).toMatchObject({ action, needsDeveloper });
  });

  it("keeps a promoted todo in sight until its ticket exists", () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true } });
    recordTodo(h.root, { summary: "rename the flag" }, { now });
    recordTodo(h.root, { summary: "tidy the importer" }, { now });
    promoteTodo(h.root, "TODO-1", { note: "bring the rename in", now });

    const report = next(h);

    if (report.project === "malformed") throw new Error("unexpected malformed project");
    expect(report.openTodos.map((item) => item.id)).toEqual(["TODO-2"]);
    expect(report.promotedTodos.map((item) => item.id)).toEqual(["TODO-1"]);
  });

  it("lists every action with its eligibility and reasons, and open todos apart from the work", () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true } });
    recordTodo(h.root, { summary: "rename the flag" }, { now });

    const report = next(h);

    if (report.project === "malformed") throw new Error("unexpected malformed project");
    expect(report.actions.find((entry) => entry.name === "todo")).toMatchObject({ status: "eligible" });
    const implement = report.actions.find((entry) => entry.name === "implement");
    expect(implement?.status).toBe("blocked");
    expect(implement?.unmet.map((entry) => entry.reason).join(" ")).toContain("authorized");
    expect(report.openTodos).toEqual([expect.objectContaining({ id: "TODO-1", summary: "rename the flag" })]);
    expect(recommended(report).action).toBe("implement");
  });

  it("reports an unreadable record and recommends nothing", () => {
    const h = harness();
    h.writeFile("jflow/progress.json", "{ truncated");

    const report = next(h);

    expect(report).toMatchObject({ project: "malformed", path: expect.stringContaining("progress.json") });
  });
});
