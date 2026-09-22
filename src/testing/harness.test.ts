import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createProjectHarness } from "./harness.js";

describe("createProjectHarness", () => {
  it("sets up a project directory in the requested workflow state", () => {
    const harness = createProjectHarness({
      state: { specificationAccepted: true, assignedTicketId: "T2" },
      gitRepository: true,
    });
    try {
      const state = harness.readState();

      expect(state.kind).toBe("initialized");
      if (state.kind !== "initialized") return;
      expect(state.state.specificationAccepted).toBe(true);
      expect(state.state.assignedTicketId).toBe("T2");
      expect(state.state.gitRepositoryPresent).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("records a human-ask event when an action is blocked on a human decision", () => {
    const harness = createProjectHarness({ state: { specificationAccepted: true } });
    try {
      const outcome = harness.runAction("implement");

      expect(outcome.kind).toBe("blocked");
      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]?.kind).toBe("human-ask");
      expect(harness.events[0]?.action).toBe("implement");
      expect(harness.events[0]?.reasons.join(" ")).toContain("not been explicitly accepted");
    } finally {
      harness.cleanup();
    }
  });

  it("records no human-ask event when an action proceeds within existing authority", () => {
    const harness = createProjectHarness();
    try {
      harness.runAction("status");

      expect(harness.events).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("reports an eligible action whose method the skill carries as ready, and records no ask", () => {
    const harness = createProjectHarness({ state: { specificationAccepted: true } });
    try {
      const outcome = harness.runAction("plan");

      expect(outcome.kind).toBe("ready");
      expect(harness.events).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("reports an unknown action and records no ask", () => {
    const harness = createProjectHarness();
    try {
      const outcome = harness.runAction("deploy");

      expect(outcome.kind).toBe("unknown-action");
      expect(harness.events).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses to run any action but status against an unreadable record", () => {
    const harness = createProjectHarness({ state: { specificationAccepted: true } });
    try {
      harness.writeFile("jflow/progress.json", "{ broken");

      const outcome = harness.runAction("plan");

      expect(outcome.kind).toBe("malformed-record");
      expect(harness.events).toEqual([]);
      expect(harness.runAction("status").kind).toBe("completed");
    } finally {
      harness.cleanup();
    }
  });

  it("does not write a state record for an uninitialized project", () => {
    const harness = createProjectHarness();
    try {
      expect(harness.readState().kind).toBe("uninitialized");
      expect(existsSync(harness.path("jflow/progress.json"))).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("removes the directory on cleanup", () => {
    const harness = createProjectHarness({ state: { planAccepted: true } });
    const root = harness.root;

    harness.cleanup();

    expect(existsSync(root)).toBe(false);
  });
});
