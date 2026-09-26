import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, completeTicket, demoProject, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 3 (RELEASE-SCOPE.md, D29, D30): a blocked ticket is parked
 * and genuinely independent work proceeds, without losing the blocker or
 * widening the authorization.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 3: parking a blocked ticket", () => {
  it("parks the ticket with its blocker and partial edits, and starts only independent work after a recorded check", async () => {
    const demo = demoProject();
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1"), ticketDraft("T2"), ticketDraft("T3", ["T1"])]);
    await demo.run("plan", "authorize", "--scope", "plan", "--note", "implement the whole plan");
    demo.jev.answer("escalate", "proceed", "routine");
    await demo.run("implement", "next");
    demo.edit("src/t1.ts", "// half done: waiting on the date format\n");

    const parked = await demo.run("implement", "park", "T1", "--blocker", "the developer has not chosen the date format");
    expect(parked.json).toMatchObject({ ok: true, outcome: { ticket: { status: "parked" }, partialEdits: ["src/t1.ts"] } });

    // Nothing starts beside a parked ticket until independence is recorded; T3 depends on T1 and is never a candidate.
    const unchecked = await demo.run("implement", "next");
    expect(unchecked.json).toMatchObject({ kind: "needs-independence-check", candidates: ["T2"] });
    await demo.run(
      "implement",
      "independence",
      demo.draft("independence.json", {
        ticketId: "T2",
        dependencies: "T2 depends on nothing; T1 is not among its dependencies",
        decisions: "T1 waits on the date format, which T2 never touches",
        partialEdits: "T1's partial edit is src/t1.ts; T2 changes only src/t2.ts",
      }),
    );
    demo.jev.answer("escalate", "proceed", "routine");
    const next = await demo.run("implement", "next");
    expect(next.json).toMatchObject({ kind: "started", ticket: { id: "T2" } });
    await completeTicket(demo, "T2");

    // T2's commit leaves T1's partial edit alone; the blocker and the authorization are as they were.
    expect(demo.git("show", "--name-only", "--format=", "HEAD")).not.toContain("src/t1.ts");
    expect(demo.git("status", "--porcelain")).toContain("src/t1.ts");
    const tickets = Object.fromEntries(demo.record("tickets").tickets.map((ticket) => [ticket.id, ticket]));
    expect(tickets["T1"]).toMatchObject({ status: "parked", parkedReason: "the developer has not chosen the date format" });
    expect(tickets["T3"]).toMatchObject({ status: "ready" });
    expect(demo.record("progress")).toMatchObject({ executionAuthorized: true, authorizationScope: "plan", authorizationNote: "implement the whole plan" });

    // With T1 parked and T3 behind it, nothing can safely proceed: jflow says why and starts nothing.
    const waiting = await demo.run("implement", "next");
    expect(waiting.json).toMatchObject({ kind: "waiting" });
    expect(demo.jev.unscripted).toEqual([]);
  });
});
