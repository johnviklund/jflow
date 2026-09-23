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
  type ObservedStateField,
  type ResolutionContext,
  type UnmetPrerequisite,
  type WorkflowState,
} from "./actions/resolve.js";

export { runStatus, type ActionStatus, type StatusReport } from "./actions/status.js";

export { runNext, type NextReport, type Recommendation } from "./actions/next.js";

export {
  promoteTodo,
  recordTodo,
  type PromotionResult,
  type TodoDraft,
  type TodoResult,
} from "./actions/todo.js";

export {
  acceptPlan,
  authorizeExecution,
  writePlan,
  type Authorization,
  type PlanDraft,
  type PlanOutcome,
  type PlanResult,
  type TicketDraft,
} from "./actions/plan.js";

export { refuse, unreadable, type Refusal } from "./actions/refusal.js";

export {
  claimChanges,
  type ChangeClaim,
  type ClaimOutcome,
  type ClaimResult,
} from "./actions/changes.js";

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
  CHANGE_OWNERS,
  DECISION_STATUSES,
  FALLBACK_SCOPES,
  FALLBACK_STATUSES,
  LESSON_STATUSES,
  PLAN_STATUSES,
  PROJECT_RECORD_DIRECTORY,
  RECORD_KINDS,
  RecordValidationError,
  SPECIFICATION_STATUSES,
  TICKET_STATUSES,
  TODO_STATUSES,
  readRecord,
  recordPath,
  validateRecord,
  writeRecord,
  type AuthorizationScope,
  type ChangeOwner,
  type ChangeOwnership,
  type DecisionStatus,
  type FallbackScope,
  type FallbackStatus,
  type JevRecord,
  type LessonEvidence,
  type LessonRecord,
  type LessonStatus,
  type LessonsRecord,
  type PlanRecord,
  type PlanStatus,
  type ProgressRecord,
  type ProjectRecords,
  type ReconciliationDiscrepancy,
  type RecordKind,
  type RecordReadResult,
  type RecordValidation,
  type ResumeRecord,
  type SpecificationDecision,
  type SpecificationRecord,
  type SpecificationStatus,
  type TicketRecord,
  type TicketStatus,
  type TicketsRecord,
  type TodoItem,
  type TodoStatus,
  type TodosRecord,
} from "./project/records.js";

export { readProjectState, type ProjectStateResult } from "./project/state.js";

export { readWorkingTree, type WorkingTree } from "./project/worktree.js";

export {
  buildEvidencePacket,
  redact,
  sharingLimitsFrom,
  type EvidenceExcerpt,
  type EvidenceInput,
  type EvidencePacket,
  type ExcerptScope,
  type Omission,
  type SharingLimits,
} from "./jev/evidence.js";

export {
  JEV_ENDPOINT,
  JEV_MODEL,
  askJev,
  fetchTransport,
  loadDecisionQuestion,
  type DecisionQuestion,
  type JevCallResult,
  type JevCallSummary,
  type JevClientOptions,
  type JevFailure,
  type JevTransport,
  type TransportRequest,
} from "./jev/client.js";

export { TRACE_DIRECTORY, cleanTraces, listTraces } from "./jev/traces.js";
