/**
 * jflow foundation: the shipped workflow package, its validation, the
 * configuration surface, and the workflow-action-contract resolver.
 */

export {
  loadShippedWorkflowPackage,
  validateWorkflowPackage,
  type ValidationResult,
} from "./workflow/package.js";

export {
  WORKFLOW_ARTEFACTS,
  WORKFLOW_CONDITIONS,
  WorkflowPackageError,
  type ActionKind,
  type ConfigurationSurface,
  type DelegationLimits,
  type SettingDefinition,
  type ValidationIssue,
  type WorkflowAction,
  type WorkflowArtefact,
  type WorkflowCondition,
  type WorkflowPackage,
  type WorkflowRole,
} from "./workflow/types.js";

export {
  JEV_API_KEY_ENV_VAR,
  resolveConfiguration,
  resolveJevApiKey,
  type ConfigurationResult,
  type JevApiKeyResult,
  type JevApiKeySource,
  type ResolvedConfiguration,
  type SettingValue,
  type StageModelConfiguration,
} from "./config/configuration.js";

export {
  createWorkflowState,
  resolveAction,
  type ActionRequest,
  type ActionResolution,
  type ResolutionContext,
  type UnmetPrerequisite,
  type WorkflowState,
} from "./actions/resolve.js";
