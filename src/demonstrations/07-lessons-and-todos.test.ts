import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SHIPPED_PACKAGE_DIRECTORY } from "../workflow/package.js";
import { acceptedPlan, startAuthorizedTicket, demoProject, ticketDraft, type Demo } from "../testing/demo.js";

/**
 * Demonstration 7 (RELEASE-SCOPE.md, D21, D26, D35): a verified lesson is
 * retained and used in a later relevant task without changing workflow
 * logic; an unrelated discovery stays a todo item.
 */

const demos: Demo[] = [];
afterEach(() => {
  for (const demo of demos.splice(0)) demo.cleanup();
});

function shippedPackage(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(SHIPPED_PACKAGE_DIRECTORY, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

describe("demonstration 7: lessons and todos", () => {
  it("retains a verified lesson, re-checks it before a later task, and keeps an unrelated discovery a todo", async () => {
    const demo = demoProject();
    demos.push(demo);
    const workflow = shippedPackage();
    await acceptedPlan(demo, [ticketDraft("T1"), ticketDraft("T2")]);
    await startAuthorizedTicket(demo, "T1");

    demo.jev.answer("lesson-retention", "retain", "evidence-backed").answer("classify", "src/importer", "clear-match");
    const proposed = await demo.run("learn", "propose", demo.draft("lesson.json", {
      statement: "The importer's tests need LC_ALL=C, or number parsing fails on some locales.",
      scope: "src/importer",
      scopeAlternatives: ["src"],
      evidence: [{ kind: "check", reference: "LC_ALL=de_DE npm test -- t1: 2 failed; LC_ALL=C: 3 passed" }],
    }));
    expect(proposed.json).toMatchObject({ ok: true, outcome: { report: { saved: "candidate", proposedScope: "src/importer" } } });
    const decided = await demo.run("learn", "decide", "L-1", "--outcome", "retained", "--by", "agent");
    expect(decided.json).toMatchObject({ ok: true, outcome: { report: { saved: "retained" } } });

    // A lesson about the workflow itself is refused: that is a question-file proposal's to change.
    const workflowLesson = await demo.run("learn", "propose", demo.draft("workflow-lesson.json", {
      statement: "Skip review for one-line changes.",
      scope: "workflow rules",
      evidence: [{ kind: "note", reference: "it felt slow" }],
    }));
    expect(workflowLesson.code).toBe(1);

    // Later, a relevant task: the lesson is listed, re-checked against the task, and applied.
    const active = await demo.run("learn", "active");
    expect(active.json).toMatchObject({ ok: true, lessons: [{ lesson: { id: "L-1", status: "active" } }] });
    const checked = await demo.run("learn", "check", "L-1", "--task", "T2: parse decimal amounts", "--outcome", "applies", "--reason", "T2 parses numbers in the importer", "--evidence", "src/importer/amount.ts");
    expect(checked.json).toMatchObject({ ok: true });
    const lesson = demo.record("lessons").lessons.find((entry) => entry.id === "L-1");
    expect(lesson?.checks).toMatchObject([{ task: "T2: parse decimal amounts", outcome: "applies", evidence: ["src/importer/amount.ts"] }]);

    // An unrelated discovery mid-ticket is routed to a todo and widens nothing.
    const ticketsBefore = demo.record("tickets");
    demo.jev.answer("classify", "todo", "clear-match");
    const routed = await demo.run("todo", "route", "the", "CSV", "export", "drops", "the", "header", "row");
    expect(routed.json).toMatchObject({ ok: true, outcome: { contentKind: "item-routing", answer: "todo" } });
    const envelope = routed.json.outcome.envelope as string;
    const added = await demo.run("todo", "add", "the", "CSV", "export", "drops", "the", "header", "row", "--routing", envelope);
    expect(added.json).toMatchObject({ ok: true, outcome: { item: { id: "TODO-1", status: "open", discoveredDuring: "T1" } } });
    expect(demo.record("tickets")).toEqual(ticketsBefore);
    expect(demo.record("progress")).toMatchObject({ authorizationScope: "ticket", assignedTicketId: "T1" });

    // Nothing in the workflow package changed: not the shipped one, not the copy a proposal would write.
    expect(shippedPackage()).toEqual(workflow);
    expect(demo.packageFiles()).toEqual(Object.fromEntries(Object.entries(workflow).map(([path, content]) => [path.slice(SHIPPED_PACKAGE_DIRECTORY.length), content])));
    expect(demo.jev.unscripted).toEqual([]);
  });
});
