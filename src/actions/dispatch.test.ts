import { afterEach, describe, expect, it } from "vitest";

import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("dispatch", () => {
  it("runs a named action and a conversational request to the same contract", () => {
    const h = harness({ state: { specificationAccepted: true } });

    const named = h.runAction("plan");
    const spoken = h.request("break the spec into tickets");

    expect(named.kind).toBe("not-implemented");
    expect(spoken).toEqual(named);
  });

  it("runs status when asked conversationally", () => {
    const h = harness();

    const outcome = h.request("where are we?");

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.report.project).toBe("uninitialized");
  });

  it("asks which action was meant instead of guessing, and records the ask", () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true } });

    const outcome = h.request("should I troubleshoot or review?");

    expect(outcome.kind).toBe("clarify");
    if (outcome.kind !== "clarify") return;
    expect(outcome.candidates).toEqual(["troubleshoot", "review"]);
    expect(h.events).toEqual([{ kind: "human-ask", reasons: [outcome.question] }]);
    expect(h.snapshot()).toEqual(harness({ state: { specificationAccepted: true, planAccepted: true } }).snapshot());
  });

  it("refuses an action whose prerequisites are unmet, naming each one", () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true } });

    const outcome = h.request("carry out ticket T1");

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") return;
    expect(outcome.action).toBe("implement");
    expect(outcome.resolution.unmet.map((u) => u.condition)).toEqual([
      "execution.authorized",
      "ticket.assigned",
      "git.repository",
    ]);
  });

  it("reports an unrecognised request with the available actions and records no ask", () => {
    const h = harness();

    const outcome = h.request("make me a sandwich");

    expect(outcome.kind).toBe("unknown-action");
    if (outcome.kind !== "unknown-action") return;
    expect(outcome.message).toContain("brainstorm");
    expect(h.events).toEqual([]);
  });
});
