/**
 * jflow foundation: the shipped workflow package, its validation, the
 * configuration surface, the workflow-action-contract resolver, the `status`
 * action and the walking-skeleton project state it reads. The test harness in
 * `src/testing/` is scaffolding and is deliberately not exported here.
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

export { runStatus, type ActionStatus, type StatusReport } from "./actions/status.js";

export {
  PROJECT_RECORD_DIRECTORY,
  PROJECT_STATE_FILE,
  projectStatePath,
  readProjectState,
  type ProjectStateResult,
} from "./project/state.js";
