import { afterEach, describe, expect, it } from "vitest";

import { demoProject, type Demo } from "../testing/demo.js";

/**
 * Demonstration 14 (RELEASE-SCOPE.md, D49, D50, D33): a model
 * recommendation outside the configured set is rejected; `classify` never
 * receives a review finding.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 14: model selection and classify boundaries", () => {
  it("rejects a recommended model outside the stage's configured options, and starts no worker on it", async () => {
    const demo = demoProject({ config: { stageModels: { implement: { model: "builder", efforts: ["low", "high"] } } } });
    demos.push(demo);
    const draft = demo.draft("selection.json", { stage: "implement", role: "implementer", ticketId: "T1", task: "parse dates" });

    demo.jev.answer("model-selection", "frontier-model @ high", "fits-task");
    const rejected = await demo.run("worker", "recommend", draft);
    demo.jev.answer("model-selection", "builder @ low", "lower-effort-suffices");
    const recommended = await demo.run("worker", "recommend", draft);

    expect(rejected.json).toMatchObject({ ok: true, outcome: { kind: "rejected" } });
    // The rejection is recorded; no worker starts on it.
    expect(demo.record("workers")).toMatchObject({ assignments: [], rejections: [expect.objectContaining({ answer: "frontier-model @ high" })] });
    expect(recommended.json).toMatchObject({ ok: true, outcome: { kind: "recommended", recommendation: { model: "builder", effort: "low" }, options: ["builder @ low", "builder @ high"] } });
    // The options Jev was offered are the configured ones only.
    const body = demo.jev.callsTo("model-selection")[0]!.body;
    expect(body).toContain("builder @ low");
    expect(body).not.toContain("frontier-model");
  });

  it("refuses to classify a review finding and never sends it to Jev", async () => {
    const demo = demoProject();
    demos.push(demo);

    const refused = await demo.run("decide", "ask", "classify", demo.draft("finding.json", { kind: "review-finding", summary: "off by one in the row counter", excerpts: [] }));

    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ ok: false, reason: expect.stringContaining("review finding") });
    expect(demo.jev.calls).toEqual([]);
    expect(Object.keys(demo.snapshot()).filter((path) => path.startsWith(".jflow/envelopes/"))).toEqual([]);
  });
});
