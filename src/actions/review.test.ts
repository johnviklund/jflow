import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import type { JevTransport, TransportRequest } from "../jev/client.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import {
  readRecord,
  writeRecord,
  type ProgressRecord,
  type TicketRecord,
  type TicketValidation,
} from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { checkTicket, type CheckInput } from "./implement.js";
import { resolveAction, type ResolutionContext } from "./resolve.js";
import { decideFinding, recordReview, startReview, type ReviewInput } from "./review.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T12:00:00.000Z";
const above = (decision: string) => {
  const threshold = confidenceThreshold(pkg, decision);
  return threshold + (1 - threshold) / 2;
};

const PARSES = "parses an empty file to an empty list";

const admitted: TicketValidation = {
  disposition: "admitted-to-review",
  criteria: [{ criterion: PARSES, verdict: "met", by: "jev", envelope: "env-1" }],
  missingChecks: [],
  validatedAt: "2026-09-25T11:00:00.000Z",
};

function contextWith(configuration: Record<string, unknown>): ResolutionContext {
  const resolved = resolveConfiguration(configuration, pkg);
  if (!resolved.ok) throw new Error("test configuration must be valid");
  return { workflowPackage: pkg, configuration: resolved.configuration };
}

/** T1 in progress under ticket authorization, in a Git repository, with the given validation. */
function project(progress: Partial<ProgressRecord> = { validations: { T1: admitted } }): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
  harnesses.push(h);
  const ticket: TicketRecord = { id: "T1", title: "Parser", acceptanceCriteria: [PARSES], dependsOn: [], status: "in-progress" };
  writeRecord(h.root, "tickets", { tickets: [ticket] });
  writeRecord(h.root, "progress", {
    executionAuthorized: true,
    authorizationScope: "ticket",
    authorizationNote: "implement T1",
    assignedTicketId: "T1",
    ticketChangesPresent: true,
    ...progress,
  });
  return h;
}

const progressOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "progress");
  if (read.kind !== "present") throw new Error("no progress record");
  return read.record;
};
const todosOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "todos");
  return read.kind === "present" ? read.record.items : [];
};
const conflictsOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "conflicts");
  return read.kind === "present" ? read.record.conflicts : [];
};

type Answer = readonly [choice: string, reason: string, confidence: number];

/** A Jev answering each decision from its own queue, one answer per call. */
function jev(
  answers: Partial<Record<"validate" | "escalate", Answer[]>> = {},
): JevTransport & { readonly sent: TransportRequest[]; readonly asked: (decision: string) => TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const decisionOf = (request: TransportRequest) =>
    Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const decision = decisionOf(request);
    const answer = answers[decision as "validate" | "escalate"]?.shift();
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
  const asked = (decision: string) => sent.filter((request) => decisionOf(request) === decision);
  return Object.assign(transport, { sent, asked });
}

function dependencies(h: ProjectHarness, transport: JevTransport, context = h.context): DecisionDependencies {
  return {
    context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
  };
}

const met = (): Answer => ["met", "evidence-satisfies", above("validate")];
const notMet = (): Answer => ["not-met", "evidence-contradicts", above("validate")];
const proceed = (): Answer => ["proceed", "routine", above("escalate")];
const escalate = (): Answer => ["escalate", "uncertain", above("escalate")];

const REVIEWER = { agent: "reviewer-1", model: "claude-sonnet-5" };
const OFF_BY_ONE = { kind: "correctness", summary: "the error line is off by one", evidence: ["src/parser.ts:42"] } as const;
const RENAME = { kind: "improvement", summary: "rename tok to token", evidence: ["src/parser.ts:10"] } as const;
const RECOMMENDATION = "pair the parser fix with a failing test first";

function review(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return { ticketId: "T1", reviewer: REVIEWER, findings: [], ...overrides };
}

const checked: CheckInput = {
  ticketId: "T1",
  evidence: [{ kind: "check", source: "npm test -- parser", text: "12 passed", exitCode: 0 }],
  checks: ["npm test -- parser"],
};

describe("the gate into review", () => {
  it("refuses a ticket whose latest validate did not find every criterion met", async () => {
    const returned: TicketValidation = { ...admitted, disposition: "returned-to-fix" };
    for (const progress of [{}, { validations: { T1: returned } }]) {
      const h = project(progress);
      const transport = jev();

      expect(startReview(h.root, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("validate") });
      const result = await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), dependencies(h, transport));

      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("validate") });
      expect(progressOf(h).reviews).toBeUndefined();
      expect(transport.sent).toHaveLength(0);
    }
  });

  it("gives the reviewer a fresh context: the ticket, its criteria and verdicts, the recorded evidence and the review model", () => {
    const h = project({ validations: { T1: admitted }, implementers: { T1: ["worker-1"] } });
    const context = contextWith({
      stageModels: { implement: { model: "claude-opus-5-5" }, review: { model: "claude-sonnet-5" } },
    });

    const started = startReview(h.root, context);

    expect(started).toMatchObject({
      ok: true,
      outcome: {
        ticket: { id: "T1", acceptanceCriteria: [PARSES] },
        validation: { disposition: "admitted-to-review" },
        stageModel: { model: "claude-sonnet-5" },
        implementers: ["primary", "worker-1"],
        fix: { attempts: 0, limit: 2 },
      },
    });
  });
});

describe("reviewer independence", () => {
  it("rejects a review by an agent that implemented the ticket, even when the models match", async () => {
    const h = project({ validations: { T1: admitted }, implementers: { T1: ["worker-1"] } });
    const transport = jev();

    for (const agent of ["primary", "worker-1"]) {
      const result = await recordReview(
        h.root,
        review({ reviewer: { agent, model: "claude-sonnet-5" } }),
        dependencies(h, transport),
      );
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("implemented") });
    }
    expect(progressOf(h).reviews).toBeUndefined();
  });

  it("accepts a distinct reviewer on the implementer's own model and records who reviewed", async () => {
    const h = project();

    const result = await recordReview(
      h.root,
      review({ reviewer: { agent: "reviewer-1", model: "claude-opus-5-5" } }),
      dependencies(h, jev()),
    );

    expect(result).toMatchObject({ ok: true, review: { disposition: "passed" } });
    expect(progressOf(h).reviews?.["T1"]).toMatchObject({
      reviewer: { agent: "reviewer-1", model: "claude-opus-5-5" },
      disposition: "passed",
      findings: [],
      reviewedAt: now,
    });
  });

  it("counts the stage workers recorded for the ticket as implementers", async () => {
    const h = project();
    writeRecord(h.root, "workers", {
      assignments: [
        {
          id: "W-1",
          stage: "implement",
          role: "implementer",
          agent: "worker-7",
          ticketId: "T1",
          model: "builder-model",
          status: "finished",
          startedAt: now,
          finishedAt: now,
        },
      ],
    });

    expect(startReview(h.root, h.context)).toMatchObject({ ok: true, outcome: { implementers: ["primary", "worker-7"] } });
    expect(await recordReview(h.root, review({ reviewer: { agent: "worker-7" } }), dependencies(h, jev()))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("implemented"),
    });
  });

  it("counts the workers named in the ticket's checks as implementers", async () => {
    const h = project({});
    const deps = dependencies(h, jev({ validate: [met()] }));
    await checkTicket(h.root, { ...checked, workers: ["worker-2"] }, deps);

    const result = await recordReview(h.root, review({ reviewer: { agent: "worker-2" } }), deps);

    expect(progressOf(h).implementers).toEqual({ T1: ["worker-2"] });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("implemented") });
  });
});

describe("finding disposition by the fixed rule", () => {
  it("blocks the ticket on a confirmed finding and sends it back through validate before re-review", async () => {
    const h = project();
    const transport = jev();

    const result = await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), dependencies(h, transport));

    expect(result).toMatchObject({
      ok: true,
      review: { disposition: "returned-to-fix", findings: [{ id: "F1", kind: "correctness", disposition: "blocking" }] },
      fix: { attempts: 0, counted: false },
    });
    const progress = progressOf(h);
    expect(progress.validations?.["T1"]).toBeUndefined();
    const state = readProjectState(h.root);
    if (state.kind !== "initialized") throw new Error("state must be readable");
    expect(resolveAction({ action: "review" }, state.state, h.context)).toMatchObject({ status: "blocked" });
    expect(readRecord(h.root, "tickets")).toMatchObject({ record: { tickets: [{ id: "T1", status: "in-progress" }] } });
    expect(transport.sent).toHaveLength(0);
  });

  it("files an optional improvement as a todo without blocking or asking Jev to classify it", async () => {
    const h = project();
    const transport = jev();

    const result = await recordReview(h.root, review({ findings: [RENAME] }), dependencies(h, transport));

    expect(result).toMatchObject({
      ok: true,
      review: { disposition: "passed", findings: [{ id: "F1", disposition: "todo", todo: "TODO-1" }] },
    });
    expect(todosOf(h)).toEqual([
      expect.objectContaining({ id: "TODO-1", summary: "rename tok to token", discoveredDuring: "T1", status: "open" }),
    ]);
    expect(progressOf(h).validations?.["T1"]).toEqual(admitted);
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses a finding of no known kind rather than guessing its disposition", async () => {
    const h = project();

    const result = await recordReview(
      h.root,
      review({ findings: [{ kind: "style" as "improvement", summary: "tabs", evidence: [] }] }),
      dependencies(h, jev()),
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("requirement, correctness, standard, improvement") });
    expect(todosOf(h)).toEqual([]);
  });
});

describe("disputed findings", () => {
  it("withdraws a finding the dispute settles with recorded evidence, asking no one", async () => {
    const h = project();
    const transport = jev();
    const dispute = { reason: "line 42 is 1-based by design", evidence: ["npm test -- parser: 12 passed"], conclusive: true };

    const result = await recordReview(h.root, review({ findings: [{ ...OFF_BY_ONE, dispute }] }), dependencies(h, transport));

    expect(result).toMatchObject({
      ok: true,
      review: {
        disposition: "passed",
        findings: [
          {
            disposition: "withdrawn",
            dispute: { reason: dispute.reason, resolution: { by: "agent", evidence: dispute.evidence } },
          },
        ],
      },
    });
    expect(result).not.toHaveProperty("askHuman");
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses to settle a dispute without evidence", async () => {
    const h = project();

    const result = await recordReview(
      h.root,
      review({ findings: [{ ...OFF_BY_ONE, dispute: { reason: "I disagree", conclusive: true } }] }),
      dependencies(h, jev()),
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
  });

  it("asks escalate at review-dispute when the evidence does not settle it, and waits for the developer on escalate", async () => {
    const h = project();
    const transport = jev({ escalate: [escalate()] });
    const dispute = { reason: "the spec may allow 1-based lines", evidence: ["SPEC.md:88"] };

    const result = await recordReview(h.root, review({ findings: [{ ...OFF_BY_ONE, dispute }] }), dependencies(h, transport));

    expect(transport.asked("escalate")).toHaveLength(1);
    expect(transport.sent[0]?.body).toContain("Boundary: review-dispute.");
    expect(result).toMatchObject({
      ok: true,
      review: { disposition: "awaiting-developer", findings: [{ disposition: "awaiting-developer", dispute: { escalation: expect.any(String) } }] },
      askHuman: { kind: "human-ask", reasons: [expect.stringContaining("the error line is off by one")] },
    });
    expect(progressOf(h).fixAttempts).toBeUndefined();
    expect(progressOf(h).validations?.["T1"]).toEqual(admitted);
  });

  it("keeps the finding blocking when escalate confidently lets the work proceed without the developer", async () => {
    const h = project();

    const result = await recordReview(
      h.root,
      review({ findings: [{ ...OFF_BY_ONE, dispute: { reason: "maybe fine", evidence: [] } }] }),
      dependencies(h, jev({ escalate: [proceed()] })),
    );

    expect(result).toMatchObject({
      ok: true,
      review: { disposition: "returned-to-fix", findings: [{ disposition: "blocking", dispute: { resolution: { by: "workflow" } } }] },
    });
    expect(result).not.toHaveProperty("askHuman");
  });

  it("puts a consequential dispute to the developer as a conflict, without a Jev call", async () => {
    const h = project();
    const transport = jev();
    const dispute = { reason: "fixing it widens the ticket's scope", evidence: [], touches: ["scope"] as const };

    const result = await recordReview(h.root, review({ findings: [{ ...OFF_BY_ONE, dispute }] }), dependencies(h, transport));

    expect(transport.sent).toHaveLength(0);
    expect(conflictsOf(h)).toEqual([expect.objectContaining({ id: "C1", kind: "consequential", status: "awaiting-developer" })]);
    expect(result).toMatchObject({
      ok: true,
      review: { disposition: "awaiting-developer", findings: [{ disposition: "awaiting-developer", dispute: { conflict: "C1" } }] },
      askHuman: { reasons: [expect.stringContaining("the decision is yours")] },
    });
  });

  it("records the developer's decision: upheld blocks and counts, withdrawn passes, and the conflict is resolved", async () => {
    const h = project();
    const dispute = { reason: "fixing it widens the ticket's scope", evidence: [], touches: ["scope"] as const };
    const deps = dependencies(h, jev());
    await recordReview(h.root, review({ findings: [{ ...OFF_BY_ONE, dispute }] }), deps);

    const upheld = await decideFinding(h.root, { ticketId: "T1", finding: "F1", outcome: "upheld", note: "fix it here" }, deps);

    expect(upheld).toMatchObject({
      ok: true,
      review: {
        disposition: "returned-to-fix",
        findings: [{ disposition: "blocking", dispute: { resolution: { by: "developer", note: "fix it here" } } }],
      },
      fix: { attempts: 0 },
    });
    expect(conflictsOf(h)[0]).toMatchObject({ status: "resolved", resolution: { by: "developer", note: "fix it here" } });
    expect(progressOf(h).validations?.["T1"]).toBeUndefined();

    const h2 = project();
    const deps2 = dependencies(h2, jev({ escalate: [escalate()] }));
    await recordReview(h2.root, review({ findings: [{ ...OFF_BY_ONE, dispute: { reason: "r", evidence: [] } }] }), deps2);
    const withdrawn = await decideFinding(h2.root, { ticketId: "T1", finding: "F1", outcome: "withdrawn", note: "leave it" }, deps2);

    expect(withdrawn).toMatchObject({ ok: true, review: { disposition: "passed", findings: [{ disposition: "withdrawn" }] } });
    expect(progressOf(h2).fixAttempts).toBeUndefined();
  });

  it("refuses another review while a dispute waits for the developer, or once the ticket has passed", async () => {
    const h = project();
    const deps = dependencies(h, jev());
    const dispute = { reason: "fixing it widens the ticket's scope", evidence: [], touches: ["scope"] as const };
    await recordReview(h.root, review({ findings: [{ ...OFF_BY_ONE, dispute }] }), deps);

    expect(startReview(h.root, h.context)).toMatchObject({ ok: false });
    expect(await recordReview(h.root, review({ reviewer: { agent: "reviewer-2" } }), deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("review decide"),
    });
    expect(progressOf(h).reviews?.["T1"]).toMatchObject({ reviewer: { agent: "reviewer-1" }, disposition: "awaiting-developer" });

    await decideFinding(h.root, { ticketId: "T1", finding: "F1", outcome: "withdrawn", note: "leave it" }, deps);
    expect(await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("passed review"),
    });
  });

  it("refuses a developer decision without their words, or on a finding that is not waiting for one", async () => {
    const h = project();
    const deps = dependencies(h, jev());
    await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), deps);

    expect(await decideFinding(h.root, { ticketId: "T1", finding: "F1", outcome: "withdrawn", note: "ok" }, deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not waiting"),
    });
    expect(await decideFinding(h.root, { ticketId: "T1", finding: "F1", outcome: "upheld", note: " " }, deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("words"),
    });
  });
});

describe("the shared fix counter", () => {
  it("reaches the limit on two validation misses and one blocking finding, asking escalate with problem, attempts and recommendation", async () => {
    const h = project({});
    const transport = jev({ validate: [notMet(), notMet(), met()], escalate: [escalate()] });
    const deps = dependencies(h, transport);
    await checkTicket(h.root, checked, deps);
    await checkTicket(h.root, { ...checked, recommendation: RECOMMENDATION }, deps);
    await checkTicket(h.root, { ...checked, recommendation: RECOMMENDATION }, deps);
    expect(progressOf(h)).toMatchObject({ fixAttempts: { T1: 1 }, validations: { T1: { disposition: "admitted-to-review" } } });

    expect(await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("recommendation"),
    });
    expect(progressOf(h).reviews).toBeUndefined();

    const result = await recordReview(h.root, review({ findings: [OFF_BY_ONE], recommendation: RECOMMENDATION }), deps);

    expect(result).toMatchObject({
      ok: true,
      review: { disposition: "returned-to-fix" },
      fix: { attempts: 2, limit: 2, counted: true, escalation: expect.any(String) },
      askHuman: { boundary: "fix-failed", reasons: [expect.stringContaining("the error line is off by one")] },
    });
    const body = transport.asked("escalate")[0]?.body ?? "";
    expect(body).toContain("Boundary: fix-failed.");
    expect(body).toContain("2 unsuccessful fix attempts");
    expect(body).toContain(RECOMMENDATION);
  });

  it("counts a failed re-review after a first blocking finding", async () => {
    const h = project();
    const deps = dependencies(h, jev({ validate: [met()] }));
    await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), deps);
    await checkTicket(h.root, checked, deps);

    const result = await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), deps);

    expect(result).toMatchObject({ ok: true, fix: { attempts: 1, counted: true } });
    expect(result).not.toHaveProperty("askHuman");
  });

  it("uses the configured limit, which leaves the Jev retry count alone", async () => {
    const context = contextWith({ settings: { "review.fixRetryLimit": 3 } });
    expect(context.configuration.settings["jev.retryCount"]).toBe(2);
    const h = project({ validations: { T1: admitted }, fixAttempts: { T1: 1 } });

    const result = await recordReview(h.root, review({ findings: [OFF_BY_ONE] }), dependencies(h, jev(), context));

    expect(result).toMatchObject({ ok: true, fix: { attempts: 2, limit: 3 } });
    expect(result).not.toHaveProperty("askHuman");
  });
});
