import { describe, expect, it } from "vitest";

import { createWorkflowState } from "./resolve.js";
import { createProjectHarness } from "../testing/harness.js";

describe("status", () => {
  it("reports an empty, uninitialized project without crashing", () => {
    const harness = createProjectHarness();
    try {
      const outcome = harness.runAction("status");

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed" || outcome.action !== "status") return;
      expect(outcome.report.project).toBe("uninitialized");
      if (outcome.report.project === "malformed") return;
      expect(outcome.report.state).toEqual(createWorkflowState());
      expect(harness.events).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("reads the workflow state from project files, not from memory", () => {
    const harness = createProjectHarness({
      state: { specificationAccepted: true, planAccepted: true },
      gitRepository: true,
    });
    try {
      const outcome = harness.runAction("status");

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed" || outcome.action !== "status") return;
      expect(outcome.report.project).toBe("initialized");
      if (outcome.report.project === "malformed") return;
      expect(outcome.report.state.specificationAccepted).toBe(true);
      expect(outcome.report.state.planAccepted).toBe(true);
      expect(outcome.report.state.executionAuthorized).toBe(false);
      expect(outcome.report.state.gitRepositoryPresent).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("reports each action's eligibility with the unmet prerequisites of blocked ones", () => {
    const harness = createProjectHarness({ state: { specificationAccepted: true } });
    try {
      const outcome = harness.runAction("status");

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed" || outcome.action !== "status") return;
      if (outcome.report.project === "malformed") return;
      const byName = new Map(outcome.report.actions.map((entry) => [entry.name, entry]));

      expect(byName.get("plan")?.status).toBe("eligible");
      expect(byName.get("status")?.status).toBe("eligible");

      const implement = byName.get("implement");
      expect(implement?.status).toBe("blocked");
      expect(implement?.unmet.map((entry) => entry.condition)).toContain("plan.accepted");
      expect(implement?.unmet.map((entry) => entry.condition)).toContain("git.repository");
    } finally {
      harness.cleanup();
    }
  });

  it("reports a malformed record as a problem naming the file, with no state or eligibility", () => {
    const harness = createProjectHarness();
    try {
      harness.writeFile("jflow/progress.json", "not json at all");

      const outcome = harness.runAction("status");

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed" || outcome.action !== "status") return;
      expect(outcome.report.project).toBe("malformed");
      if (outcome.report.project !== "malformed") return;
      expect(outcome.report.path).toContain("progress.json");
      expect(outcome.report).not.toHaveProperty("actions");
    } finally {
      harness.cleanup();
    }
  });

  it("changes nothing in the project directory", () => {
    const harness = createProjectHarness({ state: { specificationAccepted: true } });
    try {
      const before = harness.snapshot();
      harness.runAction("status");

      expect(harness.snapshot()).toEqual(before);
    } finally {
      harness.cleanup();
    }
  });
});
