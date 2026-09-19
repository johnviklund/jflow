import { describe, expect, it } from "vitest";

import { loadShippedWorkflowPackage, validateWorkflowPackage } from "./package.js";
import { WorkflowPackageError } from "./types.js";

/**
 * A structurally valid minimal package used as the base for negative cases, so
 * each test changes exactly the one thing under assessment.
 */
function validPackage(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "test",
    name: "Test workflow",
    actions: [
      {
        name: "implement",
        kind: "stage",
        summary: "Carry out one ticket.",
        requiredRoles: [{ role: "implementer", independentFromImplementer: false }],
        delegationLimits: { maxParallelWorkers: 2, allowParallelWithinUnit: true },
        canEditCode: true,
        requiresGitRepository: true,
        prerequisites: ["plan.accepted", "execution.authorized", "git.repository"],
        produces: ["commit"],
      },
      {
        name: "review",
        kind: "stage",
        summary: "Independently assess changes.",
        requiredRoles: [{ role: "reviewer", independentFromImplementer: true }],
        delegationLimits: { maxParallelWorkers: 1, allowParallelWithinUnit: false },
        canEditCode: false,
        requiresGitRepository: true,
        prerequisites: ["ticket.changesPresent", "git.repository"],
        produces: ["review"],
      },
    ],
    configurationSurface: {
      configurableStageModels: ["implement", "review"],
      allowImplicitModelFallback: false,
      settings: [
        {
          key: "commitOnSuccess",
          type: "boolean",
          summary: "Commit locally after a ticket passes checks and review.",
          default: true,
        },
      ],
    },
  };
}

describe("validateWorkflowPackage", () => {
  it("accepts a structurally valid package", () => {
    const result = validateWorkflowPackage(validPackage());

    expect(result.ok).toBe(true);
  });

  it("reports an actionable path for a duplicate action", () => {
    const doc = validPackage();
    const actions = doc["actions"] as unknown[];
    actions.push(structuredClone(actions[0]));

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "actions[2].name",
      message: 'duplicate action name "implement"',
    });
  });

  it("rejects an unknown prerequisite condition", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[0]!["prerequisites"] = ["plan.blessed"];

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("actions[0].prerequisites[0]");
    expect(result.issues[0]?.message).toContain("plan.blessed");
  });

  it("rejects an action with no required roles", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[0]!["requiredRoles"] = [];

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "actions[0].requiredRoles",
      message: "must declare at least one required role",
    });
  });

  it("rejects a review action without an independent reviewer role", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[1]!["requiredRoles"] = [
      { role: "reviewer", independentFromImplementer: false },
    ];

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "actions[1].requiredRoles",
      message:
        'action "review" must declare a role with independentFromImplementer: true; the separate-review gate cannot be disabled',
    });
  });

  it("rejects a review or troubleshoot action that may edit code", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[1]!["canEditCode"] = true;

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "actions[1].canEditCode",
      message: 'action "review" must not edit code',
    });
  });

  it("rejects an implicit model fallback", () => {
    const doc = validPackage();
    const surface = doc["configurationSurface"] as Record<string, unknown>;
    surface["allowImplicitModelFallback"] = true;

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "configurationSurface.allowImplicitModelFallback",
      message: "must be false; an unavailable model requires an explicit fallback or a human decision",
    });
  });

  it("rejects a configurable stage model naming an unknown action", () => {
    const doc = validPackage();
    const surface = doc["configurationSurface"] as Record<string, unknown>;
    surface["configurableStageModels"] = ["implement", "deploy"];

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "configurationSurface.configurableStageModels[1]",
      message: 'unknown action "deploy"',
    });
  });

  it("rejects a package with no action producing a review", () => {
    const doc = validPackage();
    const actions = doc["actions"] as unknown[];
    doc["actions"] = [actions[0]];
    const surface = doc["configurationSurface"] as Record<string, unknown>;
    surface["configurableStageModels"] = ["implement"];

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "actions",
      message:
        'must declare at least one action producing the "review" artefact; the separate-review gate cannot be removed',
    });
  });

  it("enforces the review gate on a renamed review action", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[1]!["name"] = "assess";
    actions[1]!["requiredRoles"] = [
      { role: "assessor", independentFromImplementer: false },
    ];
    actions[1]!["canEditCode"] = true;
    const surface = doc["configurationSurface"] as Record<string, unknown>;
    surface["configurableStageModels"] = ["implement", "assess"];

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.issues.map((issue) => issue.message);
    expect(messages).toContain(
      'action "assess" must declare a role with independentFromImplementer: true; the separate-review gate cannot be disabled',
    );
    expect(messages).toContain('action "assess" must not edit code');
  });

  it("rejects an always-available action that declares a gate", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions.push({
      name: "status",
      kind: "always-available",
      summary: "Report progress.",
      requiredRoles: [{ role: "reporter", independentFromImplementer: false }],
      delegationLimits: { maxParallelWorkers: 1, allowParallelWithinUnit: false },
      canEditCode: false,
      requiresGitRepository: true,
      prerequisites: ["git.repository"],
      produces: [],
    });

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("actions[2].prerequisites");
    expect(paths).toContain("actions[2].requiresGitRepository");
  });

  it("rejects a non-object document", () => {
    const result = validateWorkflowPackage("not a package");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "",
      message: "workflow package must be an object",
    });
  });

  it("collects every issue rather than stopping at the first", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[0]!["requiredRoles"] = [];
    actions[1]!["canEditCode"] = true;

    const result = validateWorkflowPackage(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadShippedWorkflowPackage", () => {
  const pkg = loadShippedWorkflowPackage();

  it("loads the single shipped workflow package", () => {
    expect(pkg.schemaVersion).toBe(1);
    expect(pkg.id).toBe("jflow");
  });

  it("declares the specified stage actions", () => {
    const stages = pkg.actions.filter((a) => a.kind === "stage").map((a) => a.name);

    expect(stages).toEqual([
      "brainstorm",
      "plan",
      "implement",
      "troubleshoot",
      "review",
      "wrap",
    ]);
  });

  it("declares status, next, todo and learn as always available", () => {
    const always = pkg.actions
      .filter((a) => a.kind === "always-available")
      .map((a) => a.name);

    expect(always).toEqual(["status", "next", "todo", "learn"]);
  });

  it("requires human acceptance of the specification before plan proceeds", () => {
    const brainstorm = pkg.actions.find((a) => a.name === "brainstorm");
    const plan = pkg.actions.find((a) => a.name === "plan");

    expect(brainstorm?.requiresHumanAcceptanceOf).toBe("specification");
    expect(plan?.prerequisites).toContain("specification.accepted");
  });

  it("requires an accepted plan and explicit execution authorization to implement", () => {
    const implement = pkg.actions.find((a) => a.name === "implement");

    expect(implement?.prerequisites).toContain("plan.accepted");
    expect(implement?.prerequisites).toContain("execution.authorized");
  });

  it("requires a Git repository for implement and review but not brainstorm or plan", () => {
    const needsGit = (name: string) =>
      pkg.actions.find((a) => a.name === name)?.requiresGitRepository;

    expect(needsGit("implement")).toBe(true);
    expect(needsGit("review")).toBe(true);
    expect(needsGit("brainstorm")).toBe(false);
    expect(needsGit("plan")).toBe(false);
  });

  it("forbids code edits from troubleshoot and review", () => {
    const canEdit = (name: string) =>
      pkg.actions.find((a) => a.name === name)?.canEditCode;

    expect(canEdit("troubleshoot")).toBe(false);
    expect(canEdit("review")).toBe(false);
    expect(canEdit("implement")).toBe(true);
  });

  it("requires an implementer-independent reviewer role for review", () => {
    const review = pkg.actions.find((a) => a.name === "review");

    expect(
      review?.requiredRoles.some((role) => role.independentFromImplementer),
    ).toBe(true);
  });

  it("throws a WorkflowPackageError listing issues when given an invalid document", () => {
    expect(() => {
      const doc = validPackage();
      delete doc["actions"];
      const result = validateWorkflowPackage(doc);
      if (!result.ok) throw new WorkflowPackageError(result.issues);
    }).toThrow(WorkflowPackageError);
  });
});
