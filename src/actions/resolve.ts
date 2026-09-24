import type {
  ResolvedConfiguration,
  StageModelConfiguration,
} from "../config/configuration.js";
import type {
  DelegationLimits,
  WorkflowAction,
  WorkflowCondition,
  WorkflowPackage,
  WorkflowRole,
} from "../workflow/types.js";

/**
 * The observable workflow state an action is resolved against: what the human
 * has accepted and authorized, and what the working tree looks like. This is
 * the seam SPEC.md names — state in, decision out, with no agent prompt text.
 */
export interface WorkflowState {
  /** The human explicitly accepted the specification (SPEC.md D27). */
  readonly specificationAccepted: boolean;
  /** The human explicitly accepted the ticket breakdown (SPEC.md D28). */
  readonly planAccepted: boolean;
  /**
   * The human authorized execution. Distinct from plan acceptance, even when a
   * single instruction satisfies both (SPEC.md user stories 7 and 8).
   */
  readonly executionAuthorized: boolean;
  /** The ticket currently assigned for implementation, if any. */
  readonly assignedTicketId?: string;
  /** The assigned ticket has changes available to assess. */
  readonly ticketChangesPresent: boolean;
  /**
   * The assigned ticket's latest `validate` found every criterion met and it
   * has not been reviewed since; validation is the gate into review (D47,
   * issue #9).
   */
  readonly ticketAdmittedToReview: boolean;
  /** A local Git repository is present and readable (SPEC.md confirmed default 1). */
  readonly gitRepositoryPresent: boolean;
  /** Why a `.git` that is present cannot be read; jflow never repairs one. */
  readonly gitRepositoryUnreadable?: string;
  /**
   * Uncommitted changes whose owner is not recorded (issue #7). Work that
   * would touch them pauses and asks; jflow never absorbs them silently.
   */
  readonly unclaimedChanges: readonly string[];
}

/** State observed from the working tree on every read, never recorded. */
export type ObservedStateField = "gitRepositoryPresent" | "gitRepositoryUnreadable" | "unclaimedChanges";

export function createWorkflowState(
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  const base: WorkflowState = {
    specificationAccepted: false,
    planAccepted: false,
    executionAuthorized: false,
    ticketChangesPresent: false,
    ticketAdmittedToReview: false,
    gitRepositoryPresent: false,
    unclaimedChanges: [],
  };
  return { ...base, ...overrides };
}

export interface ActionRequest {
  readonly action: string;
}

export interface ResolutionContext {
  readonly workflowPackage: WorkflowPackage;
  readonly configuration: ResolvedConfiguration;
}

export interface UnmetPrerequisite {
  readonly condition: WorkflowCondition;
  readonly reason: string;
  /**
   * Whether clearing this prerequisite needs a decision from the human rather
   * than further agent work.
   */
  readonly needsHuman: boolean;
}

export type ActionResolution =
  | {
      readonly status: "eligible";
      readonly action: WorkflowAction;
      readonly requiredRoles: readonly WorkflowRole[];
      readonly delegationLimits: DelegationLimits;
      readonly stageModel?: StageModelConfiguration;
      /** Non-blocking setup gaps the human should be told about up front. */
      readonly setupWarnings: readonly string[];
    }
  | {
      readonly status: "blocked";
      readonly action: WorkflowAction;
      readonly unmet: readonly UnmetPrerequisite[];
      readonly requiresHumanAsk: boolean;
    }
  | { readonly status: "unknown-action"; readonly message: string };

interface ConditionRule {
  readonly satisfied: (state: WorkflowState) => boolean;
  readonly reason: string | ((state: WorkflowState) => string);
  readonly needsHuman: boolean;
}

const CONDITION_RULES: Readonly<Record<WorkflowCondition, ConditionRule>> = {
  "specification.accepted": {
    satisfied: (state) => state.specificationAccepted,
    reason:
      "the specification has not been explicitly accepted; planning cannot start against an unagreed definition",
    needsHuman: true,
  },
  "plan.accepted": {
    satisfied: (state) => state.planAccepted,
    reason: "the ticket breakdown has not been explicitly accepted",
    needsHuman: true,
  },
  "execution.authorized": {
    satisfied: (state) => state.executionAuthorized,
    reason:
      "execution has not been authorized; accepting a plan does not by itself authorize implementing it",
    needsHuman: true,
  },
  "ticket.assigned": {
    satisfied: (state) => typeof state.assignedTicketId === "string",
    reason: "no ticket is assigned; implement works on one ticket at a time",
    needsHuman: false,
  },
  "ticket.changesPresent": {
    satisfied: (state) => state.ticketChangesPresent,
    reason: "the assigned ticket has no changes to assess yet",
    needsHuman: false,
  },
  "ticket.admittedToReview": {
    satisfied: (state) => state.ticketAdmittedToReview,
    reason:
      "the assigned ticket has not passed validate with every criterion met since its last review; validation is the gate into review, so run implement check first",
    needsHuman: false,
  },
  "git.repository": {
    satisfied: (state) => state.gitRepositoryPresent,
    reason: (state) =>
      state.gitRepositoryUnreadable === undefined
        ? "a local Git repository is required for this action; jflow never initializes a repository, discards changes, or absorbs pre-existing uncommitted work on your behalf, so create one yourself (git init) and ask again"
        : `the Git repository here cannot be read (${state.gitRepositoryUnreadable}); jflow never repairs or re-initializes a repository, so fix it and ask again`,
    needsHuman: true,
  },
  "git.changesOwned": {
    satisfied: (state) => state.unclaimedChanges.length === 0,
    reason: (state) =>
      `uncommitted changes with no recorded owner: ${state.unclaimedChanges.join(", ")}; say whether they are yours to keep out of the ticket, the ticket's to adopt, or to be committed or set aside by you first — jflow never absorbs or discards them itself`,
    needsHuman: true,
  },
};

const GLOBAL_DELEGATION_SETTING = "delegation.maxParallelWorkers";

function effectiveDelegationLimits(
  action: WorkflowAction,
  configuration: ResolvedConfiguration,
): DelegationLimits {
  const ceiling = configuration.settings[GLOBAL_DELEGATION_SETTING];
  const bounded =
    typeof ceiling === "number"
      ? Math.min(action.delegationLimits.maxParallelWorkers, ceiling)
      : action.delegationLimits.maxParallelWorkers;

  return {
    maxParallelWorkers: bounded,
    allowParallelWithinUnit: action.delegationLimits.allowParallelWithinUnit && bounded > 1,
  };
}

/**
 * Resolves a requested action against the current workflow state: eligible,
 * blocked with reasons, or unknown. Prerequisite and authorization checks are
 * exact and performed here, never delegated to a judgment score (SPEC.md user
 * story 40).
 */
export function resolveAction(
  request: ActionRequest,
  state: WorkflowState,
  context: ResolutionContext,
): ActionResolution {
  const { workflowPackage, configuration } = context;
  const action = workflowPackage.actions.find((entry) => entry.name === request.action);

  if (!action) {
    const known = workflowPackage.actions.map((entry) => entry.name).join(", ");
    return {
      status: "unknown-action",
      message: `unknown action "${request.action}"; supported actions are ${known}`,
    };
  }

  const unmet: UnmetPrerequisite[] = [];
  if (action.kind === "stage") {
    for (const condition of action.prerequisites) {
      const rule = CONDITION_RULES[condition];
      if (rule.satisfied(state)) continue;
      const reason = typeof rule.reason === "string" ? rule.reason : rule.reason(state);
      unmet.push({ condition, reason, needsHuman: rule.needsHuman });
    }
  }

  if (unmet.length > 0) {
    return {
      status: "blocked",
      action,
      unmet,
      requiresHumanAsk: unmet.some((entry) => entry.needsHuman),
    };
  }

  const stageModel = configuration.stageModels[action.name];
  const setupWarnings: string[] = [];
  if (
    action.kind === "stage" &&
    workflowPackage.configurationSurface.configurableStageModels.includes(action.name) &&
    stageModel === undefined
  ) {
    setupWarnings.push(
      `no worker model is configured for stage "${action.name}"; jflow will ask you which model to use rather than substituting one`,
    );
  }

  return {
    status: "eligible",
    action,
    requiredRoles: action.requiredRoles,
    delegationLimits: effectiveDelegationLimits(action, configuration),
    ...(stageModel === undefined ? {} : { stageModel }),
    setupWarnings,
  };
}
