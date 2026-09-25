import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import type { JevTransport, TransportRequest } from "../jev/client.js";
import { readEnvelope, type DecisionDependencies } from "../jev/decisions.js";
import { readRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { recommendModel, type SelectionDraft } from "./model-selection.js";
import type { ResolutionContext } from "./resolve.js";
import { assignWorker, type WorkerDraft } from "./workers.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T21:00:00.000Z";
const threshold = confidenceThreshold(pkg, "model-selection");
const above = threshold + (1 - threshold) / 2;
const below = threshold / 2;

function contextWith(configuration: Record<string, unknown>): ResolutionContext {
  const resolved = resolveConfiguration(configuration, pkg);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
  return { workflowPackage: pkg, configuration: resolved.configuration };
}

const CONFIGURED = contextWith({
  stageModels: { implement: { model: "worker-a", fallbackModel: "worker-b", efforts: ["low", "high"] } },
});

function project(): ProjectHarness {
  const h = createProjectHarness();
  harnesses.push(h);
  return h;
}

type Answer = readonly [choice: string, reason: string, confidence: number];

function jev(answer?: Answer): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    if (answer === undefined) return { status: 500, body: "no scripted answer" };
    const [choice, reason, confidence] = answer;
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          "model-selection": { type: "choice", choice, confidence },
          "model-selection.reason": { type: "choice", choice: reason, confidence },
        },
      }),
    };
  };
  return Object.assign(transport, { sent });
}

function dependencies(transport: JevTransport, context = CONFIGURED): DecisionDependencies {
  return {
    context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async () => undefined,
  };
}

const DRAFT: SelectionDraft = { stage: "implement", role: "implementer", ticketId: "T1", task: "add a date column to the CSV parser" };

const workersOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "workers");
  return read.kind === "present" ? read.record : { assignments: [] };
};

const worker = (overrides: Partial<WorkerDraft> = {}): WorkerDraft => ({
  stage: "implement",
  role: "implementer",
  agent: "worker-1",
  model: "worker-a",
  ticketId: "T1",
  ...overrides,
});

describe("model-selection recommends only from the stage's configured set", () => {
  it("asks Jev with the stage's options and the task, and returns the model and effort it recommends", async () => {
    const h = project();
    const transport = jev(["worker-a @ low", "lower-effort-suffices", above]);

    const result = await recommendModel(h.root, DRAFT, dependencies(transport));

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        kind: "recommended",
        recommendation: { model: "worker-a", effort: "low" },
        options: ["worker-a @ low", "worker-a @ high"],
        decision: { kind: "answered", route: "weigh", envelope: expect.stringMatching(/^ENV-/) },
      },
    });
    const body = JSON.parse(transport.sent[0]!.body) as { questions: Record<string, { criteria: Record<string, string> }>; state: unknown };
    expect(Object.keys(body.questions["model-selection"]!.criteria)).toEqual(["worker-a @ low", "worker-a @ high", "no-recommendation"]);
    expect(JSON.stringify(body.state)).toContain("add a date column to the CSV parser");
    expect(JSON.stringify(body.state)).not.toContain("worker-b");
    if (!result.ok || !("decision" in result.outcome) || result.outcome.decision.kind !== "answered") throw new Error("not answered");
    const read = readEnvelope(h.root, result.outcome.decision.envelope);
    expect(read.ok && read.envelope.decision).toBe("model-selection");
  });

  it("offers the fallback's options only when the host reported the configured model unavailable", async () => {
    const h = project();
    const transport = jev(["worker-b @ high", "needs-higher-effort", above]);

    const result = await recommendModel(
      h.root,
      { ...DRAFT, unavailable: { model: "worker-a", reason: "capacity" } },
      dependencies(transport),
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "recommended", recommendation: { model: "worker-b", effort: "high" }, options: ["worker-b @ low", "worker-b @ high"] },
    });
  });

  it("asks the developer and asks no one else when nothing is configured to run", async () => {
    const h = project();
    const transport = jev();

    const none = await recommendModel(h.root, DRAFT, dependencies(transport, contextWith({})));
    const noFallback = await recommendModel(
      h.root,
      { ...DRAFT, unavailable: { model: "worker-a", reason: "capacity" } },
      dependencies(transport, contextWith({ stageModels: { implement: { model: "worker-a", efforts: ["low"] } } })),
    );

    expect(none).toMatchObject({ ok: true, outcome: { askHuman: { kind: "human-ask" } } });
    expect(noFallback).toMatchObject({ ok: true, outcome: { askHuman: { kind: "human-ask" } } });
    expect(transport.sent).toHaveLength(0);
  });

  it("does not ask Jev when there is only one option", async () => {
    const h = project();
    const transport = jev();

    const result = await recommendModel(h.root, DRAFT, dependencies(transport, contextWith({ stageModels: { implement: { model: "worker-a" } } })));

    expect(result).toMatchObject({ ok: true, outcome: { kind: "single-option", options: ["worker-a"] } });
    expect(transport.sent).toHaveLength(0);
  });

  it("rejects a recommendation outside the configured set, records the rejection, and starts no worker", async () => {
    const h = project();

    const result = await recommendModel(h.root, DRAFT, dependencies(jev(["worker-z @ max", "fits-task", above])));

    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "rejected", answer: "worker-z @ max", options: ["worker-a @ low", "worker-a @ high"] },
    });
    expect(workersOf(h)).toMatchObject({
      assignments: [],
      rejections: [{ stage: "implement", role: "implementer", ticketId: "T1", answer: "worker-z @ max", options: ["worker-a @ low", "worker-a @ high"], rejectedAt: now }],
    });
    // A rejected recommendation is the workflow's call, not a Jev outage.
    expect(readRecord(h.root, "jev").kind).toBe("absent");
  });

  it("refuses a stage or role outside the workflow", async () => {
    const h = project();

    expect(await recommendModel(h.root, { ...DRAFT, stage: "deploy" }, dependencies(jev()))).toMatchObject({ ok: false });
    expect(await recommendModel(h.root, { ...DRAFT, role: "reviewer" }, dependencies(jev()))).toMatchObject({ ok: false });
    expect(await recommendModel(h.root, { ...DRAFT, task: " " }, dependencies(jev()))).toMatchObject({ ok: false });
  });
});

describe("assigning a worker on a recommendation", () => {
  async function recommended(h: ProjectHarness, answer: Answer = ["worker-a @ low", "lower-effort-suffices", above]): Promise<string> {
    const result = await recommendModel(h.root, DRAFT, dependencies(jev(answer)));
    if (!result.ok || !("decision" in result.outcome) || result.outcome.decision.kind !== "answered") throw new Error("not answered");
    return result.outcome.decision.envelope;
  }

  it("records following the recommendation on its envelope and the effort and envelope on the assignment", async () => {
    const h = project();
    const envelope = await recommended(h);

    const result = assignWorker(h.root, worker({ effort: "low", selection: { envelope } }), CONFIGURED, { now });

    expect(result).toMatchObject({ ok: true, outcome: { assignment: { model: "worker-a", effort: "low", selection: envelope } } });
    const read = readEnvelope(h.root, envelope);
    expect(read.ok && read.envelope.choice).toMatchObject({ action: "worker-a @ low", by: "agent", followsAnswer: true });
  });

  it("overrides the recommendation only with a reason and the evidence it rests on", async () => {
    const h = project();
    const envelope = await recommended(h);

    const bare = assignWorker(h.root, worker({ effort: "high", selection: { envelope, reason: "harder than it looks" } }), CONFIGURED, { now });
    const evidenced = assignWorker(
      h.root,
      worker({ effort: "high", selection: { envelope, reason: "the parser has three date formats", evidence: ["src/parser.ts:40-90"] } }),
      CONFIGURED,
      { now },
    );

    expect(bare).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
    expect(evidenced).toMatchObject({ ok: true, outcome: { assignment: { effort: "high" } } });
    const read = readEnvelope(h.root, envelope);
    expect(read.ok && read.envelope.choice).toMatchObject({ action: "worker-a @ high", by: "agent", followsAnswer: false });
  });

  it("leaves a below-threshold recommendation to the developer", async () => {
    const h = project();
    const envelope = await recommended(h, ["worker-a @ low", "fits-task", below]);

    const byAgent = assignWorker(h.root, worker({ effort: "low", selection: { envelope } }), CONFIGURED, { now });
    const byDeveloper = assignWorker(
      h.root,
      worker({ effort: "high", selection: { envelope, by: "developer", reason: "use high for parser work" } }),
      CONFIGURED,
      { now },
    );

    expect(byAgent).toMatchObject({ ok: false });
    expect(byDeveloper).toMatchObject({ ok: true });
  });

  it("refuses an effort the stage does not configure, and requires one where efforts are configured", () => {
    const h = project();

    expect(assignWorker(h.root, worker({ effort: "max" }), CONFIGURED, { now })).toMatchObject({ ok: false, reason: expect.stringContaining("low, high") });
    expect(assignWorker(h.root, worker(), CONFIGURED, { now })).toMatchObject({ ok: false, reason: expect.stringContaining("effort") });
    expect(assignWorker(h.root, worker({ effort: "low" }), contextWith({ stageModels: { implement: { model: "worker-a" } } }), { now })).toMatchObject({
      ok: false,
    });
    expect(workersOf(h).assignments).toEqual([]);
  });

  it("refuses a selection envelope that is not model-selection's, or that recorded another choice", async () => {
    const h = project();
    const envelope = await recommended(h);
    assignWorker(h.root, worker({ effort: "low", selection: { envelope } }), CONFIGURED, { now });

    const again = assignWorker(h.root, worker({ agent: "worker-2", ticketId: "T2", effort: "high", selection: { envelope } }), CONFIGURED, {
      now,
    });

    expect(again).toMatchObject({ ok: false });
    expect(assignWorker(h.root, worker({ ticketId: "T3", effort: "low", selection: { envelope: "ENV-nope" } }), CONFIGURED, { now })).toMatchObject({
      ok: false,
    });
  });

  it("refuses a selection asked for another ticket, and reuse of one already chosen", async () => {
    const h = project();
    const envelope = await recommended(h);

    const elsewhere = assignWorker(h.root, worker({ ticketId: "T9", effort: "low", selection: { envelope } }), CONFIGURED, { now });
    const first = assignWorker(h.root, worker({ effort: "low", selection: { envelope } }), CONFIGURED, { now });
    const reused = assignWorker(h.root, worker({ agent: "worker-2", effort: "low", selection: { envelope } }), CONFIGURED, { now });

    expect(elsewhere).toMatchObject({ ok: false, reason: expect.stringContaining("another assignment") });
    expect(first).toMatchObject({ ok: true });
    expect(reused).toMatchObject({ ok: false, reason: expect.stringContaining("already records") });
  });

  it("takes no selection when Jev made no recommendation, and needs no evidence to choose then", async () => {
    const h = project();
    const envelope = await recommended(h, ["no-recommendation", "insufficient-evidence", above]);

    expect(assignWorker(h.root, worker({ effort: "high", selection: { envelope } }), CONFIGURED, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("without selection"),
    });
    expect(assignWorker(h.root, worker({ effort: "high" }), CONFIGURED, { now })).toMatchObject({ ok: true });
  });

  it("writes neither the choice nor the worker when either is refused", async () => {
    const h = project();
    const envelope = await recommended(h);

    const unevidenced = assignWorker(h.root, worker({ effort: "high", selection: { envelope, reason: "harder" } }), CONFIGURED, { now });
    const badEffort = assignWorker(h.root, worker({ effort: "max", selection: { envelope } }), CONFIGURED, { now });

    expect(unevidenced).toMatchObject({ ok: false });
    expect(badEffort).toMatchObject({ ok: false });
    expect(workersOf(h).assignments).toEqual([]);
    const read = readEnvelope(h.root, envelope);
    expect(read.ok && read.envelope.choice).toBeUndefined();
  });

  it("still runs only the configured fallback when the model is unavailable", async () => {
    const h = project();
    const result = await recommendModel(
      h.root,
      { ...DRAFT, unavailable: { model: "worker-a", reason: "capacity" } },
      dependencies(jev(["worker-b @ low", "fits-task", above])),
    );
    if (!result.ok || !("decision" in result.outcome) || result.outcome.decision.kind !== "answered") throw new Error("not answered");
    const envelope = result.outcome.decision.envelope;

    const assigned = assignWorker(
      h.root,
      worker({ model: "worker-b", effort: "low", unavailable: { model: "worker-a", reason: "capacity" }, selection: { envelope } }),
      CONFIGURED,
      { now },
    );

    expect(assigned).toMatchObject({
      ok: true,
      outcome: { assignment: { model: "worker-b", effort: "low", substitution: { unavailableModel: "worker-a" } } },
    });
  });
});
