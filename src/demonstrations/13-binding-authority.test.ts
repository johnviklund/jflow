import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readShippedQuestionFile, SHIPPED_PACKAGE_DIRECTORY, validateWorkflowPackage } from "../workflow/package.js";
import { acceptedPlan, startAuthorizedTicket, demoProject, evidence, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 13 (RELEASE-SCOPE.md, D43, D6): a binding answer is acted on
 * directly and only a recorded reason gets past it; an undeclared
 * authority fails validation.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

describe("demonstration 13: binding authority", () => {
  it("acts on a binding not-met, and lets only an evidence-based reason past it", async () => {
    const demo = demoProject();
    demos.push(demo);
    await acceptedPlan(demo, [ticketDraft("T1")]);
    await startAuthorizedTicket(demo, "T1");
    demo.edit("src/t1.ts", "export const t1 = true;\n");

    demo.jev.answer("validate", "not-met", "evidence-contradicts");
    const validated = await demo.run("ticket", "validate", demo.draft("evidence.json", evidence("T1")));
    expect(validated.json).toMatchObject({ validation: { disposition: "returned-to-fix", criteria: [{ verdict: "not-met", by: "jev" }] } });
    expect((await demo.run("review", "start")).code).toBe(1);

    const unreasoned = await demo.run("ticket", "override", "T1", "--criterion", "0", "--verdict", "met", "--by", "agent", "--reason", "it passes locally");
    expect(unreasoned.code).toBe(1);
    expect(demo.record("progress").validations?.["T1"]).toMatchObject({ disposition: "returned-to-fix" });

    const reasoned = await demo.run("ticket", "override", "T1", "--criterion", "0", "--verdict", "met", "--by", "agent", "--reason", "the check's output shows 3 passed and exit 0", "--evidence", "npm test -- t1: 3 passed");
    expect(reasoned.json).toMatchObject({ validation: { disposition: "admitted-to-review", criteria: [{ verdict: "met", by: "agent" }] } });
    const envelope = demo.record("progress").validations?.["T1"]?.criteria[0]?.envelope;
    const shown = await demo.run("decide", "show", envelope!);
    expect(shown.json).toMatchObject({ envelope: { authority: "binding", route: "act", choice: { followsAnswer: false, by: "agent", evidence: ["npm test -- t1: 3 passed"] } } });
  });

  it("fails validation of a package whose decision declares no authority, or one outside binding and advisory", () => {
    const shipped = JSON.parse(readFileSync(join(SHIPPED_PACKAGE_DIRECTORY, "jflow.workflow.json"), "utf8")) as { decisions: Record<string, Record<string, unknown>> };
    const { authority: _authority, ...undeclared } = shipped.decisions["validate"]!;

    const missing = validateWorkflowPackage({ ...shipped, decisions: { ...shipped.decisions, validate: undeclared } }, { readQuestionFile: readShippedQuestionFile });
    const unknown = validateWorkflowPackage({ ...shipped, decisions: { ...shipped.decisions, validate: { ...undeclared, authority: "sovereign" } } }, { readQuestionFile: readShippedQuestionFile });

    expect(missing).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "decisions.validate.authority" })] });
    expect(unknown).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "decisions.validate.authority" })] });
  });
});
