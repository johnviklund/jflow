import { describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { createWorkflowState, resolveAction } from "./resolve.js";

const workflowPackage = loadShippedWorkflowPackage();

const configResult = resolveConfiguration({}, workflowPackage);
if (!configResult.ok) throw new Error("fixture configuration must be valid");
const configuration = configResult.configuration;

function resolve(
  action: string,
  state: Parameters<typeof resolveAction>[1] = createWorkflowState(),
) {
  return resolveAction({ action }, state, { workflowPackage, configuration });
}

describe("resolveAction always-available actions", () => {
  it.each(["status", "next", "todo", "learn"])(
    "resolves %s as eligible in an empty workflow state",
    (action) => {
      const result = resolve(action);

      expect(result.status).toBe("eligible");
    },
  );

  it("resolves todo as eligible mid-implementation without expanding the assignment", () => {
    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
      gitRepositoryPresent: true,
    });

    const result = resolveAction({ action: "todo" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.action.produces).toContain("todoItem");
  });
});

describe("resolveAction unknown actions", () => {
  it("reports an unknown action with the supported action names", () => {
    const result = resolve("deploy");

    expect(result.status).toBe("unknown-action");
    if (result.status !== "unknown-action") return;
    expect(result.message).toContain("deploy");
    expect(result.message).toContain("brainstorm");
  });
});

describe("resolveAction acceptance and authorization gates", () => {
  it("allows brainstorm from an empty state", () => {
    expect(resolve("brainstorm").status).toBe("eligible");
  });

  it("blocks plan until the specification is accepted by the human", () => {
    const result = resolve("plan");

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.unmet.map((entry) => entry.condition)).toEqual([
      "specification.accepted",
    ]);
    expect(result.requiresHumanAsk).toBe(true);
  });

  it("allows plan once the specification is accepted", () => {
    const state = createWorkflowState({ specificationAccepted: true });

    expect(resolveAction({ action: "plan" }, state, { workflowPackage, configuration }).status).toBe(
      "eligible",
    );
  });

  it("treats plan acceptance as distinct from execution authorization", () => {
    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      assignedTicketId: "T1",
      gitRepositoryPresent: true,
    });

    const result = resolveAction({ action: "implement" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.unmet.map((entry) => entry.condition)).toEqual(["execution.authorized"]);
    expect(result.requiresHumanAsk).toBe(true);
  });

  it("blocks realign until there is an accepted plan to change", () => {
    const result = resolve("realign", createWorkflowState({ specificationAccepted: true }));

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.unmet.map((entry) => entry.condition)).toEqual(["plan.accepted"]);
  });

  it("allows realign on an accepted plan without a Git repository or execution authorization", () => {
    const state = createWorkflowState({ specificationAccepted: true, planAccepted: true });

    const result = resolve("realign", state);

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.action.canEditCode).toBe(false);
    expect(result.action.requiresHumanAcceptanceOf).toBe("plan");
  });

  it("allows implement once the plan is accepted and execution is authorized", () => {
    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
      gitRepositoryPresent: true,
    });

    const result = resolveAction({ action: "implement" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("eligible");
  });

  it("blocks implement without an assigned ticket without asking the human", () => {
    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      gitRepositoryPresent: true,
    });

    const result = resolveAction({ action: "implement" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.unmet.map((entry) => entry.condition)).toEqual(["ticket.assigned"]);
    expect(result.requiresHumanAsk).toBe(false);
  });
});

describe("resolveAction Git requirements", () => {
  it("blocks implement with an actionable reason when no Git repository is present", () => {
    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
      gitRepositoryPresent: false,
    });

    const result = resolveAction({ action: "implement" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    const git = result.unmet.find((entry) => entry.condition === "git.repository");
    expect(git?.reason).toContain("local Git repository");
    expect(git?.reason).toContain("never initializes");
    expect(result.requiresHumanAsk).toBe(true);
  });

  it("does not require a Git repository for brainstorm or plan", () => {
    const state = createWorkflowState({
      specificationAccepted: true,
      gitRepositoryPresent: false,
    });

    expect(
      resolveAction({ action: "brainstorm" }, state, { workflowPackage, configuration })
        .status,
    ).toBe("eligible");
    expect(
      resolveAction({ action: "plan" }, state, { workflowPackage, configuration }).status,
    ).toBe("eligible");
  });

  it("blocks review until the ticket has changes to assess", () => {
    const state = createWorkflowState({ gitRepositoryPresent: true });

    const result = resolveAction({ action: "review" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.unmet.map((entry) => entry.condition)).toEqual([
      "ticket.changesPresent",
    ]);
  });
});

describe("resolveAction roles and delegation limits", () => {
  it("reports the required roles for an eligible action", () => {
    const result = resolve("brainstorm");

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.requiredRoles).toEqual([
      { role: "investigator", independentFromImplementer: false },
    ]);
  });

  it("requires an implementer-independent reviewer for review", () => {
    const state = createWorkflowState({
      gitRepositoryPresent: true,
      ticketChangesPresent: true,
    });

    const result = resolveAction({ action: "review" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.requiredRoles.some((role) => role.independentFromImplementer)).toBe(
      true,
    );
  });

  it("bounds the action's delegation limit by the configured global ceiling", () => {
    const tighter = resolveConfiguration(
      { settings: { "delegation.maxParallelWorkers": 1 } },
      workflowPackage,
    );
    expect(tighter.ok).toBe(true);
    if (!tighter.ok) return;

    const result = resolveAction({ action: "brainstorm" }, createWorkflowState(), {
      workflowPackage,
      configuration: tighter.configuration,
    });

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.delegationLimits.maxParallelWorkers).toBe(1);
  });

  it("never raises an action's delegation limit above its declared maximum", () => {
    const looser = resolveConfiguration(
      { settings: { "delegation.maxParallelWorkers": 8 } },
      workflowPackage,
    );
    expect(looser.ok).toBe(true);
    if (!looser.ok) return;

    const state = createWorkflowState({
      gitRepositoryPresent: true,
      ticketChangesPresent: true,
    });
    const result = resolveAction({ action: "review" }, state, {
      workflowPackage,
      configuration: looser.configuration,
    });

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.delegationLimits.maxParallelWorkers).toBe(1);
  });

  it("reports the configured stage worker model and its explicit fallback", () => {
    const configured = resolveConfiguration(
      { stageModels: { implement: { model: "worker-a", fallbackModel: "worker-b" } } },
      workflowPackage,
    );
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;

    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
      gitRepositoryPresent: true,
    });
    const result = resolveAction({ action: "implement" }, state, {
      workflowPackage,
      configuration: configured.configuration,
    });

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.stageModel).toEqual({ model: "worker-a", fallbackModel: "worker-b" });
  });

  it("asks the human when an eligible stage has no configured worker model", () => {
    const state = createWorkflowState({
      gitRepositoryPresent: true,
      ticketChangesPresent: true,
    });

    const result = resolveAction({ action: "review" }, state, {
      workflowPackage,
      configuration,
    });

    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    expect(result.stageModel).toBeUndefined();
    expect(result.setupWarnings.join(" ")).toContain("no worker model is configured");
  });
});

describe("createWorkflowState", () => {
  it("defaults every gate to closed", () => {
    expect(createWorkflowState()).toEqual({
      specificationAccepted: false,
      planAccepted: false,
      executionAuthorized: false,
      ticketChangesPresent: false,
      gitRepositoryPresent: false,
    });
  });
});
