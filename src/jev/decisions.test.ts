import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProjectHarness, type HarnessOptions, type ProjectHarness } from "../testing/harness.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { loadDecisionQuestion, type DecisionQuestion, type JevTransport, type TransportRequest } from "./client.js";
import {
  adviseNext,
  askDecision,
  assignmentEvidence,
  lessonRetentionEvidence,
  listEnvelopes,
  permittedChoices,
  readEnvelope,
  rebuildJevRequest,
  recordChoice,
  routeAnswer,
  type DecisionDependencies,
  type DecisionEnvelope,
} from "./decisions.js";
import { listTraces } from "./traces.js";

const harnesses: ProjectHarness[] = [];

function harness(options?: HarnessOptions): ProjectHarness {
  const created = createProjectHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-24T10:00:00.000Z";

/** Confidences on either side of a decision's threshold; the threshold's value is never asserted (D37). */
function above(decision: string): number {
  const threshold = confidenceThreshold(pkg, decision);
  return threshold + (1 - threshold) / 2;
}

function below(decision: string): number {
  return confidenceThreshold(pkg, decision) / 2;
}

/** A transport answering one decision with a fixed choice, reason code and confidence. */
function jevAnswering(
  decision: string,
  choice: string,
  reason: string,
  confidence: number,
  onSend: (request: TransportRequest) => void = () => undefined,
): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    onSend(request);
    sent.push(request);
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
  return Object.assign(transport, { sent });
}

/** The shipped question with its wording marked accepted, for routes that need accepted wording. */
function acceptedQuestion(decision: string): DecisionQuestion {
  return { ...loadDecisionQuestion(pkg, decision), status: "accepted" };
}

function dependencies(
  h: ProjectHarness,
  transport: JevTransport,
  overrides: Partial<DecisionDependencies> = {},
): DecisionDependencies {
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    ...overrides,
  };
}

const input = { taskSummary: "T1's first fix attempt failed", candidates: [], excerpts: [] };

async function answered(
  h: ProjectHarness,
  decision: string,
  choice: string,
  confidence: number,
  options: { readonly accepted?: boolean } = {},
): Promise<DecisionEnvelope> {
  const question = loadDecisionQuestion(pkg, decision);
  const transport = jevAnswering(decision, choice, question.reasons[0]!, confidence);
  const result = await askDecision(
    h.root,
    decision,
    input,
    dependencies(h, transport, options.accepted ? { readQuestion: acceptedQuestion } : {}),
  );
  if (result.kind !== "answered") throw new Error(`expected an answer, got ${result.kind}`);
  return result.envelope;
}

describe("asking a declared decision by name", () => {
  it.each(Object.keys(pkg.decisions))("asks %s and records its envelope", async (decision) => {
    const h = harness();
    const envelope = await answered(h, decision, loadDecisionQuestion(pkg, decision).answers[0]!, 0.5);

    expect(envelope).toMatchObject({ decision, authority: pkg.decisions[decision]!.authority });
    expect(listEnvelopes(h.root)).toEqual([envelope.id]);
  });

  it("refuses an undeclared decision without calling Jev", async () => {
    const h = harness();
    const transport = jevAnswering("disposition", "fix", "x", 0.99);

    const result = await askDecision(h.root, "disposition", input, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("disposition") });
    expect(transport.sent).toEqual([]);
    expect(listTraces(h.root)).toEqual([]);
    expect(listEnvelopes(h.root)).toEqual([]);
  });

  it("passes a missing key through as a question for the developer, recording nothing", async () => {
    const h = harness();
    const transport = jevAnswering("escalate", "proceed", "routine", 0.99);

    const result = await askDecision(
      h.root,
      "escalate",
      input,
      dependencies(h, transport, {
        apiKey: { status: "missing", askHuman: "No Jev API key is configured.", mayProceedWithoutJev: false },
      }),
    );

    expect(result).toMatchObject({ kind: "needs-configuration", askHuman: "No Jev API key is configured." });
    expect(transport.sent).toEqual([]);
    expect(listEnvelopes(h.root)).toEqual([]);
  });
});

describe("the decision envelope", () => {
  it("holds packet, question and policy versions, answer, reason code, confidence and authority", async () => {
    const h = harness();
    const transport = jevAnswering("escalate", "escalate", "uncertain", 0.7);

    const result = await askDecision(
      h.root,
      "escalate",
      { ...input, excerpts: [{ source: "npm test", text: "1 failed" }] },
      dependencies(h, transport),
    );

    if (result.kind !== "answered") throw new Error(result.kind);
    const { envelope } = result;
    expect(envelope).toMatchObject({
      decision: "escalate",
      authority: "binding",
      askedAt: now,
      request: {
        question: { decision: "escalate", version: pkg.decisions["escalate"]!.version, status: "skeleton" },
        packet: { taskSummary: input.taskSummary, excerpts: [{ source: "npm test", text: "1 failed" }] },
      },
      policy: { version: expect.stringMatching(/^sha256:[0-9a-f]+$/), thresholds: pkg.policy["escalate"]!.thresholds },
      answer: { choice: "escalate", reasonCode: "uncertain", confidence: 0.7, traceReference: expect.any(String) },
    });
    expect(envelope).not.toHaveProperty("choice");
  });

  it("rebuilds the exact request from the stored envelope alone", async () => {
    const h = harness();
    const transport = jevAnswering("lesson-retention", "retain", "evidence-backed", 0.7);

    const result = await askDecision(h.root, "lesson-retention", input, dependencies(h, transport));

    if (result.kind !== "answered") throw new Error(result.kind);
    const stored = JSON.parse(
      readFileSync(join(h.root, ".jflow/envelopes", `${result.envelope.id}.json`), "utf8"),
    ) as DecisionEnvelope;
    expect(rebuildJevRequest(stored)).toBe(transport.sent[0]!.body);
  });

  it("sends the request before interpreting anything and records the response before returning it", async () => {
    const h = harness();
    let envelopesAtSend: readonly string[] | undefined;
    const transport = jevAnswering("next-action", "plan", "prerequisites-met", 0.7, () => {
      envelopesAtSend = listEnvelopes(h.root);
    });

    const result = await askDecision(h.root, "next-action", input, dependencies(h, transport));

    expect(envelopesAtSend).toEqual([]);
    if (result.kind !== "answered") throw new Error(result.kind);
    expect(readEnvelope(h.root, result.envelope.id)).toEqual({ ok: true, envelope: result.envelope });
  });

  it("keeps envelopes local and out of the project records", async () => {
    const h = harness({ gitRepository: true, state: { specificationAccepted: true } });
    const before = h.snapshot();

    const envelope = await answered(h, "next-action", "plan", 0.99);

    const added = Object.keys(h.snapshot()).filter((path) => !(path in before));
    expect(added.every((path) => path.startsWith(".jflow/"))).toBe(true);
    expect(added).toContain(`.jflow/envelopes/${envelope.id}.json`);
    expect(readFileSync(h.path(".jflow/.gitignore"), "utf8")).toBe("*\n");
  });
});

describe("routing an answer by authority", () => {
  it.each([
    ["binding", "escalate", "act"],
    ["advisory", "next-action", "weigh"],
  ] as const)("acts on a confident %s answer to accepted wording as %s", (_authority, decision, route) => {
    expect(
      routeAnswer(pkg, acceptedQuestion(decision), { confidence: above(decision) }).route,
    ).toBe(route);
  });

  it.each(["escalate", "next-action"])("routes a below-threshold %s answer to the developer", (decision) => {
    expect(routeAnswer(pkg, acceptedQuestion(decision), { confidence: below(decision) }).route).toBe("ask-human");
    expect(routeAnswer(pkg, acceptedQuestion(decision), {}).route).toBe("ask-human");
  });

  it.each(["skeleton", "proposed"] as const)("never relies on an answer to %s wording, however confident", (status) => {
    const question = { ...acceptedQuestion("escalate"), status };

    expect(routeAnswer(pkg, question, { confidence: 1 })).toMatchObject({
      route: "ask-human",
      reason: expect.stringContaining("not accepted"),
    });
  });
});

describe("recording the chosen action", () => {
  it("acts on a binding answer directly", async () => {
    const h = harness();
    const envelope = await answered(h, "escalate", "escalate", above("escalate"), { accepted: true });

    const result = recordChoice(h.root, envelope.id, { action: "escalate", by: "workflow" }, ["proceed", "escalate"], { now });

    expect(result).toMatchObject({ ok: true, envelope: { choice: { action: "escalate", followsAnswer: true } } });
    expect(readEnvelope(h.root, envelope.id)).toMatchObject({ ok: true, envelope: { choice: { action: "escalate" } } });
  });

  it("gets past a binding answer only with a recorded evidence-based reason", async () => {
    const h = harness();
    const envelope = await answered(h, "escalate", "escalate", above("escalate"), { accepted: true });
    const permitted = ["proceed", "escalate"];

    expect(recordChoice(h.root, envelope.id, { action: "proceed", by: "agent" }, permitted, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("evidence-based reason"),
    });
    expect(
      recordChoice(h.root, envelope.id, { action: "proceed", by: "agent", reason: "the retry passed" }, permitted, { now }),
    ).toMatchObject({ ok: false });

    const result = recordChoice(
      h.root,
      envelope.id,
      { action: "proceed", by: "agent", reason: "the failure was a flaky network test", evidence: ["npm test: 42 passed on rerun"] },
      permitted,
      { now },
    );

    expect(result).toMatchObject({
      ok: true,
      envelope: {
        choice: {
          action: "proceed",
          followsAnswer: false,
          reason: "the failure was a flaky network test",
          evidence: ["npm test: 42 passed on rerun"],
        },
      },
    });
  });

  it("records an advisory answer and lets it be set aside with a reason", async () => {
    const h = harness();
    const envelope = await answered(h, "lesson-retention", "retain", above("lesson-retention"), { accepted: true });
    const permitted = ["retain", "discard", "escalate"];

    expect(recordChoice(h.root, envelope.id, { action: "discard", by: "agent" }, permitted, { now }).ok).toBe(false);
    expect(
      recordChoice(
        h.root,
        envelope.id,
        { action: "discard", by: "agent", reason: "lesson L3 already says this", evidence: ["jflow/lessons.json#L3"] },
        permitted,
        { now },
      ),
    ).toMatchObject({ ok: true, envelope: { route: "weigh", choice: { action: "discard", followsAnswer: false } } });
  });

  it("refuses a choice beyond workflow rules or authority, even when it is Jev's answer", async () => {
    const h = harness();
    const envelope = await answered(h, "next-action", "implement", above("next-action"), { accepted: true });

    const result = recordChoice(
      h.root,
      envelope.id,
      { action: "implement", by: "developer", reason: "just do it", evidence: ["their words"] },
      ["brainstorm"],
      { now },
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not permitted") });
    expect(readEnvelope(h.root, envelope.id)).toMatchObject({ ok: true, envelope: { answer: { choice: "implement" } } });
    expect(readEnvelope(h.root, envelope.id)).not.toMatchObject({ envelope: { choice: expect.anything() } });
  });

  it("leaves a below-threshold answer to the developer's recorded decision", async () => {
    const h = harness();
    const envelope = await answered(h, "escalate", "proceed", below("escalate"), { accepted: true });
    const permitted = ["proceed", "escalate"];

    expect(recordChoice(h.root, envelope.id, { action: "proceed", by: "agent" }, permitted, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("developer"),
    });
    expect(
      recordChoice(h.root, envelope.id, { action: "proceed", by: "developer", reason: "carry on" }, permitted, { now }),
    ).toMatchObject({ ok: true, envelope: { choice: { by: "developer", reason: "carry on" } } });
  });

  it("records one choice per envelope", async () => {
    const h = harness();
    const envelope = await answered(h, "escalate", "escalate", above("escalate"), { accepted: true });
    recordChoice(h.root, envelope.id, { action: "escalate", by: "workflow" }, ["proceed", "escalate"], { now });

    expect(
      recordChoice(h.root, envelope.id, { action: "escalate", by: "workflow" }, ["proceed", "escalate"], { now }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("already") });
  });

  it("refuses a choice on an envelope that does not exist", () => {
    const h = harness();

    expect(recordChoice(h.root, "ENV-missing", { action: "x", by: "agent" }, ["x"], { now })).toMatchObject({ ok: false });
  });
});

describe("hard rules that hold whatever Jev answers", () => {
  it("resolves prerequisites and authorization the same way regardless of Jev's answer", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
    const before = { state: h.readState(), implement: h.runAction("implement"), permitted: permittedChoices(h.root, "next-action", h.context) };

    await answered(h, "next-action", "implement", 0.99, { accepted: true });

    expect(h.readState()).toEqual(before.state);
    expect(h.runAction("implement")).toEqual(before.implement);
    expect(h.runAction("implement").kind).toBe("blocked");
    expect(permittedChoices(h.root, "next-action", h.context)).toEqual(before.permitted);
    expect(before.permitted).not.toContain("implement");
  });

  it("never marks work correct or complete on a Jev score alone", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1", ticketChangesPresent: true },
      gitRepository: true,
    });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({ tickets: [{ id: "T1", title: "t", acceptanceCriteria: ["c"], dependsOn: [], status: "in-progress" }] }),
    );
    const records = () => Object.entries(h.snapshot()).filter(([path]) => path.startsWith("jflow/"));
    const before = records();

    const envelope = await answered(h, "validate", "met", 1, { accepted: true });
    recordChoice(h.root, envelope.id, { action: "met", by: "workflow" }, ["met", "not-met", "insufficient-evidence"], { now });

    expect(records()).toEqual(before);
  });
});

describe("next-action, end to end", () => {
  it("reports Jev's recommendation with its envelope reference beside the records' own, granting nothing", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
    const records = () => Object.entries(h.snapshot()).filter(([path]) => path.startsWith("jflow/"));
    const before = records();
    const transport = jevAnswering("next-action", "implement", "awaits-developer", above("next-action"));

    const advice = await adviseNext(h.root, dependencies(h, transport));

    if (advice.report.project === "malformed") throw new Error("malformed");
    expect(advice.report.recommendation).toMatchObject({ action: "implement", needsDeveloper: true });
    expect(advice.jev).toMatchObject({
      kind: "answered",
      envelope: expect.stringMatching(/^ENV-/),
      answer: "implement",
      reasonCode: "awaits-developer",
      route: "weigh",
    });
    const sent = JSON.parse(transport.sent[0]!.body) as { state: { candidates: string[]; excerpts: { source: string }[] } };
    expect(sent.state.candidates).toEqual(loadDecisionQuestion(pkg, "next-action").answers);
    expect(sent.state.excerpts.map((excerpt) => excerpt.source)).toContain("actions/implement");
    expect(records()).toEqual(before);
    expect(h.runAction("implement").kind).toBe("blocked");
  });

  it("asks nothing of Jev when the records cannot be read", async () => {
    const h = harness();
    h.writeFile("jflow/progress.json", "{ truncated");
    const transport = jevAnswering("next-action", "plan", "prerequisites-met", 0.97);

    const advice = await adviseNext(h.root, dependencies(h, transport));

    expect(advice.report.project).toBe("malformed");
    expect(advice.jev).toEqual({ kind: "not-asked", reason: expect.stringContaining("cannot be read") });
    expect(transport.sent).toEqual([]);
  });
});

describe("the D18 assessments' evidence", () => {
  it("offers proposed assignments to the assignment decision as bounded evidence", async () => {
    const h = harness();
    const transport = jevAnswering("assignment", "revise", "overlapping-assignments", 0.8);

    const result = await askDecision(
      h.root,
      "assignment",
      assignmentEvidence({
        unit: "T3: add the conflict record",
        assignments: [
          { role: "implementer", task: "write conflicts.ts", covers: ["src/actions/conflicts.ts"] },
          { role: "implementer", task: "write the conflict record", covers: ["src/actions/conflicts.ts"] },
        ],
      }),
      dependencies(h, transport),
    );

    expect(result).toMatchObject({ kind: "answered", envelope: { answer: { choice: "revise", reasonCode: "overlapping-assignments" } } });
    const sent = JSON.parse(transport.sent[0]!.body) as { state: { taskSummary: string; excerpts: { source: string; text: string }[] } };
    expect(sent.state.taskSummary).toContain("T3");
    expect(sent.state.excerpts).toHaveLength(2);
    expect(sent.state.excerpts[1]!.text).toContain("src/actions/conflicts.ts");
  });

  it("offers a candidate lesson and what it touches to the lesson-retention decision", async () => {
    const h = harness();
    const transport = jevAnswering("lesson-retention", "retain", "evidence-backed", 0.8);

    const result = await askDecision(
      h.root,
      "lesson-retention",
      lessonRetentionEvidence({
        statement: "Run git status before staging in this repo",
        scope: "src/project",
        evidence: [{ kind: "commit", reference: "d136ded" }],
        related: ["L1: never stage the developer's changes"],
      }),
      dependencies(h, transport),
    );

    expect(result).toMatchObject({ kind: "answered" });
    const sent = JSON.parse(transport.sent[0]!.body) as { state: { taskSummary: string; excerpts: { text: string }[] } };
    expect(sent.state.taskSummary).toContain("Run git status");
    expect(sent.state.excerpts.map((excerpt) => excerpt.text).join("\n")).toContain("d136ded");
  });
});

describe("envelope storage", () => {
  it("reports a missing envelope rather than inventing one", () => {
    const h = harness();

    expect(readEnvelope(h.root, "ENV-nope")).toMatchObject({ ok: false });
    expect(existsSync(h.path(".jflow/envelopes"))).toBe(false);
  });
});
