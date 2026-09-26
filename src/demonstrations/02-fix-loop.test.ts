import { afterEach, describe, expect, it } from "vitest";

import { acceptedPlan, startAuthorizedTicket, demoProject, evidence, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 2 (RELEASE-SCOPE.md): a failed check invokes diagnosis and
 * a fix; a blocking review finding triggers re-review; two unsuccessful
 * attempts request the developer's input.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 2: diagnosis, fix, re-review and the fix limit", () => {
  it("diagnoses a failed check without editing, fixes it, re-reviews a blocked ticket, and asks at the limit", async () => {
    const demo = demoProject();
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1")]);
    await startAuthorizedTicket(demo, "T1");
    demo.edit("src/t1.ts", "export const t1 = () => { throw new Error('empty'); };\n");

    // The implementation fails its check: validate returns it to fix. It was not a fix attempt, so nothing counts yet.
    demo.jev.answer("validate", "not-met", "evidence-contradicts");
    const failed = await demo.run("implement", "check", demo.draft("failing.json", evidence("T1", false)));
    expect(failed.json).toMatchObject({ validation: { disposition: "returned-to-fix" }, fix: { attempts: 0 } });

    // Troubleshoot diagnoses without editing; the fix goes through the authorized ticket.
    const tree = demo.snapshot();
    const opened = await demo.run("troubleshoot", "start", demo.draft("failure.json", { check: evidence("T1", false).evidence[0] }));
    const diagnosis = opened.json.outcome.diagnosis.id as string;
    await demo.run("troubleshoot", "record", demo.draft("diagnosis.json", { id: diagnosis, finding: "empty input throws", evidence: ["src/t1.ts:1"], recommendation: "return [] for empty input" }));
    const untouched = demo.snapshot();
    expect(Object.keys(untouched).filter((path) => !path.startsWith("jflow/") && !path.startsWith(".jflow/")).map((path) => untouched[path])).toEqual(
      Object.keys(tree).filter((path) => !path.startsWith("jflow/") && !path.startsWith(".jflow/")).map((path) => tree[path]),
    );
    demo.edit("src/t1.ts", "export const t1 = () => [];\n");
    const fixed = await demo.run("implement", "fix", diagnosis, "--note", "returned [] for empty input");
    expect(fixed.json).toMatchObject({ ok: true, outcome: { diagnosis: { status: "applied" } } });

    // The fix passes validate; the reviewer blocks on a finding: the first unsuccessful fix attempt.
    const finding = (summary: string) => ({ kind: "correctness", summary, evidence: ["src/t1.ts:1"] });
    demo.jev.answer("validate", "met", "evidence-satisfies");
    await demo.run("implement", "check", demo.draft("passing.json", evidence("T1")));
    await demo.run("review", "start");
    const firstBlock = await demo.run(
      "review",
      "record",
      demo.draft("review-1.json", { ticketId: "T1", reviewer: { agent: "reviewer-1" }, findings: [finding("a header-only file is reported as invalid")] }),
    );
    expect(firstBlock.json).toMatchObject({ review: { disposition: "returned-to-fix" }, fix: { attempts: 1 } });

    // Fixed and re-reviewed: the reviewer blocks again, the second unsuccessful attempt, the limit.
    demo.edit("src/t1.ts", "export const t1 = (rows: string[]) => (rows.length <= 1 ? [] : rows);\n");
    demo.jev.answer("validate", "met", "evidence-satisfies");
    // A check that could reach the limit carries the agent's recommendation up front.
    const recommended = { ...evidence("T1"), recommendation: "ask the developer how header rows should be treated" };
    await demo.run("implement", "check", demo.draft("passing-1.json", recommended));
    expect((await demo.run("review", "start")).code).toBe(0);
    demo.jev.answer("escalate", "escalate", "consequential");
    const blocked = await demo.run(
      "review",
      "record",
      demo.draft("review.json", {
        ticketId: "T1",
        reviewer: { agent: "reviewer-1" },
        findings: [finding("the header row is imported as data")],
        recommendation: "skip the first row as the header",
      }),
    );
    expect(blocked.code).toBe(1);
    expect(blocked.json).toMatchObject({ review: { disposition: "returned-to-fix" }, fix: { attempts: 2 } });
    expect(demo.asks.at(-1)?.ask).toMatchObject({ boundary: "fix-failed" });
    expect(demo.record("progress").fixAttempts).toEqual({ T1: 2 });

    // The developer's direction given, the fix is validated and re-reviewed before the ticket completes.
    demo.edit("src/t1.ts", "export const t1 = (rows: string[]) => rows.slice(1);\n");
    demo.jev.answer("validate", "met", "evidence-satisfies");
    await demo.run("implement", "check", demo.draft("passing-again.json", recommended));
    expect((await demo.run("review", "start")).code).toBe(0);
    const rereviewed = await demo.run("review", "record", demo.draft("rereview.json", { ticketId: "T1", reviewer: { agent: "reviewer-1" }, findings: [] }));
    expect(rereviewed.json).toMatchObject({ review: { disposition: "passed" } });
    expect((await demo.run("implement", "complete")).json).toMatchObject({ ok: true, outcome: { ticket: { status: "done" } } });
    expect(demo.jev.unscripted).toEqual([]);
  });
});
