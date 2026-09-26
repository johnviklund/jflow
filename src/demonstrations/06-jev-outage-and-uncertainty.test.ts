import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, startAuthorizedTicket, demoProject, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 6 (RELEASE-SCOPE.md, D16, D17, D6): a Jev outage requires
 * the developer's approval to continue without it; conflicting
 * recommendations and uncertain answers produce inspectable decisions.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 6: Jev outage, conflicting and uncertain answers", () => {
  it("waits for the developer's approval in an outage, records the agent's assessment, and keeps every answer inspectable", async () => {
    const demo = demoProject();
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1")]);
    await startAuthorizedTicket(demo, "T1");
    const input = demo.draft("input.json", { taskSummary: "T1 is in progress: what next?", candidates: [], excerpts: [{ source: "status", text: "T1 in progress" }] });

    // Jev is down: retried, then the developer is asked before anything goes on without it.
    demo.jev.down(503);
    const failed = await demo.run("decide", "ask", "next-action", input);
    expect(failed.code).toBe(1);
    expect(failed.json).toMatchObject({ decision: { kind: "failed", fallback: "awaiting-approval" } });
    // A temporary failure is retried before the developer is needed (exit 1); nothing is skipped.
    expect(demo.jev.callsTo("next-action").length).toBeGreaterThan(1);
    expect((await demo.run("status")).json).toMatchObject({ outcome: { report: { jev: { fallback: { status: "awaiting-approval" } } } } });
    const assessment = demo.draft("assessment.json", {
      decision: "next-action",
      traceReference: failed.json.decision.failure.traceReference,
      assessment: "T1 has no evidence recorded yet, so implement continues",
      evidence: ["jflow status: T1 in progress, not validated"],
      resolution: "implement",
      consequential: false,
    });
    const unapproved = await demo.run("jev", "assess", assessment);
    expect(unapproved.code).toBe(1);

    await demo.run("jev", "approve", "--scope", "ticket", "--note", "go on without Jev for T1");
    const assessed = await demo.run("jev", "assess", assessment);
    expect(assessed.json).toMatchObject({ ok: true, outcome: { assessment: { decision: "next-action", resolution: "implement" } } });

    // Jev is back. An unsure answer is recorded but not relied on: the developer decides.
    demo.jev.restore();
    demo.jev.answer("next-action", "review", "prerequisites-met", "unsure");
    const unsure = await demo.run("decide", "ask", "next-action", input);
    expect(unsure.json).toMatchObject({ decision: { route: "ask-human" } });
    // An answer again: the recovery is recorded and the fallback ends.
    expect((await demo.run("status")).json).toMatchObject({ outcome: { report: { jev: { fallback: { status: "off" } } } } });
    const shown = await demo.run("decide", "show", unsure.json.decision.envelope);
    expect(shown.json).toMatchObject({
      ok: true,
      envelope: { decision: "next-action", request: { question: { version: expect.any(Number) }, packet: { taskSummary: expect.stringContaining("T1") } }, answer: { choice: "review" }, route: "ask-human" },
    });

    // A confident recommendation that conflicts with the records' own: the agent sets it aside with a recorded reason.
    demo.jev.answer("next-action", "wrap", "work-complete");
    const next = await demo.run("next");
    const recorded = next.json.outcome.report.recommendation.action as string;
    expect(next.json.jev).toMatchObject({ answer: "wrap", route: "weigh" });
    expect(recorded).not.toBe("wrap");
    const bare = await demo.run("decide", "choose", next.json.jev.envelope, "--action", recorded, "--by", "agent");
    expect(bare.code).toBe(1);
    const chosen = await demo.run("decide", "choose", next.json.jev.envelope, "--action", recorded, "--by", "agent", "--reason", "T1 has not been validated, so it is not complete", "--evidence", "jflow status");
    expect(chosen.json).toMatchObject({ ok: true, envelope: { choice: { action: recorded, followsAnswer: false, by: "agent" } } });
  });
});
