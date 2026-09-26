import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, demoProject, evidence, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 5 (RELEASE-SCOPE.md, D19, D20, D31, D32): configured worker
 * models and a separate reviewer are used and recorded; an unavailable
 * model obeys the explicit fallback policy.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

const CONFIG = {
  stageModels: {
    implement: { model: "builder", fallbackModel: "builder-lite" },
    review: { model: "critic" },
  },
};

describe("demonstration 5: worker models and a separate reviewer", () => {
  it("records workers on their configured model, falls back only as configured, and reviews with a distinct agent on the review model", async () => {
    const demo = demoProject({ config: CONFIG });
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1")]);
    await demo.run("plan", "authorize", "--scope", "ticket", "--ticket", "T1", "--note", "do T1");
    const started = await demo.run("implement", "start");
    expect(started.json).toMatchObject({ outcome: { stageModel: { model: "builder", fallbackModel: "builder-lite" } } });

    const worker = (agent: string, extra: object) =>
      demo.draft(`${agent}.json`, { stage: "implement", role: "implementer", agent, ticketId: "T1", ...extra });
    const configured = await demo.run("worker", "assign", worker("worker-1", { model: "builder" }));
    const unconfigured = await demo.run("worker", "assign", worker("worker-2", { model: "someone-elses-model" }));
    const fallback = await demo.run("worker", "assign", worker("worker-3", { model: "builder-lite", unavailable: { model: "builder", reason: "the host reported builder unavailable" } }));
    const silent = await demo.run("worker", "assign", worker("worker-4", { model: "anything", unavailable: { model: "builder", reason: "unavailable" } }));

    expect(configured.json).toMatchObject({ ok: true, outcome: { assignment: { agent: "worker-1", model: "builder" } } });
    expect(unconfigured.code).toBe(1);
    expect(fallback.json).toMatchObject({ ok: true, outcome: { assignment: { model: "builder-lite", substitution: { unavailableModel: "builder" } } } });
    expect(silent.code).toBe(1);
    expect(demo.record("workers").assignments.map((assignment) => [assignment.agent, assignment.model])).toEqual([
      ["worker-1", "builder"],
      ["worker-3", "builder-lite"],
    ]);
    for (const id of ["W-1", "W-2"]) await demo.run("worker", "finish", id);

    demo.edit("src/t1.ts", "export const t1 = true;\n");
    demo.jev.answer("validate", "met", "evidence-satisfies");
    await demo.run("implement", "check", demo.draft("evidence.json", { ...evidence("T1"), workers: ["worker-1", "worker-3"] }));

    const review = await demo.run("review", "start");
    expect(review.json).toMatchObject({ outcome: { stageModel: { model: "critic" }, implementers: expect.arrayContaining(["primary", "worker-1", "worker-3"]) } });
    const byImplementer = await demo.run("review", "record", demo.draft("self.json", { ticketId: "T1", reviewer: { agent: "worker-1", model: "critic" }, findings: [] }));
    const independent = await demo.run("review", "record", demo.draft("review.json", { ticketId: "T1", reviewer: { agent: "reviewer-1", model: "critic" }, findings: [] }));

    expect(byImplementer.code).toBe(1);
    expect(independent.json).toMatchObject({ ok: true, review: { disposition: "passed" } });
    expect(demo.record("progress").reviews?.["T1"]).toMatchObject({ reviewer: { agent: "reviewer-1", model: "critic" } });
    expect(demo.jev.unscripted).toEqual([]);
  });
});
