/**
 * jflow foundation: the shipped workflow package, its validation, the
 * configuration surface, the workflow-action-contract resolver, the `status`
 * action and the walking-skeleton project state it reads. The test harness in
 * `src/testing/` is scaffolding and is deliberately not exported here.
 */

export {
  loadShippedWorkflowPackage,
  validateProposedQuestion,
  validateWorkflowPackage,
  type ProposedQuestion,
  type ProposedQuestionResult,
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
  routeItem,
  type PromotionResult,
  type TodoDraft,
  type TodoResult,
} from "./actions/todo.js";

export {
  decideLesson,
  proposeLesson,
  type DecideResult,
  type LessonDecisionInput,
  type LessonDraft,
  type LessonReport,
  type ProposeResult,
} from "./actions/learn.js";

export {
  activeLessons,
  checkLesson,
  supersedeLesson,
  type LessonCheckInput,
  type LessonCheckResult,
  type SupersessionInput,
  type SupersessionResult,
  type UsableLesson,
} from "./actions/lesson-use.js";

export { wrapSession, type WrapDraft, type WrapResult } from "./actions/wrap.js";

export {
  realignPlan,
  recommendRealign,
  type RealignDraft,
  type RealignResult,
  type RecommendationInput,
  type RecommendResult,
  type TicketChange,
} from "./actions/realign.js";

export {
  classifyContent,
  CONTENT_KINDS,
  contentKindOf,
  UNCLEAR_SCOPE,
  type ClassifyInput,
  type ClassifyResult,
  type ContentKind,
} from "./actions/classify.js";

export {
  NO_RECOMMENDATION,
  recommendModel,
  type SelectionDraft,
  type SelectionResult,
} from "./actions/model-selection.js";

export {
  acceptPlan,
  authorizeExecution,
  writeClassifiedPlan,
  writePlan,
  type Authorization,
  type ClassifiedPlanResult,
  type PlanDraft,
  type PlanOutcome,
  type PlanResult,
  type TicketDraft,
  type UntestableCriterion,
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
  CONFLICT_KINDS,
  CONFLICT_STATUSES,
  CONSEQUENTIAL_AREAS,
  CRITERION_VERDICTS,
  DECISION_STATUSES,
  DISCREPANCY_SOURCES,
  FALLBACK_SCOPES,
  FALLBACK_STATUSES,
  LESSON_CHECK_OUTCOMES,
  LESSON_DECIDERS,
  LESSON_OUTCOMES,
  LESSON_STATUSES,
  PLAN_STATUSES,
  PROJECT_RECORD_DIRECTORY,
  RECORD_KINDS,
  RecordValidationError,
  SPECIFICATION_STATUSES,
  TICKET_STATUSES,
  TODO_STATUSES,
  VALIDATION_DISPOSITIONS,
  VERDICT_SOURCES,
  readRecord,
  recordPath,
  validateRecord,
  writeRecord,
  type AuthorizationScope,
  type ChangeOwner,
  type ChangeOwnership,
  type ConflictEntry,
  type ConflictKind,
  type ConflictStatus,
  type ConflictsRecord,
  type ConsequentialArea,
  type CriterionJudgment,
  type CriterionTestability,
  type CriterionVerdict,
  type DecisionStatus,
  type DiscrepancySource,
  type FallbackScope,
  type FallbackStatus,
  type JevRecord,
  type LessonAdvice,
  type LessonCheck,
  type LessonCheckOutcome,
  type LessonDecider,
  type LessonDecision,
  type LessonEvidence,
  type LessonOutcome,
  type LessonRecord,
  type LessonRetention,
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
  type RejectedRecommendation,
  type ResumeDiscrepancy,
  type ResumeLessons,
  type ResumeOutcome,
  type ResumeRecord,
  type SpecificationDecision,
  type SpecificationRecord,
  type SpecificationStatus,
  type TicketRecord,
  type TicketStatus,
  type TicketValidation,
  type TicketsRecord,
  type TodoItem,
  type TodoStatus,
  type TodosRecord,
  type ValidationDisposition,
  type VerdictSource,
} from "./project/records.js";

export {
  EVIDENCE_KINDS,
  overrideCriterion,
  validateTicket,
  type CriterionOverride,
  type EvidenceKind,
  type ValidationInput,
  type TicketValidationResult,
  type VerificationEvidence,
} from "./jev/ticket-validation.js";

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
  REQUEST_FRAME,
  askJev,
  fetchTransport,
  jevRequestBody,
  loadDecisionQuestion,
  type DecisionQuestion,
  type JevCallResult,
  type JevCallSummary,
  type JevClientOptions,
  type JevFailure,
  type JevTransport,
  type RequestFrame,
  type TransportRequest,
} from "./jev/client.js";

export { TRACE_DIRECTORY, cleanTraces, listTraces } from "./jev/traces.js";

export {
  ENVELOPE_DIRECTORY,
  adviseNext,
  askDecision,
  askDecisionRejectingUnlisted,
  assignmentEvidence,
  lessonRetentionEvidence,
  listEnvelopes,
  nextActionEvidence,
  permittedChoices,
  readEnvelope,
  rebuildJevRequest,
  recordChoice,
  reportDecision,
  routeAnswer,
  type AskDecisionResult,
  type ChoiceInput,
  type ChoiceMaker,
  type ChoiceResult,
  type DecisionChoice,
  type DecisionDependencies,
  type DecisionEnvelope,
  type DecisionInput,
  type DecisionReport,
  type DecisionRoute,
  type NextAdvice,
  type ProposedAssignment,
  type UnlistedAnswer,
} from "./jev/decisions.js";

export {
  askEscalation,
  BOUNDARY_KINDS,
  escalationOf,
  HARD_RULES,
  type Boundary,
  type BoundaryKind,
  type EscalationAsk,
  type EscalationResult,
  type HardRule,
} from "./jev/escalation.js";

export {
  replayDecision,
  type ReplayChange,
  type ReplayDirection,
  type ReplayProposal,
  type ReplayReport,
  type ReplayResult,
  type ReplayTally,
  splitKindsOf,
} from "./jev/replay.js";

export { kindOfPacket } from "./jev/kinds.js";

export {
  findPatterns,
  OBSERVATION_KINDS,
  readObservations,
  RECURRENCE_MINIMUM,
  type HarnessObservation,
  type ObservationKind,
  type ObservationPattern,
  type ObservationView,
  type SuggestedChange,
} from "./jev/observations.js";

export {
  acceptProposal,
  draftProposal,
  listProposals,
  PROPOSAL_DIRECTORY,
  readProposal,
  rejectProposal,
  replayProposal,
  type Proposal,
  type ProposalDependencies,
  type ProposalDraft,
  type ProposalOutcome,
  type ProposalResult,
  type ProposedChange,
  type RecordedChange,
} from "./jev/proposals.js";

export {
  decideConflict,
  raiseConflict,
  type ConflictDraft,
  type ConflictResult,
} from "./actions/conflicts.js";
