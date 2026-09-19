import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  WORKFLOW_ARTEFACTS,
  WORKFLOW_CONDITIONS,
  WorkflowPackageError,
  type ActionKind,
  type ConfigurationSurface,
  type SettingDefinition,
  type SettingType,
  type ValidationIssue,
  type WorkflowAction,
  type WorkflowArtefact,
  type WorkflowCondition,
  type WorkflowPackage,
  type WorkflowRole,
} from "./types.js";

export type ValidationResult =
  | { readonly ok: true; readonly package: WorkflowPackage }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * Artefacts whose producing action is an assessment: it must be performed by an
 * agent independent of the implementer and must never edit code (SPEC.md
 * D31/D32, "Git environment handling").
 */
const INDEPENDENT_ASSESSMENT_ARTEFACT: WorkflowArtefact = "review";
const READ_ONLY_ARTEFACTS: readonly WorkflowArtefact[] = ["review", "diagnosis"];

const ACTION_KINDS: readonly ActionKind[] = ["stage", "always-available"];
const SETTING_TYPES: readonly SettingType[] = ["boolean", "integer", "enum"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}

function requireBoolean(
  value: unknown,
  path: string,
  issues: IssueCollector,
): boolean {
  if (typeof value !== "boolean") {
    issues.add(path, "must be a boolean");
    return false;
  }
  return value;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(path, "must be a non-empty string");
    return "";
  }
  return value;
}

function requireIntegerInRange(
  value: unknown,
  path: string,
  minimum: number,
  issues: IssueCollector,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    issues.add(path, `must be an integer of at least ${minimum}`);
    return minimum;
  }
  return value;
}

function validateRoles(
  value: unknown,
  path: string,
  issues: IssueCollector,
): WorkflowRole[] {
  if (!Array.isArray(value)) {
    issues.add(path, "must be an array of roles");
    return [];
  }
  if (value.length === 0) {
    issues.add(path, "must declare at least one required role");
    return [];
  }

  const roles: WorkflowRole[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.add(entryPath, "must be an object");
      return;
    }
    const role = requireNonEmptyString(entry["role"], `${entryPath}.role`, issues);
    const independent = requireBoolean(
      entry["independentFromImplementer"],
      `${entryPath}.independentFromImplementer`,
      issues,
    );
    roles.push({ role, independentFromImplementer: independent });
  });

  return roles;
}

function validateDelegationLimits(
  value: unknown,
  path: string,
  issues: IssueCollector,
): { maxParallelWorkers: number; allowParallelWithinUnit: boolean } {
  if (!isRecord(value)) {
    issues.add(path, "must be an object");
    return { maxParallelWorkers: 1, allowParallelWithinUnit: false };
  }
  return {
    maxParallelWorkers: requireIntegerInRange(
      value["maxParallelWorkers"],
      `${path}.maxParallelWorkers`,
      1,
      issues,
    ),
    allowParallelWithinUnit: requireBoolean(
      value["allowParallelWithinUnit"],
      `${path}.allowParallelWithinUnit`,
      issues,
    ),
  };
}

function validateEnumArray<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  label: string,
  issues: IssueCollector,
): T[] {
  if (!Array.isArray(value)) {
    issues.add(path, `must be an array of ${label}s`);
    return [];
  }
  const result: T[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !allowed.includes(entry as T)) {
      issues.add(
        `${path}[${index}]`,
        `unknown ${label} "${String(entry)}"; expected one of ${allowed.join(", ")}`,
      );
      return;
    }
    result.push(entry as T);
  });
  return result;
}

function validateAction(
  value: unknown,
  path: string,
  issues: IssueCollector,
): WorkflowAction | undefined {
  if (!isRecord(value)) {
    issues.add(path, "must be an object");
    return undefined;
  }

  const name = requireNonEmptyString(value["name"], `${path}.name`, issues);

  const kindValue = value["kind"];
  let kind: ActionKind = "stage";
  if (typeof kindValue !== "string" || !ACTION_KINDS.includes(kindValue as ActionKind)) {
    issues.add(`${path}.kind`, `must be one of ${ACTION_KINDS.join(", ")}`);
  } else {
    kind = kindValue as ActionKind;
  }

  const summary = requireNonEmptyString(value["summary"], `${path}.summary`, issues);
  const requiredRoles = validateRoles(
    value["requiredRoles"],
    `${path}.requiredRoles`,
    issues,
  );
  const delegationLimits = validateDelegationLimits(
    value["delegationLimits"],
    `${path}.delegationLimits`,
    issues,
  );

  const canEditCode = requireBoolean(
    value["canEditCode"],
    `${path}.canEditCode`,
    issues,
  );

  const requiresGitRepository = requireBoolean(
    value["requiresGitRepository"],
    `${path}.requiresGitRepository`,
    issues,
  );

  const prerequisites = validateEnumArray<WorkflowCondition>(
    value["prerequisites"],
    `${path}.prerequisites`,
    WORKFLOW_CONDITIONS,
    "prerequisite condition",
    issues,
  );

  if (kind === "always-available") {
    // status/next/todo/learn must resolve in any workflow state (SPEC.md D25),
    // so a gate declared here would silently never be enforced.
    if (prerequisites.length > 0) {
      issues.add(
        `${path}.prerequisites`,
        `always-available action "${name}" must not declare prerequisites; it is eligible in any workflow state`,
      );
    }
    if (requiresGitRepository) {
      issues.add(
        `${path}.requiresGitRepository`,
        `always-available action "${name}" must not require a Git repository`,
      );
    }
  } else {
    if (requiresGitRepository && !prerequisites.includes("git.repository")) {
      issues.add(
        `${path}.prerequisites`,
        `action "${name}" requires a Git repository and must list the "git.repository" prerequisite`,
      );
    }
    if (!requiresGitRepository && prerequisites.includes("git.repository")) {
      issues.add(
        `${path}.requiresGitRepository`,
        `action "${name}" lists the "git.repository" prerequisite and must set requiresGitRepository: true`,
      );
    }
  }

  const produces = validateEnumArray<WorkflowArtefact>(
    value["produces"],
    `${path}.produces`,
    WORKFLOW_ARTEFACTS,
    "artefact",
    issues,
  );

  if (canEditCode && produces.some((artefact) => READ_ONLY_ARTEFACTS.includes(artefact))) {
    issues.add(`${path}.canEditCode`, `action "${name}" must not edit code`);
  }

  const acceptanceValue = value["requiresHumanAcceptanceOf"];  let requiresHumanAcceptanceOf: WorkflowArtefact | undefined;
  if (acceptanceValue !== undefined) {
    if (
      typeof acceptanceValue !== "string" ||
      !WORKFLOW_ARTEFACTS.includes(acceptanceValue as WorkflowArtefact)
    ) {
      issues.add(
        `${path}.requiresHumanAcceptanceOf`,
        `unknown artefact "${String(acceptanceValue)}"`,
      );
    } else if (!produces.includes(acceptanceValue as WorkflowArtefact)) {
      issues.add(
        `${path}.requiresHumanAcceptanceOf`,
        `artefact "${acceptanceValue}" is not produced by action "${name}"`,
      );
    } else {
      requiresHumanAcceptanceOf = acceptanceValue as WorkflowArtefact;
    }
  }

  return {
    name,
    kind,
    summary,
    requiredRoles,
    delegationLimits,
    canEditCode,
    requiresGitRepository,
    prerequisites,
    produces,
    ...(requiresHumanAcceptanceOf === undefined ? {} : { requiresHumanAcceptanceOf }),
  };
}

function validateSetting(
  value: unknown,
  path: string,
  issues: IssueCollector,
): SettingDefinition | undefined {
  if (!isRecord(value)) {
    issues.add(path, "must be an object");
    return undefined;
  }

  const key = requireNonEmptyString(value["key"], `${path}.key`, issues);
  const summary = requireNonEmptyString(value["summary"], `${path}.summary`, issues);

  const typeValue = value["type"];
  if (typeof typeValue !== "string" || !SETTING_TYPES.includes(typeValue as SettingType)) {
    issues.add(`${path}.type`, `must be one of ${SETTING_TYPES.join(", ")}`);
    return undefined;
  }
  const type = typeValue as SettingType;

  const defaultValue = value["default"];
  const minimum = value["minimum"];
  const maximum = value["maximum"];
  const values = value["values"];

  if (type === "boolean" && typeof defaultValue !== "boolean") {
    issues.add(`${path}.default`, "must be a boolean");
  }
  if (type === "integer") {
    if (typeof defaultValue !== "number" || !Number.isInteger(defaultValue)) {
      issues.add(`${path}.default`, "must be an integer");
    }
    if (minimum !== undefined && typeof minimum !== "number") {
      issues.add(`${path}.minimum`, "must be a number");
    }
    if (maximum !== undefined && typeof maximum !== "number") {
      issues.add(`${path}.maximum`, "must be a number");
    }
  }
  if (type === "enum") {
    if (!Array.isArray(values) || values.length === 0) {
      issues.add(`${path}.values`, "must be a non-empty array of allowed values");
    } else if (typeof defaultValue !== "string" || !values.includes(defaultValue)) {
      issues.add(`${path}.default`, "must be one of the declared values");
    }
  }

  const locked = value["locked"];
  if (locked !== undefined && typeof locked !== "boolean") {
    issues.add(`${path}.locked`, "must be a boolean");
  }

  return {
    key,
    type,
    summary,
    default: defaultValue as boolean | number | string,
    ...(typeof minimum === "number" ? { minimum } : {}),
    ...(typeof maximum === "number" ? { maximum } : {}),
    ...(Array.isArray(values) ? { values: values as readonly string[] } : {}),
    ...(typeof locked === "boolean" ? { locked } : {}),
  };
}

function validateConfigurationSurface(
  value: unknown,
  actionNames: ReadonlySet<string>,
  path: string,
  issues: IssueCollector,
): ConfigurationSurface {
  const empty: ConfigurationSurface = {
    configurableStageModels: [],
    allowImplicitModelFallback: false,
    settings: [],
  };

  if (!isRecord(value)) {
    issues.add(path, "must be an object");
    return empty;
  }

  const stageModels: string[] = [];
  const stageModelsValue = value["configurableStageModels"];
  if (!Array.isArray(stageModelsValue)) {
    issues.add(`${path}.configurableStageModels`, "must be an array of action names");
  } else {
    stageModelsValue.forEach((entry, index) => {
      const entryPath = `${path}.configurableStageModels[${index}]`;
      if (typeof entry !== "string") {
        issues.add(entryPath, "must be a string");
        return;
      }
      if (!actionNames.has(entry)) {
        issues.add(entryPath, `unknown action "${entry}"`);
        return;
      }
      stageModels.push(entry);
    });
  }

  if (value["allowImplicitModelFallback"] !== false) {
    issues.add(
      `${path}.allowImplicitModelFallback`,
      "must be false; an unavailable model requires an explicit fallback or a human decision",
    );
  }

  const settings: SettingDefinition[] = [];
  const settingsValue = value["settings"];
  if (!Array.isArray(settingsValue)) {
    issues.add(`${path}.settings`, "must be an array of setting definitions");
  } else {
    const seen = new Set<string>();
    settingsValue.forEach((entry, index) => {
      const setting = validateSetting(entry, `${path}.settings[${index}]`, issues);
      if (!setting) return;
      if (seen.has(setting.key)) {
        issues.add(
          `${path}.settings[${index}].key`,
          `duplicate setting key "${setting.key}"`,
        );
        return;
      }
      seen.add(setting.key);
      settings.push(setting);
    });
  }

  return {
    configurableStageModels: stageModels,
    allowImplicitModelFallback: false,
    settings,
  };
}

/**
 * Enforces the mandatory separate-review gate structurally rather than by
 * action name: the package must contain at least one action producing a review,
 * and every such action must require a role independent of the implementer
 * (SPEC.md D31/D32). Deleting or renaming the review action cannot bypass this.
 */
function validateIndependentReviewGate(
  actions: readonly WorkflowAction[],
  actionIndexes: ReadonlyMap<string, number>,
  issues: IssueCollector,
): void {
  const reviewers = actions.filter((action) =>
    action.produces.includes(INDEPENDENT_ASSESSMENT_ARTEFACT),
  );

  if (reviewers.length === 0) {
    issues.add(
      "actions",
      `must declare at least one action producing the "${INDEPENDENT_ASSESSMENT_ARTEFACT}" artefact; the separate-review gate cannot be removed`,
    );
    return;
  }

  for (const action of reviewers) {
    if (action.requiredRoles.some((role) => role.independentFromImplementer)) continue;
    const index = actionIndexes.get(action.name);
    issues.add(
      `actions[${index}].requiredRoles`,
      `action "${action.name}" must declare a role with independentFromImplementer: true; the separate-review gate cannot be disabled`,
    );
  }
}

/**
 * Validates a parsed workflow package document, collecting every issue rather
 * than failing at the first, so misconfiguration surfaces as one actionable
 * report (SPEC.md user story 50).
 */
export function validateWorkflowPackage(document: unknown): ValidationResult {
  const issues = new IssueCollector();

  if (!isRecord(document)) {
    issues.add("", "workflow package must be an object");
    return { ok: false, issues: issues.issues };
  }

  if (document["schemaVersion"] !== 1) {
    issues.add("schemaVersion", "must be 1");
  }
  const id = requireNonEmptyString(document["id"], "id", issues);
  const name = requireNonEmptyString(document["name"], "name", issues);

  const actions: WorkflowAction[] = [];
  const actionIndexes = new Map<string, number>();
  const actionNames = new Set<string>();
  const actionsValue = document["actions"];
  if (!Array.isArray(actionsValue) || actionsValue.length === 0) {
    issues.add("actions", "must be a non-empty array of actions");
  } else {
    actionsValue.forEach((entry, index) => {
      const action = validateAction(entry, `actions[${index}]`, issues);
      if (!action) return;
      if (actionNames.has(action.name)) {
        issues.add(`actions[${index}].name`, `duplicate action name "${action.name}"`);
        return;
      }
      actionNames.add(action.name);
      actionIndexes.set(action.name, index);
      actions.push(action);
    });
    validateIndependentReviewGate(actions, actionIndexes, issues);
  }

  const configurationSurface = validateConfigurationSurface(
    document["configurationSurface"],
    actionNames,
    "configurationSurface",
    issues,
  );

  if (!issues.ok) {
    return { ok: false, issues: issues.issues };
  }

  return {
    ok: true,
    package: { schemaVersion: 1, id, name, actions, configurationSurface },
  };
}

const SHIPPED_PACKAGE_URL = new URL("../../workflow/jflow.workflow.json", import.meta.url);

let cached: WorkflowPackage | undefined;

/**
 * Loads the single workflow package shipped with jflow (SPEC.md D8, D24).
 *
 * @throws {WorkflowPackageError} when the shipped package fails validation.
 */
export function loadShippedWorkflowPackage(): WorkflowPackage {
  if (cached) return cached;

  const raw = readFileSync(fileURLToPath(SHIPPED_PACKAGE_URL), "utf8");
  const result = validateWorkflowPackage(JSON.parse(raw));
  if (!result.ok) {
    throw new WorkflowPackageError(result.issues);
  }
  cached = result.package;
  return cached;
}
