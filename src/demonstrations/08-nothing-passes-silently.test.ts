import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, startAuthorizedTicket, DEMO_KEY, demoProject, evidence, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 8 (RELEASE-SCOPE.md, D14, D22, D23, D31): invalid
 * configuration, excluded evidence and missing review evidence cannot
 * silently pass; raw traces stay outside version control.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 8: nothing passes silently", () => {
  it("rejects invalid configuration, including one that would disable the independent reviewer", async () => {
    const demo = demoProject();
    demos.push(demo);

    const unknown = await demo.run("validate", "--config", demo.draft("unknown.json", { stageModels: { implement: { model: "" } }, colour: "blue" }));
    const weakened = await demo.run("validate", "--config", demo.draft("weakened.json", { settings: { "review.requireIndependentReviewer": false } }));
    const credential = await demo.run("validate", "--config", demo.draft("secret.json", { settings: {}, apiKey: DEMO_KEY }));

    for (const result of [unknown, weakened, credential]) {
      expect(result.code).not.toBe(0);
      expect(JSON.stringify(result.json)).not.toContain(DEMO_KEY);
    }
    const paths = (result: { json: { configuration?: { path: string }[] } }) => (result.json.configuration ?? []).map((issue) => issue.path);
    expect(paths(unknown)).toEqual(expect.arrayContaining(["colour", "stageModels.implement.model"]));
    expect(paths(weakened)).toEqual(["settings.review.requireIndependentReviewer"]);
    expect(paths(credential)).toEqual(["apiKey"]);

    // Every action refuses to run under it, not only validate.
    const refused = await demo.run("status", "--config", demo.draft("weakened-again.json", { settings: { "review.requireIndependentReviewer": false } }));
    expect(refused.code).not.toBe(0);
  });

  it("refuses a diff as evidence, keeps the Jev key out of traces and envelopes, and refuses completion without review", async () => {
    const demo = demoProject();
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1")]);
    await startAuthorizedTicket(demo, "T1");
    demo.edit("src/t1.ts", "export const t1 = true;\n");

    const diff = await demo.run("ticket", "validate", demo.draft("diff.json", { ...evidence("T1"), checks: ["git diff"] }));
    expect(diff.code).toBe(1);
    expect(demo.jev.callsTo("validate")).toHaveLength(0);

    demo.jev.answer("next-action", "implement", "work-in-progress");
    await demo.run("decide", "ask", "next-action", demo.draft("leaky.json", { taskSummary: "what next", candidates: [], excerpts: [{ source: "env", text: `JFLOW_JEV_API_KEY=${DEMO_KEY}` }] }));
    const local = Object.entries(demo.snapshot()).filter(([path]) => path.startsWith(".jflow/") || path.startsWith("jflow/"));
    expect(local.length).toBeGreaterThan(0);
    expect(local.filter(([, content]) => content.includes(DEMO_KEY)).map(([path]) => path)).toEqual([]);

    // Without a review, and with only the implementer's word, the ticket is not complete.
    demo.jev.answer("validate", "met", "evidence-satisfies");
    await demo.run("implement", "check", demo.draft("evidence.json", evidence("T1")));
    expect((await demo.run("implement", "complete")).code).toBe(1);
    await demo.run("review", "start");
    const selfReview = await demo.run("review", "record", demo.draft("self.json", { ticketId: "T1", reviewer: { agent: "primary" }, findings: [] }));
    // A dispute claimed settled by evidence that records none is refused.
    const unevidenced = await demo.run("review", "record", demo.draft("unevidenced.json", {
      ticketId: "T1",
      reviewer: { agent: "reviewer-1" },
      findings: [{ kind: "correctness", summary: "empty input throws", evidence: ["src/t1.ts:1"], dispute: { reason: "it does not", conclusive: true } }],
    }));
    expect(selfReview.code).toBe(1);
    expect(unevidenced.code).toBe(1);
    expect(demo.record("tickets").tickets[0]).toMatchObject({ status: "in-progress" });
  });

  it("keeps raw traces and envelopes out of version control", async () => {
    const demo = demoProject();
    demos.push(demo);
    demo.jev.answer("escalate", "proceed", "routine");
    await demo.run("escalate", demo.draft("boundary.json", { kind: "other", summary: "a boundary", excerpts: [] }));

    const traces = await demo.run("traces", "list");
    expect(traces.json.traces.length).toBeGreaterThan(0);
    expect(demo.git("status", "--porcelain")).not.toContain(".jflow");
    for (const path of [traces.json.traces[0], ".jflow/envelopes"]) {
      expect(demo.git("check-ignore", path)).toBe(path);
    }
  });
});
