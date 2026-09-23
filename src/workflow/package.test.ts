import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadShippedWorkflowPackage, validateWorkflowPackage } from "./package.js";
import { WorkflowPackageError } from "./types.js";

/** In-memory question files for the fixture package, keyed by package-relative path. */
function questionFiles(): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "questions/escalate.json",
      {
        decision: "escalate",
        version: 1,
        status: "skeleton",
        prompt: "Must the human be consulted before proceeding?",
        answers: ["proceed", "escalate"],
      },
    ],
  ]);
}

function readerFor(files: Map<string, unknown>) {
  return (path: string): string | undefined => {
    const file = files.get(path);
    return file === undefined ? undefined : JSON.stringify(file);
  };
}

/**
 * A structurally valid minimal version-2 package used as the base for negative
 * cases, so each test changes exactly the one thing under assessment.
 */
function validPackage(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    decisions: {
      escalate: {
        question: "questions/escalate.json",
        version: 1,
        authority: "binding",
        basis: "Fixture.",
      },
    },
    policy: {
      escalate: {
        thresholds: { confidence: 0.5 },
        basis: "Fixture.",
      },
    },
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
        prerequisites: ["plan.accepted", "execution.authorized", "git.repository", "git.changesOwned"],
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
        prerequisites: ["ticket.changesPresent", "git.repository", "git.changesOwned"],
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

function validate(doc: unknown, files: Map<string, unknown> = questionFiles()) {
  return validateWorkflowPackage(doc, { readQuestionFile: readerFor(files) });
}

/** Validates and returns the issues, failing the test if the document is accepted. */
function issuesOf(doc: unknown, files?: Map<string, unknown>) {
  const result = validate(doc, files);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues;
}

describe("validateWorkflowPackage schema versions", () => {
  it("accepts a version-1 document without decisions or policy", () => {
    const doc = validPackage();
    doc["schemaVersion"] = 1;
    delete doc["decisions"];
    delete doc["policy"];

    const result = validate(doc);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.schemaVersion).toBe(1);
    expect(result.package.decisions).toEqual({});
    expect(result.package.policy).toEqual({});
  });

  it("rejects a version-1 document carrying decisions or policy rather than widening it", () => {
    const doc = validPackage();
    doc["schemaVersion"] = 1;

    const paths = issuesOf(doc).map((issue) => issue.path);

    expect(paths).toContain("decisions");
    expect(paths).toContain("policy");
  });

  it("requires decisions and policy in a version-2 document", () => {
    const doc = validPackage();
    delete doc["decisions"];
    delete doc["policy"];

    const paths = issuesOf(doc).map((issue) => issue.path);

    expect(paths).toContain("decisions");
    expect(paths).toContain("policy");
  });

  it("rejects an unknown schema version without validating either version's surface", () => {
    const doc = validPackage();
    doc["schemaVersion"] = 3;

    expect(issuesOf(doc)).toEqual([{ path: "schemaVersion", message: "must be 1 or 2" }]);
  });
});

describe("validateWorkflowPackage decisions", () => {
  function decision(doc: Record<string, unknown>): Record<string, unknown> {
    const decisions = doc["decisions"] as Record<string, Record<string, unknown>>;
    return decisions["escalate"]!;
  }

  it("exposes a declared decision with its authority and basis", () => {
    const result = validate(validPackage());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.decisions["escalate"]).toEqual({
      question: "questions/escalate.json",
      version: 1,
      authority: "binding",
      basis: "Fixture.",
    });
  });

  it("rejects a missing authority naming the decision path", () => {
    const doc = validPackage();
    delete decision(doc)["authority"];

    expect(issuesOf(doc)).toContainEqual({
      path: "decisions.escalate.authority",
      message: "must be one of binding, advisory",
    });
  });

  it("rejects an invalid authority", () => {
    const doc = validPackage();
    decision(doc)["authority"] = "mandatory";

    expect(issuesOf(doc).map((issue) => issue.path)).toContain(
      "decisions.escalate.authority",
    );
  });

  it("rejects a decision without a basis", () => {
    const doc = validPackage();
    delete decision(doc)["basis"];

    expect(issuesOf(doc)).toContainEqual({
      path: "decisions.escalate.basis",
      message: "must be a non-empty string",
    });
  });

  it("rejects a question file that cannot be resolved", () => {
    const doc = validPackage();
    decision(doc)["question"] = "questions/missing.json";

    expect(issuesOf(doc)).toContainEqual({
      path: "decisions.escalate.question",
      message: 'question file "questions/missing.json" cannot be resolved',
    });
  });

  it.each(["../secrets.json", "questions/../secrets.json"])(
    "rejects the question path %s outside the questions directory",
    (path) => {
      const doc = validPackage();
      decision(doc)["question"] = path;

      expect(issuesOf(doc).map((issue) => issue.path)).toContain(
        "decisions.escalate.question",
      );
    },
  );

  it("reports an invalid declared version once, without a misleading mismatch", () => {
    const doc = validPackage();
    decision(doc)["version"] = 0;

    const issues = issuesOf(doc).filter((issue) => issue.path === "decisions.escalate.version");

    expect(issues).toEqual([
      { path: "decisions.escalate.version", message: "must be an integer of at least 1" },
    ]);
  });

  it("rejects an unversioned question file", () => {
    const files = questionFiles();
    const file = files.get("questions/escalate.json") as Record<string, unknown>;
    delete file["version"];

    expect(issuesOf(validPackage(), files)).toContainEqual({
      path: "questions/escalate.json#version",
      message: "must be an integer of at least 1",
    });
  });

  it("rejects a question file whose version differs from the declared version", () => {
    const doc = validPackage();
    decision(doc)["version"] = 2;

    expect(issuesOf(doc)).toContainEqual({
      path: "decisions.escalate.version",
      message: 'declares version 2 but "questions/escalate.json" carries version 1',
    });
  });

  it("rejects a question file naming a different decision", () => {
    const files = questionFiles();
    const file = files.get("questions/escalate.json") as Record<string, unknown>;
    file["decision"] = "validate";

    expect(issuesOf(validPackage(), files).map((issue) => issue.path)).toContain(
      "questions/escalate.json#decision",
    );
  });

  it("rejects a malformed question file naming the file", () => {
    const result = validateWorkflowPackage(validPackage(), {
      readQuestionFile: () => "{not json",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((entry) => entry.path === "questions/escalate.json");
    expect(issue?.message).toContain("not valid JSON");
  });

  it("rejects a question file with an empty answer set", () => {
    const files = questionFiles();
    const file = files.get("questions/escalate.json") as Record<string, unknown>;
    file["answers"] = [];

    expect(issuesOf(validPackage(), files).map((issue) => issue.path)).toContain(
      "questions/escalate.json#answers",
    );
  });

  it("reports unresolvable question files when no reader is supplied", () => {
    const result = validateWorkflowPackage(validPackage());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain("decisions.escalate.question");
  });
});

describe("validateWorkflowPackage policy", () => {
  function policy(doc: Record<string, unknown>): Record<string, unknown> {
    return doc["policy"] as Record<string, unknown>;
  }

  it("rejects a policy entry without a basis", () => {
    const doc = validPackage();
    delete (policy(doc)["escalate"] as Record<string, unknown>)["basis"];

    expect(issuesOf(doc)).toContainEqual({
      path: "policy.escalate.basis",
      message: "must be a non-empty string",
    });
  });

  it("rejects a non-numeric threshold", () => {
    const doc = validPackage();
    (policy(doc)["escalate"] as Record<string, unknown>)["thresholds"] = { confidence: "high" };

    expect(issuesOf(doc).map((issue) => issue.path)).toContain(
      "policy.escalate.thresholds.confidence",
    );
  });

  it("rejects a policy entry for an undeclared decision", () => {
    const doc = validPackage();
    policy(doc)["validate"] = { thresholds: {}, basis: "Fixture." };

    expect(issuesOf(doc)).toContainEqual({
      path: "policy.validate",
      message: 'no decision named "validate" is declared',
    });
  });

  it("rejects a declared decision with no policy entry", () => {
    const doc = validPackage();
    delete policy(doc)["escalate"];

    expect(issuesOf(doc)).toContainEqual({
      path: "policy.escalate",
      message: 'decision "escalate" has no policy entry',
    });
  });

  it("defaults weights to an empty set", () => {
    const result = validate(validPackage());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.policy["escalate"]?.weights).toEqual({});
  });
});

describe("validateWorkflowPackage", () => {
  it("accepts a structurally valid package", () => {
    const result = validate(validPackage());

    expect(result.ok).toBe(true);
  });

  it("reports an actionable path for a duplicate action", () => {
    const doc = validPackage();
    const actions = doc["actions"] as unknown[];
    actions.push(structuredClone(actions[0]));

    const result = validate(doc);

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

    const result = validate(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("actions[0].prerequisites[0]");
    expect(result.issues[0]?.message).toContain("plan.blessed");
  });

  it("rejects an action with no required roles", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[0]!["requiredRoles"] = [];

    const result = validate(doc);

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

    const result = validate(doc);

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

    const result = validate(doc);

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

    const result = validate(doc);

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

    const result = validate(doc);

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

    const result = validate(doc);

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

    const result = validate(doc);

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

    const result = validate(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("actions[2].prerequisites");
    expect(paths).toContain("actions[2].requiresGitRepository");
  });

  it("rejects a Git-bound action that drops the pause for changes of unclear ownership", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions[0]!["prerequisites"] = ["plan.accepted", "execution.authorized", "git.repository"];

    const result = validate(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "actions[0].prerequisites",
      message:
        'action "implement" requires a Git repository and must list the "git.changesOwned" prerequisite; pre-existing changes are never absorbed silently',
    });
  });

  it("rejects a Git ownership prerequisite on an action that does not require Git", () => {
    const doc = validPackage();
    const actions = doc["actions"] as Record<string, unknown>[];
    actions.push({
      name: "brainstorm",
      kind: "stage",
      summary: "Investigate.",
      requiredRoles: [{ role: "investigator", independentFromImplementer: false }],
      delegationLimits: { maxParallelWorkers: 1, allowParallelWithinUnit: false },
      canEditCode: false,
      requiresGitRepository: false,
      prerequisites: ["git.changesOwned"],
      produces: [],
    });

    const result = validate(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain("actions[2].requiresGitRepository");
  });

  it("rejects a non-object document", () => {
    const result = validate("not a package");

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

    const result = validate(doc);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadShippedWorkflowPackage", () => {
  const pkg = loadShippedWorkflowPackage();

  it("loads the single shipped workflow package at schema version 2", () => {
    expect(pkg.schemaVersion).toBe(2);
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
      "realign",
    ]);
  });

  it("declares realign as a stage action that implements nothing and needs an accepted plan", () => {
    const realign = pkg.actions.find((a) => a.name === "realign");

    expect(realign?.canEditCode).toBe(false);
    expect(realign?.prerequisites).toContain("plan.accepted");
    expect(realign?.requiresHumanAcceptanceOf).toBe("plan");
  });

  it("declares the seven first-release decisions with their authority", () => {
    const authorities = Object.fromEntries(
      Object.entries(pkg.decisions).map(([name, decision]) => [name, decision.authority]),
    );

    expect(authorities).toEqual({
      "next-action": "advisory",
      assignment: "advisory",
      "lesson-retention": "advisory",
      "model-selection": "advisory",
      classify: "advisory",
      escalate: "binding",
      validate: "binding",
    });
  });

  it("gives every decision a basis, a question skeleton and a policy entry with a basis", () => {
    for (const [name, decision] of Object.entries(pkg.decisions)) {
      expect(decision.basis, name).not.toBe("");
      expect(decision.question, name).toMatch(/^questions\/[a-z-]+\.json$/);
      expect(pkg.policy[name]?.basis, name).not.toBe("");
    }
  });

  it("keeps policy thresholds out of the question files", () => {
    for (const decision of Object.values(pkg.decisions)) {
      const file = JSON.parse(
        readFileSync(new URL(`../../workflow/${decision.question}`, import.meta.url), "utf8"),
      ) as Record<string, unknown>;

      expect(file).not.toHaveProperty("thresholds");
      expect(file).not.toHaveProperty("policy");
    }
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
      const result = validate(doc);
      if (!result.ok) throw new WorkflowPackageError(result.issues);
    }).toThrow(WorkflowPackageError);
  });
});
