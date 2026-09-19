/**
 * Types for the jflow workflow package: the JSON document that declares the
 * action set, per-stage roles and delegation limits, and the supported
 * configuration surface (SPEC.md, "Workflow package shape").
 */

/** Conditions a workflow action can require before it is eligible to run. */
export const WORKFLOW_CONDITIONS = [
  "specification.accepted",
  "plan.accepted",
  "execution.authorized",
  "ticket.assigned",
  "ticket.changesPresent",
  "git.repository",
] as const;

export type WorkflowCondition = (typeof WORKFLOW_CONDITIONS)[number];

/** Artefacts a workflow action can produce and that the human may accept. */
export const WORKFLOW_ARTEFACTS = [
  "specification",
  "plan",
  "diagnosis",
  "review",
  "resumeRecord",
  "todoItem",
  "lesson",
  "commit",
] as const;

export type WorkflowArtefact = (typeof WORKFLOW_ARTEFACTS)[number];

/**
 * Stage actions advance the workflow; always-available actions may be invoked
 * at any workflow point (SPEC.md D25).
 */
export type ActionKind = "stage" | "always-available";

export interface WorkflowRole {
  readonly role: string;
  /**
   * When true, the agent filling this role must be distinct from the agent
   * that implemented the changes under assessment (SPEC.md D31/D32).
   */
  readonly independentFromImplementer: boolean;
}

export interface DelegationLimits {
  /** Upper bound on workers the primary agent may run concurrently. */
  readonly maxParallelWorkers: number;
  /** Whether parallel work is permitted inside the current unit of work. */
  readonly allowParallelWithinUnit: boolean;
}

export interface WorkflowAction {
  readonly name: string;
  readonly kind: ActionKind;
  readonly summary: string;
  readonly requiredRoles: readonly WorkflowRole[];
  readonly delegationLimits: DelegationLimits;
  /** Whether this action may edit code (SPEC.md: troubleshoot/review may not). */
  readonly canEditCode: boolean;
  /** Whether a local Git repository is required (SPEC.md confirmed default 1). */
  readonly requiresGitRepository: boolean;
  readonly prerequisites: readonly WorkflowCondition[];
  readonly produces: readonly WorkflowArtefact[];
  /** Artefact needing explicit human acceptance before dependent actions run. */
  readonly requiresHumanAcceptanceOf?: WorkflowArtefact;
}

export type SettingType = "boolean" | "integer" | "enum";

export interface SettingDefinition {
  readonly key: string;
  readonly type: SettingType;
  readonly summary: string;
  readonly default: boolean | number | string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly values?: readonly string[];
  /**
   * When true the setting may be read but never changed from its default —
   * used for gates configuration must not be able to weaken (SPEC.md
   * confirmed default 2).
   */
  readonly locked?: boolean;
}

export interface ConfigurationSurface {
  /** Stage actions whose worker model is configurable (SPEC.md D18, D19). */
  readonly configurableStageModels: readonly string[];
  /** Whether a stage worker model may fall back implicitly (always false, SPEC.md D20). */
  readonly allowImplicitModelFallback: false;
  readonly settings: readonly SettingDefinition[];
}

export interface WorkflowPackage {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly actions: readonly WorkflowAction[];
  readonly configurationSurface: ConfigurationSurface;
}

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `actions[2].requiredRoles`. */
  readonly path: string;
  readonly message: string;
}

export class WorkflowPackageError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Invalid jflow workflow package:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "WorkflowPackageError";
    this.issues = issues;
  }
}
