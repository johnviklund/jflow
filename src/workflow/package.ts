import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DECISION_AUTHORITIES,
  QUESTION_STATUSES,
  WORKFLOW_ARTEFACTS,
  WORKFLOW_CONDITIONS,
  WorkflowPackageError,
  type ActionKind,
  type ConfigurationSurface,
  type DecisionAuthority,
  type DecisionDeclaration,
  type PolicyEntry,
  type QuestionStatus,
  type SettingDefinition,
  type SettingType,
  type ValidationIssue,
  type WorkflowAction,
  type WorkflowArtefact,
  type WorkflowCondition,
  type WorkflowPackage,
  type WorkflowRole,
  type WorkflowSchemaVersion,
} from "./types.js";
import {
  IssueCollector,
  isRecord,
  requireBoolean,
  requireIntegerInRange,
  requireNonEmptyString,
  validateEnumValue,
} from "../validation.js";

export type ValidationResult =
  | { readonly ok: true; readonly package: WorkflowPackage }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * Reads a question file by its package-relative path (e.g.
 * `questions/escalate.json`), returning its raw text or `undefined` when no
 * such file exists.
 */
export type QuestionFileReader = (relativePath: string) => string | undefined;

export interface ValidationOptions {
  /**
   * Without a reader no question file can resolve, so a version-2 document
   * that declares decisions fails validation.
   */
  readonly readQuestionFile?: QuestionFileReader;
}

const SCHEMA_VERSIONS: readonly WorkflowSchemaVersion[] = [1, 2];

/** Question files must live here so a decision cannot point outside the package (D37). */
const QUESTION_DIRECTORY = "questions/";

/**
 * Artefacts whose producing action is an assessment: it must be performed by an
 * agent independent of the implementer and must never edit code (SPEC.md
 * D31/D32, "Git environment handling").
 */
const INDEPENDENT_ASSESSMENT_ARTEFACT: WorkflowArtefact = "review";
const READ_ONLY_ARTEFACTS: readonly WorkflowArtefact[] = ["review", "diagnosis"];

/** Prerequisites every action that requires a Git repository must list, and why. */
const GIT_CONDITIONS: readonly (readonly [WorkflowCondition, string])[] = [
  ["git.repository", ""],
  ["git.changesOwned", "; pre-existing changes are never absorbed silently"],
];

const ACTION_KINDS: readonly ActionKind[] = ["stage", "always-available"];
const SETTING_TYPES: readonly SettingType[] = ["boolean", "integer", "enum"];

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

  const kind =
    validateEnumValue<ActionKind>(value["kind"], `${path}.kind`, ACTION_KINDS, issues) ?? "stage";

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
    // Work against a repository also pauses on changes nobody owns (issue
    // #7); a package cannot drop that pause.
    for (const [condition, why] of GIT_CONDITIONS) {
      if (requiresGitRepository && !prerequisites.includes(condition)) {
        issues.add(
          `${path}.prerequisites`,
          `action "${name}" requires a Git repository and must list the "${condition}" prerequisite${why}`,
        );
      }
      if (!requiresGitRepository && prerequisites.includes(condition)) {
        issues.add(
          `${path}.requiresGitRepository`,
          `action "${name}" lists the "${condition}" prerequisite and must set requiresGitRepository: true`,
        );
      }
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

  const type = validateEnumValue<SettingType>(value["type"], `${path}.type`, SETTING_TYPES, issues);
  if (type === undefined) return undefined;

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
 * Parses and checks a question file for well-formedness: it names its decision,
 * carries a version, and closes its answer set. Wording is not judged here; it
 * is proposed to the human by the decision that owns it (SPEC.md D37).
 * Returns the file's version when it is well-formed.
 */
function validateQuestionFile(
  raw: string,
  relativePath: string,
  decisionName: string,
  issues: IssueCollector,
): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    issues.add(relativePath, `is not valid JSON: ${(error as Error).message}`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    issues.add(relativePath, "question file must be an object");
    return undefined;
  }

  // Issue paths inside a question file are `<file>#<field>`, so they read as
  // a location in that file rather than a key of the package document.
  const field = (name: string) => `${relativePath}#${name}`;
  const before = issues.count;
  const decision = requireNonEmptyString(parsed["decision"], field("decision"), issues);
  if (decision !== "" && decision !== decisionName) {
    issues.add(
      field("decision"),
      `names decision "${decision}" but is declared by decision "${decisionName}"`,
    );
  }
  const version = requireIntegerInRange(parsed["version"], field("version"), 1, issues);
  validateEnumValue<QuestionStatus>(parsed["status"], field("status"), QUESTION_STATUSES, issues);
  requireNonEmptyString(parsed["prompt"], field("prompt"), issues);

  const answers = parsed["answers"];
  if (
    !Array.isArray(answers) ||
    answers.length === 0 ||
    answers.some((answer) => typeof answer !== "string" || answer.trim() === "")
  ) {
    issues.add(field("answers"), "must be a non-empty array of answer names");
  }

  return issues.count === before ? version : undefined;
}

function validateDecision(
  value: unknown,
  name: string,
  path: string,
  readQuestionFile: QuestionFileReader | undefined,
  issues: IssueCollector,
): DecisionDeclaration | undefined {
  if (!isRecord(value)) {
    issues.add(path, "must be an object");
    return undefined;
  }

  const question = requireNonEmptyString(value["question"], `${path}.question`, issues);
  const versionValue = value["version"];
  const version = requireIntegerInRange(versionValue, `${path}.version`, 1, issues);
  const versionIsValid = versionValue === version;
  const authority = validateEnumValue<DecisionAuthority>(
    value["authority"],
    `${path}.authority`,
    DECISION_AUTHORITIES,
    issues,
  );
  const basis = requireNonEmptyString(value["basis"], `${path}.basis`, issues);

  if (question !== "") {
    if (!question.startsWith(QUESTION_DIRECTORY) || question.split("/").includes("..")) {
      issues.add(
        `${path}.question`,
        `must be a path under "${QUESTION_DIRECTORY}" inside the package`,
      );
    } else {
      const raw = readQuestionFile?.(question);
      if (raw === undefined) {
        issues.add(`${path}.question`, `question file "${question}" cannot be resolved`);
      } else {
        const fileVersion = validateQuestionFile(raw, question, name, issues);
        if (versionIsValid && fileVersion !== undefined && fileVersion !== version) {
          issues.add(
            `${path}.version`,
            `declares version ${version} but "${question}" carries version ${fileVersion}`,
          );
        }
      }
    }
  }

  if (authority === undefined) return undefined;
  return { question, version, authority, basis };
}

function validateNumberMap(
  value: unknown,
  path: string,
  issues: IssueCollector,
): Record<string, number> {
  if (!isRecord(value)) {
    issues.add(path, "must be an object of named numbers");
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      issues.add(`${path}.${key}`, "must be a finite number");
      continue;
    }
    result[key] = entry;
  }
  return result;
}

function validatePolicyEntry(
  value: unknown,
  path: string,
  issues: IssueCollector,
): PolicyEntry | undefined {
  if (!isRecord(value)) {
    issues.add(path, "must be an object");
    return undefined;
  }
  const thresholds = validateNumberMap(value["thresholds"], `${path}.thresholds`, issues);
  const weights =
    value["weights"] === undefined
      ? {}
      : validateNumberMap(value["weights"], `${path}.weights`, issues);
  const basis = requireNonEmptyString(value["basis"], `${path}.basis`, issues);
  return { thresholds, weights, basis };
}

/**
 * Validates the version-2 declaration surface: decisions and their policy are
 * a bijection, so no decision runs without declared thresholds and no
 * threshold exists for a decision nobody declared (SPEC.md D37, D49).
 */
function validateDecisionsAndPolicy(
  document: Record<string, unknown>,
  readQuestionFile: QuestionFileReader | undefined,
  issues: IssueCollector,
): Pick<WorkflowPackage, "decisions" | "policy"> {
  const decisions: Record<string, DecisionDeclaration> = {};
  const policy: Record<string, PolicyEntry> = {};

  const decisionsValue = document["decisions"];
  if (!isRecord(decisionsValue)) {
    issues.add("decisions", "must be an object keyed by decision name");
  } else {
    for (const [name, entry] of Object.entries(decisionsValue)) {
      const decision = validateDecision(
        entry,
        name,
        `decisions.${name}`,
        readQuestionFile,
        issues,
      );
      if (decision) decisions[name] = decision;
    }
  }

  const policyValue = document["policy"];
  if (!isRecord(policyValue)) {
    issues.add("policy", "must be an object keyed by decision name");
  } else {
    for (const [name, entry] of Object.entries(policyValue)) {
      if (isRecord(decisionsValue) && !(name in decisionsValue)) {
        issues.add(`policy.${name}`, `no decision named "${name}" is declared`);
        continue;
      }
      const policyEntry = validatePolicyEntry(entry, `policy.${name}`, issues);
      if (policyEntry) policy[name] = policyEntry;
    }
    if (isRecord(decisionsValue)) {
      for (const name of Object.keys(decisionsValue)) {
        if (!(name in policyValue)) {
          issues.add(`policy.${name}`, `decision "${name}" has no policy entry`);
        }
      }
    }
  }

  return { decisions, policy };
}

/**
 * Validates a parsed workflow package document, collecting every issue rather
 * than failing at the first, so misconfiguration surfaces as one actionable
 * report (SPEC.md user story 50).
 */
export function validateWorkflowPackage(
  document: unknown,
  options: ValidationOptions = {},
): ValidationResult {
  const issues = new IssueCollector();

  if (!isRecord(document)) {
    issues.add("", "workflow package must be an object");
    return { ok: false, issues: issues.issues };
  }

  const schemaVersionValue = document["schemaVersion"];
  const schemaVersion = SCHEMA_VERSIONS.includes(schemaVersionValue as WorkflowSchemaVersion)
    ? (schemaVersionValue as WorkflowSchemaVersion)
    : undefined;
  if (schemaVersion === undefined) {
    issues.add("schemaVersion", `must be ${SCHEMA_VERSIONS.join(" or ")}`);
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

  // A released schema is not widened in place (SPEC.md D37): version 1 has no
  // declaration surface, and a version-1 document carrying one is rejected
  // rather than read as version 2.
  let declarations: Pick<WorkflowPackage, "decisions" | "policy"> = {
    decisions: {},
    policy: {},
  };
  if (schemaVersion === 1) {
    for (const key of ["decisions", "policy"] as const) {
      if (document[key] !== undefined) {
        issues.add(key, `is not part of schema version 1; declare schemaVersion: 2 to use it`);
      }
    }
  } else if (schemaVersion === 2) {
    declarations = validateDecisionsAndPolicy(document, options.readQuestionFile, issues);
  }

  if (!issues.ok || schemaVersion === undefined) {
    return { ok: false, issues: issues.issues };
  }

  return {
    ok: true,
    package: { schemaVersion, id, name, actions, configurationSurface, ...declarations },
  };
}

const SHIPPED_PACKAGE_DIRECTORY = fileURLToPath(new URL("../../workflow/", import.meta.url));
const SHIPPED_PACKAGE_PATH = join(SHIPPED_PACKAGE_DIRECTORY, "jflow.workflow.json");

/** Reads a question file relative to the shipped package; absent files resolve to undefined. */
export function readShippedQuestionFile(relativePath: string): string | undefined {
  try {
    return readFileSync(join(SHIPPED_PACKAGE_DIRECTORY, relativePath), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    throw error;
  }
}

let cached: WorkflowPackage | undefined;

/**
 * Loads the single workflow package shipped with jflow (SPEC.md D8, D24).
 *
 * @throws {WorkflowPackageError} when the shipped package fails validation.
 */
export function loadShippedWorkflowPackage(): WorkflowPackage {
  if (cached) return cached;

  const raw = readFileSync(SHIPPED_PACKAGE_PATH, "utf8");
  const result = validateWorkflowPackage(JSON.parse(raw), {
    readQuestionFile: readShippedQuestionFile,
  });
  if (!result.ok) {
    throw new WorkflowPackageError(result.issues);
  }
  cached = result.package;
  return cached;
}
