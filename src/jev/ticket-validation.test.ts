import { afterEach, describe, expect, it } from "vitest";

import { readRecord, writeRecord, type TicketRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import type { JevTransport, TransportRequest } from "./client.js";
import { listEnvelopes, readEnvelope, type DecisionDependencies } from "./decisions.js";
import { escalationOf } from "./escalation.js";
import { EVIDENCE_KINDS, overrideCriterion, validateTicket, type ValidationInput } from "./ticket-validation.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T10:00:00.000Z";

/** Confidences on either side of a decision's threshold; the value itself is never asserted (D37). */
const above = (decision: string) => {
  const threshold = confidenceThreshold(pkg, decision);
  return threshold + (1 - threshold) / 2;
};
const below = (decision: string) => confidenceThreshold(pkg, decision) / 2;

const PARSES = "parses an empty file to an empty list";
const REPORTS = "reports the line of a syntax error";

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: "T1",
    title: "Parser",
    acceptanceCriteria: [PARSES, REPORTS],
    dependsOn: [],
    status: "in-progress",
    ...overrides,
  };
}

function project(tickets: readonly TicketRecord[] = [ticket()], planAccepted = true): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted } });
  harnesses.push(h);
  writeRecord(h.root, "tickets", { tickets });
  return h;
}

type Answer = readonly [choice: string, reason: string, confidence: number];

/**
 * A Jev that answers `validate` per criterion (matched in the task summary)
 * and `escalate` with a fixed answer.
 */
function jev(
  byCriterion: Readonly<Record<string, Answer>>,
  escalate: Answer = ["escalate", "uncertain", above("escalate")],
): JevTransport & { readonly sent: TransportRequest[]; readonly asked: (decision: string) => number } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const body = JSON.parse(request.body) as { state: { taskSummary: string }; questions: object };
    const decision = Object.keys(body.questions)[0]!;
    const answer =
      decision === "escalate"
        ? escalate
        : Object.entries(byCriterion).find(([criterion]) => body.state.taskSummary.includes(criterion))?.[1];
    if (answer === undefined) return { status: 500, body: "no scripted answer" };
    const [choice, reason, confidence] = answer;
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          [decision]: { type: "choice", choice, confidence },
          [`${decision}.reason`]: { type: "choice", choice: reason, confidence },
        },
      }),
    };
  };
  const asked = (decision: string) =>
    sent.filter((request) => Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0] === decision).length;
  return Object.assign(transport, { sent, asked });
}

function dependencies(h: ProjectHarness, transport: JevTransport, overrides: Partial<DecisionDependencies> = {}): DecisionDependencies {
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async () => undefined,
    ...overrides,
  };
}

const met = (): Answer => ["met", "evidence-satisfies", above("validate")];
const notMet = (): Answer => ["not-met", "evidence-contradicts", above("validate")];
const short = (): Answer => ["insufficient-evidence", "evidence-missing", above("validate")];

const checked: ValidationInput = {
  ticketId: "T1",
  evidence: [
    { kind: "check", source: "npm test -- parser", text: "12 passed", exitCode: 0 },
    { kind: "claim", source: "implementer", text: "Added the parser and its error reporting." },
  ],
  checks: ["npm test -- parser"],
};

function storedValidation(h: ProjectHarness) {
  const read = readRecord(h.root, "progress");
  return read.kind === "present" ? read.record.validations?.["T1"] : undefined;
}

describe("judging each accepted criterion", () => {
  it("admits a ticket to review when every criterion is met, with one envelope per criterion", async () => {
    const h = project();
    const transport = jev({ [PARSES]: met(), [REPORTS]: met() });

    const result = await validateTicket(h.root, checked, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "validated", validation: { disposition: "admitted-to-review" } });
    expect(result).not.toHaveProperty("askHuman");
    expect(transport.asked("validate")).toBe(2);
    expect(storedValidation(h)).toMatchObject({
      disposition: "admitted-to-review",
      criteria: [
        { criterion: PARSES, verdict: "met", by: "jev", reasonCode: "evidence-satisfies", confidence: above("validate") },
        { criterion: REPORTS, verdict: "met", by: "jev" },
      ],
      validatedAt: now,
    });
    const envelopes = storedValidation(h)!.criteria.map((criterion) => criterion.envelope);
    expect(envelopes.every((id) => id !== undefined && listEnvelopes(h.root).includes(id))).toBe(true);
  });

  it("returns the ticket to fix when any criterion is not met", async () => {
    const h = project();

    const result = await validateTicket(h.root, checked, dependencies(h, jev({ [PARSES]: met(), [REPORTS]: notMet() })));

    expect(result).toMatchObject({ kind: "validated", validation: { disposition: "returned-to-fix" } });
    expect(storedValidation(h)?.criteria[1]).toMatchObject({ verdict: "not-met", reasonCode: "evidence-contradicts" });
  });

  it("returns the ticket to fix before chasing missing evidence", async () => {
    const h = project();

    const result = await validateTicket(
      h.root,
      { ...checked, checks: ["npm test -- parser", "npm run lint"] },
      dependencies(h, jev({ [PARSES]: short(), [REPORTS]: notMet() })),
    );

    expect(result).toMatchObject({ validation: { disposition: "returned-to-fix" } });
  });

  it("treats a below-threshold answer as insufficient evidence, never as met", async () => {
    const h = project();
    const transport = jev({ [PARSES]: ["met", "evidence-satisfies", below("validate")], [REPORTS]: met() });

    const result = await validateTicket(h.root, { ...checked, checks: [...checked.checks, "npm run e2e"] }, dependencies(h, transport));

    expect(result).toMatchObject({ validation: { disposition: "needs-check" } });
    expect(storedValidation(h)?.criteria[0]).toMatchObject({ verdict: "insufficient-evidence", by: "jev", confidence: below("validate") });
  });
});

describe("the outgoing packet", () => {
  it("carries only the one accepted criterion and the recorded evidence", async () => {
    const h = project();
    h.writeFile("src/parser.ts", "export const SENTINEL_SOURCE = 1;\n");
    const transport = jev({ [PARSES]: met(), [REPORTS]: met() });

    await validateTicket(h.root, checked, dependencies(h, transport));

    const packets = transport.sent.map((request) => (JSON.parse(request.body) as { state: Record<string, unknown> }).state);
    expect(packets[0]).toMatchObject({
      taskSummary: expect.stringContaining(PARSES),
      candidates: [],
      excerpts: [
        { source: "check: npm test -- parser", text: "exit 0\n12 passed" },
        { source: "claim: implementer", text: "Added the parser and its error reporting." },
      ],
    });
    expect(packets[0]!["taskSummary"]).not.toContain(REPORTS);
    expect(transport.sent.map((request) => request.body).join("")).not.toContain("SENTINEL_SOURCE");
  });

  it.each(["diff", "repository", "file"])("refuses %s content as evidence without calling Jev", async (kind) => {
    const h = project();
    const transport = jev({});

    const result = await validateTicket(
      h.root,
      { ...checked, evidence: [...checked.evidence, { kind, source: "git diff", text: "+ a line" } as never] },
      dependencies(h, transport),
    );

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining(EVIDENCE_KINDS.join(", ")) });
    expect(transport.sent).toEqual([]);
  });

  it("refuses check output that is a diff", async () => {
    const h = project();
    const transport = jev({});
    const diff = { kind: "check", source: "git diff", text: "diff --git a/src/p.ts b/src/p.ts\n@@ -1 +1 @@\n-a\n+b" } as const;

    const result = await validateTicket(h.root, { ...checked, evidence: [...checked.evidence, diff] }, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("diff") });
    expect(transport.sent).toEqual([]);
  });
});

describe("insufficient evidence", () => {
  it("records the checks still to run", async () => {
    const h = project();

    const result = await validateTicket(
      h.root,
      { ...checked, checks: ["npm test -- parser", "npm test -- errors"] },
      dependencies(h, jev({ [PARSES]: met(), [REPORTS]: short() })),
    );

    expect(result).toMatchObject({ validation: { disposition: "needs-check", missingChecks: ["npm test -- errors"] } });
    expect(result).not.toHaveProperty("askHuman");
  });

  it("asks escalate when no check remains, and asks the developer when it escalates", async () => {
    const h = project();
    const transport = jev({ [PARSES]: met(), [REPORTS]: short() });

    const result = await validateTicket(h.root, checked, dependencies(h, transport));

    expect(transport.asked("escalate")).toBe(1);
    expect(result).toMatchObject({
      kind: "validated",
      validation: { disposition: "awaiting-developer", missingChecks: [] },
      askHuman: { kind: "human-ask", boundary: "missing-check" },
    });
    const escalation = readEnvelope(h.root, storedValidation(h)!.escalation!);
    if (!escalation.ok) throw new Error(escalation.reason);
    expect(escalationOf(escalation.envelope)).toEqual({ boundary: "missing-check", ask: true });
  });

  it("returns the ticket to fix, to add the missing check, when escalate answers proceed", async () => {
    const h = project();
    const transport = jev({ [PARSES]: met(), [REPORTS]: short() }, ["proceed", "routine", above("escalate")]);

    const result = await validateTicket(h.root, checked, dependencies(h, transport));

    expect(result).toMatchObject({ validation: { disposition: "returned-to-fix", escalation: expect.any(String) } });
    expect(result).not.toHaveProperty("askHuman");
  });

  it("never admits a ticket whose only evidence is the implementer's claim", async () => {
    const h = project();
    const transport = jev({ [PARSES]: met(), [REPORTS]: met() }, ["proceed", "routine", above("escalate")]);
    const claimOnly: ValidationInput = { ...checked, evidence: [checked.evidence[1]!] };

    const result = await validateTicket(h.root, claimOnly, dependencies(h, transport));

    expect(transport.asked("validate")).toBe(0);
    expect(result).toMatchObject({ validation: { disposition: "needs-check", missingChecks: ["npm test -- parser"] } });
    expect(storedValidation(h)?.criteria).toEqual([
      expect.objectContaining({ verdict: "insufficient-evidence", by: "rule" }),
      expect.objectContaining({ verdict: "insufficient-evidence", by: "rule" }),
    ]);
  });

  it.each([
    ["proceed", "returned-to-fix"],
    ["escalate", "awaiting-developer"],
  ] as const)("asks escalate for a claim-only ticket with no check to run, and never admits it (%s)", async (answer, disposition) => {
    const h = project();
    const transport = jev({}, [answer, "routine", above("escalate")]);

    const result = await validateTicket(
      h.root,
      { ticketId: "T1", evidence: [checked.evidence[1]!], checks: [] },
      dependencies(h, transport),
    );

    expect(transport.asked("validate")).toBe(0);
    expect(transport.asked("escalate")).toBe(1);
    expect(result).toMatchObject({ validation: { disposition } });
  });
});

describe("setting a verdict aside", () => {
  it("gets past a not-met criterion only with a recorded evidence-based reason", async () => {
    const h = project();
    const deps = dependencies(h, jev({ [PARSES]: met(), [REPORTS]: notMet() }));
    await validateTicket(h.root, checked, deps);

    const unexplained = await overrideCriterion(h.root, { ticketId: "T1", criterion: 1, verdict: "met", by: "agent", reason: "fine" }, deps);
    expect(unexplained).toMatchObject({ kind: "refused", reason: expect.stringContaining("evidence-based reason") });
    expect(storedValidation(h)?.disposition).toBe("returned-to-fix");

    const overridden = await overrideCriterion(
      h.root,
      {
        ticketId: "T1",
        criterion: 1,
        verdict: "met",
        by: "agent",
        reason: "the failing case was the old error format the criterion no longer names",
        evidence: ["npm test -- parser: 13 passed after updating the fixture"],
      },
      deps,
    );

    expect(overridden).toMatchObject({ kind: "validated", validation: { disposition: "admitted-to-review" } });
    expect(storedValidation(h)?.criteria[1]).toMatchObject({ verdict: "met", by: "agent", note: expect.stringContaining("old error format") });
  });

  it("refuses to set aside a verdict that no envelope backs", async () => {
    const h = project();
    const deps = dependencies(h, jev({}));
    await validateTicket(h.root, { ...checked, evidence: [checked.evidence[1]!] }, deps);

    const result = await overrideCriterion(
      h.root,
      { ticketId: "T1", criterion: 0, verdict: "met", by: "developer", reason: "trust me" },
      deps,
    );

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("rule") });
  });
});

describe("what validation refuses", () => {
  it("refuses before the plan is accepted", async () => {
    const h = project([ticket()], false);
    const transport = jev({});

    expect(await validateTicket(h.root, checked, dependencies(h, transport))).toMatchObject({ kind: "refused" });
    expect(transport.sent).toEqual([]);
  });

  it.each([
    ["an unknown ticket", { ...checked, ticketId: "T9" }, [ticket()]],
    ["a done ticket", checked, [ticket({ status: "done" })]],
    ["no evidence", { ...checked, evidence: [] }, [ticket()]],
  ] as const)("refuses %s", async (_what, input, tickets) => {
    const h = project(tickets);
    const transport = jev({});

    expect(await validateTicket(h.root, input, dependencies(h, transport))).toMatchObject({ kind: "refused" });
    expect(transport.sent).toEqual([]);
  });

  it("asks the developer and records nothing when no Jev key is configured", async () => {
    const h = project();
    const transport = jev({});

    const result = await validateTicket(
      h.root,
      checked,
      dependencies(h, transport, {
        apiKey: { status: "missing", askHuman: "No Jev API key is configured.", mayProceedWithoutJev: false },
      }),
    );

    expect(result).toMatchObject({ kind: "needs-configuration", askHuman: { kind: "human-ask" } });
    expect(storedValidation(h)).toBeUndefined();
  });
});
