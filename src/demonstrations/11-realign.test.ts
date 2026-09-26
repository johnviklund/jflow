import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, completeTicket, demoProject, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 11 (RELEASE-SCOPE.md, D42): a mid-implementation realign
 * re-scopes the affected tickets, re-checks completed work, and re-enters
 * acceptance without losing records.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 11: realigning mid-implementation", () => {
  it("re-scopes, re-validates completed work, and puts the plan back behind both gates without losing records", async () => {
    const demo = demoProject();
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1"), ticketDraft("T2"), ticketDraft("T3")]);
    await demo.run("plan", "authorize", "--scope", "plan", "--note", "implement the whole plan");
    demo.jev.answer("escalate", "proceed", "routine");
    await demo.run("implement", "next");
    await completeTicket(demo, "T1");
    demo.jev.answer("escalate", "proceed", "routine");
    await demo.run("implement", "next");
    const commitsBefore = demo.git("log", "--format=%H");

    // The agent recommends; only the developer's instruction realigns.
    await demo.run("realign", "recommend", "--source", "agent", "--summary", "invalid rows should also be exported");
    expect(demo.record("plan").status).toBe("accepted");
    const draft = demo.draft("realign.json", {
      direction: "Export invalid rows to a file as well as reporting them.",
      changes: [
        { action: "rescope", ticketId: "T1", acceptanceCriteria: ["npm test -- t1 passes", "npm test -- t1-export passes"] },
        { action: "withdraw", ticketId: "T3", reason: "replaced by the export ticket" },
        { action: "add", ticketId: "T4", title: "Invalid-row export", acceptanceCriteria: ["npm test -- t4 passes"], dependsOn: ["T1"] },
      ],
      recommendations: ["R-1"],
    });
    expect((await demo.run("realign", draft)).code).toBe(1);

    demo.jev.answer("validate", "met", "evidence-satisfies").answer("validate", "not-met", "evidence-missing");
    const realigned = await demo.run("realign", draft, "--note", "yes: export invalid rows too");
    expect(realigned.code).toBe(0);
    expect(realigned.json).toMatchObject({ outcome: { revalidated: [{ ticketId: "T1", disposition: "returned-to-fix", status: "ready" }], realignment: { priorAuthorization: { scope: "plan" } } } });

    const tickets = Object.fromEntries(demo.record("tickets").tickets.map((ticket) => [ticket.id, ticket]));
    expect(tickets["T1"]).toMatchObject({ status: "ready" });
    expect(tickets["T2"]).toMatchObject({ status: "in-progress", acceptanceCriteria: ["npm test -- t2 passes"] });
    expect(tickets["T3"]).toMatchObject({ status: "withdrawn" });
    expect(tickets["T4"]).toMatchObject({ status: "ready" });
    // Records are kept: T1's commit is still history, and the realign and recommendation are on record.
    expect(demo.git("log", "--format=%H")).toBe(commitsBefore);
    expect(demo.record("realign")).toMatchObject({ recommendations: [{ id: "R-1", status: "addressed" }], realignments: [{ id: "RA-1" }] });

    // Both gates again, and no authorization carried over.
    expect(demo.record("specification").status).toBe("awaiting-acceptance");
    expect(demo.record("plan").status).toBe("awaiting-acceptance");
    expect(demo.record("progress").executionAuthorized).toBe(false);
    expect((await demo.run("implement", "next")).code).toBe(1);
    await demo.run("specification", "accept", "--note", "the export direction is right");
    await demo.run("plan", "accept", "--note", "looks good");
    expect(demo.record("progress").executionAuthorized).toBe(false);
    expect(demo.jev.unscripted).toEqual([]);
  });
});
