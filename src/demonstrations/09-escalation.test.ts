import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, demoProject, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 9 (RELEASE-SCOPE.md, D40, D44): a `proceed` answer within
 * authority asks nothing; `escalate` asks; a hard rule asks without
 * consulting Jev.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 9: when the developer is asked", () => {
  it("proceeds without asking on proceed, asks on escalate, and asks a hard rule without Jev", async () => {
    const demo = demoProject();
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1"), ticketDraft("T2")]);
    await demo.run("plan", "authorize", "--scope", "plan", "--note", "implement the whole plan");
    const boundary = (kind: string) => demo.draft(`${kind}.json`, { kind, summary: `at ${kind}`, excerpts: [{ source: "records", text: "T1 is next" }] });

    demo.jev.answer("escalate", "proceed", "routine");
    const proceeded = await demo.run("implement", "next");
    expect(proceeded.code).toBe(0);
    expect(proceeded.json).toMatchObject({ kind: "started", ticket: { id: "T1" } });
    expect(demo.asks).toEqual([]);

    demo.jev.answer("escalate", "escalate", "consequential");
    const escalated = await demo.run("escalate", boundary("review-dispute"));
    expect(escalated.code).toBe(1);
    expect(escalated.json).toMatchObject({ ask: true, askHuman: { boundary: "review-dispute" } });

    // An unsure proceed is not honoured: below the threshold, the developer decides.
    demo.jev.answer("escalate", "proceed", "routine", "unsure");
    const unsure = await demo.run("escalate", boundary("other"));
    expect(unsure.code).toBe(1);

    const calls = demo.jev.calls.length;
    for (const rule of ["consequential-conflict", "continue-without-jev", "specification-acceptance", "plan-acceptance"]) {
      const asked = await demo.run("escalate", boundary(rule));
      expect(asked.code).toBe(1);
      expect(asked.json).toMatchObject({ kind: "hard-rule", askHuman: { boundary: rule } });
    }
    expect(demo.jev.calls.length).toBe(calls);
    expect(demo.jev.unscripted).toEqual([]);
  });
});
