import { afterEach, describe, expect, it } from "vitest";

import { loadWorkflowPackage, loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold, routeByConfidence } from "../workflow/policy.js";
import { demoProject, type Demo } from "../testing/demo.js";

/**
 * Demonstration 12 (RELEASE-SCOPE.md, D35, D39, D46): a harness-observation
 * pattern yields a question-file proposal with linked evidence and a replay
 * report from stored envelopes; nothing changes until the developer accepts.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 12: a question-file proposal from observations", () => {
  it("turns repeated escalations into a replayed proposal, and changes the policy only on the developer's acceptance", async () => {
    const demo = demoProject();
    demos.push(demo);
    for (const ticket of ["T1", "T2", "T3"]) {
      demo.jev.answer("escalate", "escalate", "uncertain");
      await demo.run("escalate", demo.draft(`${ticket}.json`, { kind: "fix-failed", summary: `${ticket}'s first fix failed with a clear next step`, excerpts: [] }));
    }
    demo.jev.answer("escalate", "escalate", "consequential");
    await demo.run("escalate", demo.draft("next.json", { kind: "next-ticket", summary: "T4 is next", excerpts: [] }));

    // The observations are a view over the stored envelopes, and the pattern links them.
    const observations = await demo.run("proposal", "observations");
    expect(observations.json.observations.filter((observation: { kind: string }) => observation.kind === "escalation")).toHaveLength(4);
    const patterns = await demo.run("proposal", "patterns");
    const [pattern] = patterns.json.patterns;
    expect(pattern).toMatchObject({ kind: "escalation", decision: "escalate", where: "fix-failed", reasonCode: "uncertain", count: 3, suggests: expect.arrayContaining([{ change: "threshold", for: "fix-failed" }]) });

    // A lower threshold for fix-failed alone, relative to the current one: no value is asserted (D37).
    const current = confidenceThreshold(loadShippedWorkflowPackage(), "escalate");
    const lower = current / 2;
    const before = demo.packageFiles();
    const drafted = await demo.run("proposal", "draft", demo.draft("proposal.json", {
      decision: "escalate",
      change: { kind: "threshold", threshold: lower, for: "fix-failed" },
      observations: pattern.observations,
      rationale: "First fix failures with a clear next step escalate every time.",
    }));
    expect(drafted.json).toMatchObject({ ok: true, outcome: { proposal: { id: "P-1", status: "pending", replay: { kind: "fix-failed", envelopes: 3, replayed: 3 } } } });
    expect(drafted.json.outcome.proposal.observations.map((observation: { id: string }) => observation.id)).toEqual(pattern.observations);
    expect(demo.packageFiles()).toEqual(before);

    // Accepted in the developer's words: the policy changes for fix-failed only, and the decision's version moves.
    expect((await demo.run("proposal", "accept", "P-1")).code).toBe(1);
    expect(demo.packageFiles()).toEqual(before);
    const accepted = await demo.run("proposal", "accept", "P-1", "--note", "Lower it for fix-failed; the replay shows only those move.");
    expect(accepted.json).toMatchObject({ ok: true, outcome: { proposal: { status: "accepted", outcome: { by: "developer" } } } });
    const changed = loadWorkflowPackage(demo.packageDirectory);
    const between = (lower + current) / 2;
    expect(routeByConfidence(changed, "escalate", between, "fix-failed")).toBe("honour");
    expect(routeByConfidence(changed, "escalate", between, "next-ticket")).toBe("ask-human");
    expect(changed.decisions["escalate"]!.version).toBe(loadShippedWorkflowPackage().decisions["escalate"]!.version + 1);
    expect(demo.jev.unscripted).toEqual([]);
  });
});
