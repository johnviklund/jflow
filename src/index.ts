/**
 * jflow foundation: the shipped workflow package, its validation, the
 * configuration surface, the workflow-action-contract resolver, the `status`
 * action and the walking-skeleton project state it reads. The test harness in
 * `src/testing/` is scaffolding and is deliberately not exported here.
 */

export {
  loadShippedWorkflowPackage,
  validateWorkflowPackage,
  type QuestionFileReader,
  type ValidationOptions,
  type ValidationResult,
} from "./workflow/package.js";

export {
  confidenceThreshold,
  routeByConfidence,
  type ConfidenceRoute,
} from "./workflow/policy.js";

export {
  DECISION_AUTHORITIES,
  WORKFLOW_ARTEFACTS,
  WORKFLOW_CONDITIONS,
  WorkflowPackageError,
  type ActionKind,
  type ConfigurationSurface,
  type DecisionAuthority,
  type DecisionDeclaration,
  type DelegationLimits,
  type PolicyEntry,
  type SettingDefinition,
  type ValidationIssue,
  type WorkflowAction,
  type WorkflowArtefact,
  type WorkflowCondition,
  type WorkflowPackage,
  type WorkflowRole,
  type WorkflowSchemaVersion,
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
  acceptSpecification,
  decideSpecification,
  writeSpecification,
  type SpecificationDraft,
  type SpecificationResult,
} from "./actions/specification.js";

export { resolveRequest, type RequestResolution } from "./actions/request.js";

export {
  dispatch,
  type DispatchOptions,
  type DispatchOutcome,
  type HumanAskEvent,
} from "./actions/dispatch.js";

export {
  HOST_CAPABILITIES,
  checkHostCapabilities,
  type HostCapability,
  type HostCapabilityReport,
  type HostCapabilityResult,
  type HostProbeOptions,
} from "./host/capabilities.js";

export {
  AUTHORIZATION_SCOPES,
  DECISION_STATUSES,
  FALLBACK_SCOPES,
  FALLBACK_STATUSES,
  LESSON_STATUSES,
  PROJECT_RECORD_DIRECTORY,
  RECORD_KINDS,
  RecordValidationError,
  SPECIFICATION_STATUSES,
  TICKET_STATUSES,
  readRecord,
  recordPath,
  writeRecord,
  type AuthorizationScope,
  type DecisionStatus,
  type FallbackScope,
  type FallbackStatus,
  type JevRecord,
  type LessonEvidence,
  type LessonRecord,
  type LessonStatus,
  type LessonsRecord,
  type PlanRecord,
  type ProgressRecord,
  type ProjectRecords,
  type ReconciliationDiscrepancy,
  type RecordKind,
  type RecordReadResult,
  type ResumeRecord,
  type SpecificationDecision,
  type SpecificationRecord,
  type SpecificationStatus,
  type TicketRecord,
  type TicketStatus,
  type TicketsRecord,
} from "./project/records.js";

export { readProjectState, type ProjectStateResult } from "./project/state.js";
