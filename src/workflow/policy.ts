/**
 * Routing over declared policy thresholds (SPEC.md D37, D45). The numbers
 * themselves are opaque placeholders until a recorded corpus calibrates them;
 * this module only answers "above or below", never "correct".
 */

import type { WorkflowPackage } from "./types.js";

/** Key of the threshold every declared decision carries: minimum confidence to act on an answer. */
const CONFIDENCE_THRESHOLD_KEY = "confidence";

/**
 * `honour`: the answer's confidence meets the declared threshold and the
 * workflow may act on it with the decision's declared authority.
 * `ask-human`: below the threshold (or unparseable), so the answer routes to
 * the human regardless of authority.
 */
export type ConfidenceRoute = "honour" | "ask-human";

/**
 * Reads a declared decision's confidence threshold.
 *
 * @throws {Error} when the decision or its threshold is not declared; a
 *   missing threshold must not silently become permissive.
 */
export function confidenceThreshold(pkg: WorkflowPackage, decision: string): number {
  const entry = pkg.policy[decision];
  if (!entry) {
    throw new Error(`no policy is declared for decision "${decision}"`);
  }
  const threshold = entry.thresholds[CONFIDENCE_THRESHOLD_KEY];
  if (threshold === undefined) {
    throw new Error(
      `policy for decision "${decision}" declares no "${CONFIDENCE_THRESHOLD_KEY}" threshold`,
    );
  }
  return threshold;
}

/** Routes an answer by its confidence: at or above the threshold is honoured, below asks the human. */
export function routeByConfidence(
  pkg: WorkflowPackage,
  decision: string,
  confidence: number,
): ConfidenceRoute {
  const threshold = confidenceThreshold(pkg, decision);
  return Number.isFinite(confidence) && confidence >= threshold ? "honour" : "ask-human";
}
