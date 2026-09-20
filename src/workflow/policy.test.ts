import { describe, expect, it } from "vitest";

import { loadShippedWorkflowPackage } from "./package.js";
import { confidenceThreshold, routeByConfidence } from "./policy.js";

const pkg = loadShippedWorkflowPackage();

/**
 * No test here asserts a threshold's value (SPEC.md D37): a passing suite must
 * never read as evidence that a number is right. Each case reads the shipped
 * threshold and probes just above and just below it.
 */
describe("routeByConfidence", () => {
  const EPSILON = 1e-6;

  it.each(Object.keys(pkg.decisions))(
    "honours a %s answer whose confidence meets the threshold",
    (decision) => {
      const threshold = confidenceThreshold(pkg, decision);

      expect(routeByConfidence(pkg, decision, threshold)).toBe("honour");
      expect(routeByConfidence(pkg, decision, threshold + EPSILON)).toBe("honour");
    },
  );

  it.each(Object.keys(pkg.decisions))(
    "routes a %s answer below the threshold to the human",
    (decision) => {
      const threshold = confidenceThreshold(pkg, decision);

      expect(routeByConfidence(pkg, decision, threshold - EPSILON)).toBe("ask-human");
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "routes a non-finite confidence (%s) to the human",
    (confidence) => {
      expect(routeByConfidence(pkg, "escalate", confidence)).toBe("ask-human");
    },
  );

  it("refuses a decision the package does not declare", () => {
    expect(() => confidenceThreshold(pkg, "guess")).toThrow(/guess/);
    expect(() => routeByConfidence(pkg, "guess", 1)).toThrow(/guess/);
  });

  it("refuses a decision whose policy declares no confidence threshold", () => {
    const withoutThreshold = {
      ...pkg,
      policy: {
        ...pkg.policy,
        escalate: { thresholds: {}, weights: {}, basis: "Fixture." },
      },
    };

    expect(() => confidenceThreshold(withoutThreshold, "escalate")).toThrow(/confidence/);
  });
});
