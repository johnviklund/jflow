import { readProjectState } from "../project/state.js";
import { resolveRequest } from "./request.js";
import { resolveAction, type ActionResolution, type ResolutionContext } from "./resolve.js";
import { runStatus, type StatusReport } from "./status.js";

/**
 * The helper's single entry for running an action (issue #4, D51): a request
 * in, resolved to exactly one action contract, checked against the project
 * records, and executed when an executor exists. Every point where the
 * human must be asked is reported as an event, never decided here.
 */

/** An event where the workflow stopped to ask the human (SPEC.md D28, D40). */
export interface HumanAskEvent {
  readonly kind: "human-ask";
  /** The action concerned; absent when the question is which action was meant. */
  readonly action?: string;
  readonly reasons: readonly string[];
}

export type DispatchOutcome =
  | {
      /** The request fits more than one action; ask, never guess. */
      readonly kind: "clarify";
      readonly candidates: readonly string[];
      readonly question: string;
    }
  | { readonly kind: "unknown-action"; readonly message: string }
  | {
      /** The progress record is unreadable, so nothing but `status` may run. */
      readonly kind: "malformed-record";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: "blocked";
      readonly action: string;
      readonly resolution: Extract<ActionResolution, { status: "blocked" }>;
    }
  | { readonly kind: "completed"; readonly action: "status"; readonly report: StatusReport }
  | {
      /** Eligible, but no executor exists yet for this action. */
      readonly kind: "not-implemented";
      readonly action: string;
      readonly resolution: Extract<ActionResolution, { status: "eligible" }>;
    };

export interface DispatchOptions {
  /** Called for every human-ask raised while dispatching, in order. */
  readonly onHumanAsk?: (event: HumanAskEvent) => void;
}

/**
 * Resolves a named or conversational request and runs it against the
 * project at `root`. Reads project files; writes nothing itself (executors
 * own their writes).
 */
export function dispatch(
  root: string,
  request: string,
  context: ResolutionContext,
  options: DispatchOptions = {},
): DispatchOutcome {
  const ask = options.onHumanAsk ?? (() => undefined);

  const resolved = resolveRequest(request, context.workflowPackage);
  if (resolved.kind === "unknown") {
    return { kind: "unknown-action", message: resolved.message };
  }
  if (resolved.kind === "ambiguous") {
    ask({ kind: "human-ask", reasons: [resolved.question] });
    return { kind: "clarify", candidates: resolved.candidates, question: resolved.question };
  }
  const action = resolved.action;

  // `status` is the one action that may run against an unreadable record,
  // because reporting the problem is its job.
  if (action === "status") {
    return { kind: "completed", action, report: runStatus(root, context) };
  }

  const read = readProjectState(root);
  if (read.kind === "malformed") {
    return { kind: "malformed-record", path: read.path, message: read.message };
  }

  const resolution = resolveAction({ action }, read.state, context);
  if (resolution.status === "unknown-action") {
    return { kind: "unknown-action", message: resolution.message };
  }
  if (resolution.status === "blocked") {
    if (resolution.requiresHumanAsk) {
      ask({
        kind: "human-ask",
        action,
        reasons: resolution.unmet.filter((u) => u.needsHuman).map((u) => u.reason),
      });
    }
    return { kind: "blocked", action, resolution };
  }
  return { kind: "not-implemented", action, resolution };
}
