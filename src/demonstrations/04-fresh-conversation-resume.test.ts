import { afterEach, describe, expect, it } from "vitest";

import { writeRecord } from "../project/records.js";
import { acceptedPlan, checkEvidence, completeTicket, demoProject, evidence, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 4 (RELEASE-SCOPE.md, D15): a fresh conversation reconciles
 * interrupted work and continues from the files.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 4: resuming in a fresh conversation", () => {
  it("reconciles the records with the files and evidence, verifies an unsupported claim, and continues the ticket where it stopped", async () => {
    const first = demoProject();
    demos.push(first);
    await acceptedPlan(first, [ticketDraft("T1"), ticketDraft("T2"), ticketDraft("T3")]);
    await first.run("plan", "authorize", "--scope", "plan", "--note", "implement the whole plan");
    first.jev.answer("escalate", "proceed", "routine");
    await first.run("implement", "next");
    await completeTicket(first, "T1");
    first.jev.answer("escalate", "proceed", "routine");
    await first.run("implement", "next");
    first.edit("src/t2.ts", "// T2: the parser loop is written, the header is not skipped yet\n");
    await first.run("wrap", first.draft("wrap.json", { summary: "T1 done; T2's parser loop written, header handling next.", nextSteps: ["skip the header row in src/t2.ts"] }));
    // An interrupted session had also recorded T3 done, with no verification behind the claim.
    const tickets = first.record("tickets");
    writeRecord(first.root, "tickets", { tickets: tickets.tickets.map((ticket) => (ticket.id === "T3" ? { ...ticket, status: "done" } : ticket)) });

    // A new conversation: a new session with no memory of the last, on the same project.
    const second = demoProject({ root: first.root });
    demos.push(second);
    const resumed = await second.run("resume");

    expect(resumed.json).toMatchObject({
      ok: true,
      report: {
        resume: { summary: "T1 done; T2's parser loop written, header handling next." },
        authorization: { executionAuthorized: true, scope: "plan", needsDeveloper: false },
        continueWith: { ticketId: "T2", uncommittedChanges: ["src/t2.ts"] },
        unverified: [{ ticketId: "T3" }],
        affected: ["T2", "T3"],
      },
    });

    // The unsupported claim is checked, not trusted: reconcile waits for it.
    expect((await second.run("resume", "reconcile")).code).toBe(1);
    second.jev.answer("validate", "not-met", "evidence-contradicts");
    const verified = await second.run("resume", "verify", second.draft("t3.json", checkEvidence("T3", false)));
    expect(verified.json).toMatchObject({ validation: { disposition: "returned-to-fix" } });
    expect(second.record("tickets").tickets.find((ticket) => ticket.id === "T3")).toMatchObject({ status: "done" });

    // The failed claim is a discrepancy: escalate is asked with its evidence, and the developer is asked.
    // T3 has no commit behind its claim either; each discrepancy is its own escalate question.
    second.jev.answer("escalate", "escalate", "consequential").answer("escalate", "escalate", "consequential");
    const reconciled = await second.run("resume", "reconcile");
    expect(reconciled.code).toBe(1);
    expect(reconciled.json).toMatchObject({
      outcome: {
        discrepancies: [
          { ticketId: "T3", summary: expect.stringContaining("without a commit"), ask: true, escalation: expect.any(String) },
          { ticketId: "T3", summary: expect.stringContaining("returned-to-fix"), ask: true, escalation: expect.any(String) },
        ],
      },
    });
    expect(second.asks.at(-1)?.ask).toMatchObject({ boundary: "resume-discrepancy" });
    expect(second.record("progress").reconciliation?.discrepancies).toMatchObject([{ ticketId: "T3" }, { ticketId: "T3" }]);

    // T2 continues from its edits, not restarted.
    expect(second.snapshot()["src/t2.ts"]).toContain("the parser loop is written");
    expect(second.record("tickets").tickets.find((ticket) => ticket.id === "T2")).toMatchObject({ status: "in-progress" });
    second.edit("src/t2.ts", "export const t2 = (rows: string[]) => rows.slice(1);\n");
    second.jev.answer("validate", "met", "evidence-satisfies");
    const checked = await second.run("implement", "check", second.draft("t2.json", evidence("T2")));
    expect(checked.json).toMatchObject({ validation: { disposition: "admitted-to-review" } });
    expect(second.jev.unscripted).toEqual([]);
  });
});
