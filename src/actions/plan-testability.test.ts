import { afterEach, describe, expect, it } from "vitest";

import type { JevTransport, TransportRequest } from "../jev/client.js";
import { readEnvelope, type DecisionDependencies } from "../jev/decisions.js";
import { readRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { writeClassifiedPlan, type PlanDraft } from "./plan.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-26T10:00:00.000Z";
const threshold = confidenceThreshold(pkg, "classify");
const above = threshold + (1 - threshold) / 2;
const below = threshold / 2;

type Answer = readonly [choice: string, reason: string, confidence: number];

/** A Jev classing each criterion by a phrase it contains; the first matching rule wins. */
function jev(rules: readonly (readonly [needle: string, answer: Answer])[]): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const answer = rules.find(([needle]) => request.body.includes(needle))?.[1];
    if (answer === undefined) return { status: 500, body: "no scripted answer" };
    const [choice, reason, confidence] = answer;
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          classify: { type: "choice", choice, confidence },
          "classify.reason": { type: "choice", choice: reason, confidence },
        },
      }),
    };
  };
  return Object.assign(transport, { sent });
}

function project(): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true } });
  harnesses.push(h);
  return h;
}

function dependencies(h: ProjectHarness, transport: JevTransport): DecisionDependencies {
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async () => undefined,
  };
}

const draft: PlanDraft = {
  title: "CSV export",
  summary: "Export the current list as CSV.",
  tickets: [
    { id: "T1", title: "Serialise rows", acceptanceCriteria: ["a row round-trips through parse and serialise"], dependsOn: [] },
    { id: "T2", title: "Download button", acceptanceCriteria: ["clicking downloads a file", "the button feels right"], dependsOn: ["T1"] },
  ],
};

const testable: Answer = ["testable", "clear-match", above];
const untestable: Answer = ["untestable", "clear-match", above];

describe("plan write classifies every drafted criterion's testability", () => {
  it("asks classify once per criterion with content kind testability, and records each classification on its ticket", async () => {
    const h = project();
    const transport = jev([["", testable]]);

    const result = await writeClassifiedPlan(h.root, draft, dependencies(h, transport));

    expect(transport.sent).toHaveLength(3);
    expect(transport.sent.every((request) => request.body.includes("Content: testability."))).toBe(true);
    expect(transport.sent[2]!.body).toContain("the button feels right");
    expect(result).toMatchObject({ ok: true });
    const tickets = readRecord(h.root, "tickets");
    expect(tickets.kind === "present" && tickets.record.tickets[1]!.testability).toEqual([
      { criterion: "clicking downloads a file", answer: "testable", envelope: expect.stringMatching(/^ENV-/), route: "weigh" },
      { criterion: "the button feels right", answer: "testable", envelope: expect.stringMatching(/^ENV-/), route: "weigh" },
    ]);
  });

  it("refuses to write the breakdown while a criterion is confidently untestable, naming it to be rewritten", async () => {
    const h = project();

    const result = await writeClassifiedPlan(h.root, draft, dependencies(h, jev([["feels right", untestable], ["", testable]])));

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("rewrite"),
      untestable: [{ ticketId: "T2", criterion: 1, text: "the button feels right", envelope: expect.stringMatching(/^ENV-/) }],
    });
    expect(readRecord(h.root, "tickets").kind).toBe("absent");
    expect(readRecord(h.root, "plan").kind).toBe("absent");
  });

  it("writes the rewritten breakdown once no criterion is untestable", async () => {
    const h = project();
    const rewritten: PlanDraft = {
      ...draft,
      tickets: [draft.tickets[0]!, { ...draft.tickets[1]!, acceptanceCriteria: ["clicking downloads a file", "the button is visible without scrolling at 1280x720"] }],
    };

    const result = await writeClassifiedPlan(h.root, rewritten, dependencies(h, jev([["feels right", untestable], ["", testable]])));

    expect(result).toMatchObject({ ok: true });
  });

  it("sets an untestable answer aside only with a reason and evidence, recorded on the envelope and the ticket", async () => {
    const h = project();
    const answers = jev([["feels right", untestable], ["", testable]]);
    const reason = { ticketId: "T2", criterion: 1, reason: "the design review signs it off with a checklist" };

    const bare = await writeClassifiedPlan(h.root, { ...draft, testabilityOverrides: [reason] }, dependencies(h, answers));
    const evidenced = await writeClassifiedPlan(
      h.root,
      { ...draft, testabilityOverrides: [{ ...reason, evidence: ["docs/design-checklist.md"] }] },
      dependencies(h, answers),
    );

    expect(bare).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
    expect(evidenced).toMatchObject({ ok: true });
    const tickets = readRecord(h.root, "tickets");
    const entry = tickets.kind === "present" ? tickets.record.tickets[1]!.testability![1]! : undefined;
    expect(entry).toMatchObject({ answer: "untestable", setAside: { reason: reason.reason, evidence: ["docs/design-checklist.md"] } });
    const read = readEnvelope(h.root, entry!.envelope!);
    expect(read.ok && read.envelope.choice).toMatchObject({ action: "testable", by: "agent", followsAnswer: false });
  });

  it("refuses a set-aside that answers no untestable criterion, and records no choice for any", async () => {
    const h = project();
    const answers = jev([["feels right", untestable], ["", testable]]);
    const good = { ticketId: "T2", criterion: 1, reason: "checklist", evidence: ["docs/design-checklist.md"] };

    const result = await writeClassifiedPlan(
      h.root,
      { ...draft, testabilityOverrides: [good, { ticketId: "T1", criterion: 0, reason: "r", evidence: ["e"] }] },
      dependencies(h, answers),
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("did not class untestable") });
    expect(readRecord(h.root, "tickets").kind).toBe("absent");
  });

  it("records an answer that is not relied on, or no answer, without blocking; the developer sees it at acceptance", async () => {
    const h = project();

    const result = await writeClassifiedPlan(h.root, draft, dependencies(h, jev([["feels right", ["untestable", "ambiguous", below]]])));

    expect(result).toMatchObject({ ok: true });
    const tickets = readRecord(h.root, "tickets");
    if (tickets.kind !== "present") throw new Error("no tickets");
    expect(tickets.record.tickets[1]!.testability![1]).toMatchObject({ answer: "untestable", route: "ask-human" });
    expect(tickets.record.tickets[0]!.testability![0]).toMatchObject({ unavailable: expect.any(String) });
  });

  it("asks nothing when the plan would be refused anyway", async () => {
    const h = createProjectHarness();
    harnesses.push(h);
    const transport = jev([["", testable]]);

    expect(await writeClassifiedPlan(h.root, draft, dependencies(h, transport))).toMatchObject({ ok: false, reason: expect.stringContaining("specification") });
    expect(transport.sent).toHaveLength(0);
  });
});
