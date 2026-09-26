import { afterEach, describe, expect, it } from "vitest";

import { TICKET_TRAILER } from "../project/worktree.js";
import { acceptedPlan, completeTicket, demoProject, SPECIFICATION_DRAFT, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 1 (RELEASE-SCOPE.md): an idea becomes an accepted
 * specification and plan, then authorized implementation of several
 * tickets, each reviewed on its own, and an integrated review of the plan.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 1: idea to integrated review", () => {
  it("gates each step on the developer's recorded words and reviews every ticket and the plan", async () => {
    const demo = demoProject();
    demos.push(demo);
    demo.jev.always("classify", "testable", "clear-match");

    // The specification is a proposal until the developer accepts it; plan waits for it.
    await demo.run("specification", "write", demo.draft("spec.json", SPECIFICATION_DRAFT));
    const unaccepted = await demo.run("specification", "accept", "--note", "yes");
    const early = await demo.run("plan", "write", demo.draft("plan.json", { title: "Importer plan", summary: "Import CSV files.", tickets: [ticketDraft("T1")] }));
    expect(unaccepted.code).toBe(1);
    expect(early.code).toBe(1);
    expect(demo.record("specification").status).toBe("awaiting-acceptance");

    await acceptedPlan(demo, [ticketDraft("T1"), ticketDraft("T2", ["T1"])]);
    expect(demo.record("plan").status).toBe("accepted");
    const classified = demo.jev.callsTo("classify").length;

    // "Looks good" accepted the breakdown; it authorized nothing.
    expect(demo.maybe("progress")?.executionAuthorized ?? false).toBe(false);
    expect((await demo.run("implement", "start", "T1")).code).toBe(1);

    await demo.run("plan", "authorize", "--scope", "plan", "--note", "implement the whole plan");
    for (const ticket of ["T1", "T2"]) {
      demo.jev.answer("escalate", "proceed", "routine");
      const next = await demo.run("implement", "next");
      expect(next.json).toMatchObject({ kind: "started", ticket: { id: ticket } });
      await completeTicket(demo, ticket, `reviewer-${ticket}`);
    }

    const tickets = demo.record("tickets").tickets;
    expect(tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([["T1", "done"], ["T2", "done"]]);
    // Each ticket has its own local commit, named by its trailer.
    const trailers = demo.git("log", `--format=%(trailers:key=${TICKET_TRAILER},valueonly)`).split("\n").filter((line) => line !== "");
    expect(trailers).toEqual(["T2", "T1"]);
    const reviews = demo.record("progress").reviews ?? {};
    expect(reviews["T1"]).toMatchObject({ reviewer: { agent: "reviewer-T1" }, disposition: "passed" });
    expect(reviews["T2"]).toMatchObject({ reviewer: { agent: "reviewer-T2" }, disposition: "passed" });

    // The plan is not complete until it is reviewed as a whole.
    expect((await demo.run("implement", "next")).json).toMatchObject({ kind: "needs-plan-review" });
    const started = await demo.run("review", "plan", "start");
    expect(started.json).toMatchObject({ ok: true, outcome: { tickets: [{ id: "T1" }, { id: "T2" }], planCriteria: SPECIFICATION_DRAFT.acceptanceCriteria } });
    const recorded = await demo.run("review", "plan", "record", demo.draft("plan-review.json", { reviewer: { agent: "plan-reviewer" }, findings: [] }));
    expect(recorded.json).toMatchObject({ ok: true, review: { scope: "integrated", disposition: "passed" } });
    expect(demo.record("progress").planReview).toMatchObject({ scope: "integrated", tickets: ["T1", "T2"] });

    // Under whole-plan authorization and confident proceeds, nothing asked the developer.
    expect(demo.asks).toEqual([]);
    // Review findings never reached classify: it was asked only while the plan was written (D33, D50).
    expect(demo.jev.callsTo("classify")).toHaveLength(classified);
    expect(demo.jev.unscripted).toEqual([]);
  });
});
