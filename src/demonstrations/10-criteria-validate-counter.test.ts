import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, startAuthorizedTicket, demoProject, evidence, SPECIFICATION_DRAFT, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 10 (RELEASE-SCOPE.md, D41, D47, D48): plan rejects a ticket
 * without acceptance criteria; validate returns a not-met ticket to fix and
 * admits an all-met one to review; the one per-ticket counter escalates at
 * the limit whichever gate caught the failure.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

async function started(): Promise<Demo> {
  const demo = demoProject();
  demos.push(demo);
  await acceptedPlan(demo, [ticketDraft("T1")]);
  await startAuthorizedTicket(demo, "T1");
  demo.edit("src/t1.ts", "export const t1 = 1;\n");
  return demo;
}

describe("demonstration 10: criteria, validate and one fix counter", () => {
  it("refuses a ticket without acceptance criteria", async () => {
    const demo = demoProject();
    demos.push(demo);
    demo.jev.always("classify", "testable", "clear-match");
    await demo.run("specification", "write", demo.draft("spec.json", SPECIFICATION_DRAFT));
    await demo.run("specification", "confirm", "D1", "--basis", "yes");
    await demo.run("specification", "accept", "--note", "accepted");

    const refused = await demo.run("plan", "write", demo.draft("plan.json", { title: "p", summary: "s", tickets: [{ ...ticketDraft("T1"), acceptanceCriteria: [] }] }));

    expect(refused.code).toBe(1);
    expect(demo.maybe("plan")).toBeUndefined();
    expect(demo.maybe("tickets")).toBeUndefined();
  });

  it("returns a not-met ticket to fix, admits an all-met one to review, and never lets review start before", async () => {
    const demo = await started();

    demo.jev.answer("validate", "not-met", "evidence-contradicts");
    const notMet = await demo.run("implement", "check", demo.draft("failing.json", evidence("T1", false)));
    const early = await demo.run("review", "start");
    demo.jev.answer("validate", "met", "evidence-satisfies");
    const met = await demo.run("implement", "check", demo.draft("passing.json", evidence("T1")));

    expect(notMet.json).toMatchObject({ validation: { disposition: "returned-to-fix" } });
    expect(early.code).toBe(1);
    expect(met.json).toMatchObject({ validation: { disposition: "admitted-to-review" } });
    expect((await demo.run("review", "start")).code).toBe(0);
  });

  it("escalates at the limit when validate caught every failure", async () => {
    const demo = await started();

    // The implementation's failure, then two unsuccessful fix attempts.
    for (const attempt of [0, 1, 2]) {
      demo.jev.answer("validate", "not-met", "evidence-contradicts");
      if (attempt === 2) demo.jev.answer("escalate", "escalate", "uncertain");
      const draft = attempt === 2 ? { ...evidence("T1", false), recommendation: "rewrite the parser loop" } : evidence("T1", false);
      await demo.run("implement", "check", demo.draft(`failing-${attempt}.json`, draft));
    }

    expect(demo.record("progress").fixAttempts).toEqual({ T1: 2 });
    expect(demo.jev.callsTo("escalate")).toHaveLength(1);
    expect(demo.asks.at(-1)?.ask).toMatchObject({ boundary: "fix-failed" });
  });

  it("escalates at the limit when validate caught one failure and review the other", async () => {
    const demo = await started();
    for (const attempt of [0, 1]) {
      demo.jev.answer("validate", "not-met", "evidence-contradicts");
      await demo.run("implement", "check", demo.draft(`failing-${attempt}.json`, evidence("T1", false)));
    }
    expect(demo.record("progress").fixAttempts).toEqual({ T1: 1 });
    demo.jev.answer("validate", "met", "evidence-satisfies");
    // The next failure could reach the limit, so the check carries the agent's recommendation.
    await demo.run("implement", "check", demo.draft("passing.json", { ...evidence("T1"), recommendation: "rewrite the parser loop" }));
    await demo.run("review", "start");

    demo.jev.answer("escalate", "escalate", "uncertain");
    await demo.run(
      "review",
      "record",
      demo.draft("review.json", {
        ticketId: "T1",
        reviewer: { agent: "reviewer-1" },
        findings: [{ kind: "requirement", summary: "line numbers are missing from the report", evidence: ["criterion 2"] }],
        recommendation: "carry the line number through the parser",
      }),
    );

    expect(demo.record("progress").fixAttempts).toEqual({ T1: 2 });
    expect(demo.asks.at(-1)?.ask).toMatchObject({ boundary: "fix-failed" });
  });
});
