import { afterEach, describe, expect, it } from "vitest";

import { runStatus } from "../actions/status.js";
import { resolveConfiguration } from "../config/configuration.js";
import { readRecord, writeRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { assessWithoutJev } from "./assessment.js";
import { loadDecisionQuestion, type JevTransport, type TransportRequest } from "./client.js";
import { askDecision, type DecisionDependencies } from "./decisions.js";
import { approveFallback } from "./fallback.js";
import type { ResolutionContext } from "../actions/resolve.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T18:00:00.000Z";

function contextWith(settings: Record<string, unknown>): ResolutionContext {
  const resolved = resolveConfiguration({ settings }, pkg);
  if (!resolved.ok) throw new Error("configuration");
  return { workflowPackage: pkg, configuration: resolved.configuration };
}

/** T1 in progress under ticket authorization. */
function project(): ProjectHarness {
  const h = createProjectHarness({
    state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
  });
  harnesses.push(h);
  return h;
}

type Reply = { readonly status: number; readonly body?: string } | "throw";

const REASON: Record<string, string> = { "next-action": "prerequisites-met", "lesson-retention": "evidence-backed", escalate: "routine" };

const ANSWER = (decision: string, choice: string, confidence: number) => ({
  status: 200,
  body: JSON.stringify({
    model: "jev-1.13",
    answers: {
      [decision]: { type: "choice", choice, confidence },
      [`${decision}.reason`]: { type: "choice", choice: REASON[decision], confidence },
    },
  }),
});

/** Replies from a script, one per call; the last reply repeats. */
function jev(...replies: Reply[]): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply === "throw") throw new Error("The operation was aborted due to timeout");
    return { status: reply.status, body: reply.body ?? "{}" };
  };
  return Object.assign(transport, { sent });
}

function dependencies(
  h: ProjectHarness,
  transport: JevTransport,
  overrides: Partial<DecisionDependencies> = {},
): DecisionDependencies & { readonly slept: number[] } {
  const slept: number[] = [];
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    ...overrides,
    slept,
  };
}

const input = { taskSummary: "which action is next", candidates: ["implement", "status"], excerpts: [] };
const ask = (h: ProjectHarness, deps: DecisionDependencies) => askDecision(h.root, "next-action", input, deps);
const jevRecord = (h: ProjectHarness) => {
  const read = readRecord(h.root, "jev");
  return read.kind === "present" ? read.record : undefined;
};
const above = (decision: string) => confidenceThreshold(pkg, decision) + (1 - confidenceThreshold(pkg, decision)) / 2;
const below = (decision: string) => confidenceThreshold(pkg, decision) / 2;

describe("retrying a temporary Jev failure", () => {
  it("retries with growing backoff and a finite timeout, then uses the answer", async () => {
    const h = project();
    const transport = jev({ status: 503 }, "throw", ANSWER("next-action", "implement", above("next-action")));
    const deps = dependencies(h, transport);

    const result = await ask(h, deps);

    expect(result).toMatchObject({ kind: "answered" });
    expect(transport.sent).toHaveLength(3);
    expect(transport.sent.every((request) => request.timeoutMs === 30000)).toBe(true);
    expect(deps.slept).toHaveLength(2);
    expect(deps.slept[1]!).toBeGreaterThan(deps.slept[0]!);
  });

  it("retries the configured number of times, and that count leaves the fix-retry limit alone", async () => {
    const h = project();
    const context = contextWith({ "jev.retryCount": 4 });
    const transport = jev({ status: 429 });

    const result = await ask(h, dependencies(h, transport, { context }));

    expect(result).toMatchObject({ kind: "failed", attempts: 5 });
    expect(transport.sent).toHaveLength(5);
    expect(context.configuration.settings["review.fixRetryLimit"]).toBe(2);
    expect(contextWith({ "review.fixRetryLimit": 4 }).configuration.settings["jev.retryCount"]).toBe(2);
  });

  it.each([
    ["an authentication error", 401],
    ["a forbidden key", 403],
    ["an invalid request", 400],
  ])("surfaces %s at once, without retrying", async (_label, status) => {
    const h = project();
    const transport = jev({ status });
    const deps = dependencies(h, transport);

    expect(await ask(h, deps)).toMatchObject({ kind: "failed", attempts: 1, failure: { status } });
    expect(transport.sent).toHaveLength(1);
    expect(deps.slept).toEqual([]);
  });
});

describe("continuing without Jev", () => {
  it("asks the developer once retries are exhausted, keeping the pending decision", async () => {
    const h = project();

    const result = await ask(h, dependencies(h, jev({ status: 503 })));

    expect(result).toMatchObject({ kind: "failed", attempts: 3, fallback: "awaiting-approval" });
    expect(jevRecord(h)).toMatchObject({
      fallback: { status: "awaiting-approval", pendingDecision: "next-action", reason: expect.stringContaining("503") },
      history: [{ status: "awaiting-approval", at: now }],
    });
  });

  it("records the developer's approval for the current ticket only, unless they broaden it", async () => {
    const h = project();
    await ask(h, dependencies(h, jev({ status: 503 })));

    expect(approveFallback(h.root, { scope: "ticket", note: "go on without it for T1" }, { now })).toMatchObject({
      ok: true,
      outcome: { fallback: { status: "approved", scope: "ticket", scopeId: "T1", approvalNote: "go on without it for T1" } },
    });
    expect(await ask(h, dependencies(h, jev({ status: 503 })))).toMatchObject({ kind: "failed", fallback: "approved" });

    const progress = readRecord(h.root, "progress");
    if (progress.kind !== "present") throw new Error("progress");
    writeRecord(h.root, "progress", { ...progress.record, assignedTicketId: "T2" });
    expect(await ask(h, dependencies(h, jev({ status: 503 })))).toMatchObject({ kind: "failed", fallback: "awaiting-approval" });
  });

  it("applies a stage approval to that stage only, and the whole plan only when broadened", async () => {
    const h = project();
    await ask(h, dependencies(h, jev({ status: 503 })));
    approveFallback(h.root, { scope: "stage", stage: "implement", note: "implement may go on" }, { now });

    expect(await ask(h, dependencies(h, jev({ status: 503 }), { stage: "implement" }))).toMatchObject({ fallback: "approved" });
    expect(await ask(h, dependencies(h, jev({ status: 503 }), { stage: "review" }))).toMatchObject({ fallback: "awaiting-approval" });

    approveFallback(h.root, { scope: "plan", note: "the whole plan may go on without Jev" }, { now });
    expect(await ask(h, dependencies(h, jev({ status: 503 }), { stage: "review" }))).toMatchObject({ fallback: "approved" });
  });

  it("refuses an approval nobody is waiting for, one without the developer's words, or one with nothing to scope to", async () => {
    const h = project();

    expect(approveFallback(h.root, { scope: "ticket", note: "ok" }, { now })).toMatchObject({ ok: false });
    await ask(h, dependencies(h, jev({ status: 503 })));
    expect(approveFallback(h.root, { scope: "ticket", note: " " }, { now })).toMatchObject({ ok: false });
    expect(approveFallback(h.root, { scope: "stage", note: "ok" }, { now })).toMatchObject({ ok: false });
    expect(approveFallback(h.root, { scope: "stage", stage: "status", note: "ok" }, { now })).toMatchObject({ ok: false });
  });

  it("shows the fallback in status output", async () => {
    const h = project();
    await ask(h, dependencies(h, jev({ status: 503 })));

    expect(runStatus(h.root, h.context)).toMatchObject({
      jev: { fallback: { status: "awaiting-approval", pendingDecision: "next-action" } },
    });
  });

  it("resumes normal use at the next decision after recovery, and records the change", async () => {
    const h = project();
    await ask(h, dependencies(h, jev({ status: 503 })));
    approveFallback(h.root, { scope: "ticket", note: "go on" }, { now });

    expect(await ask(h, dependencies(h, jev(ANSWER("next-action", "implement", above("next-action")))))).toMatchObject({
      kind: "answered",
    });

    expect(jevRecord(h)).toMatchObject({
      fallback: { status: "off" },
      history: [{ status: "awaiting-approval" }, { status: "approved" }, { status: "off", note: expect.stringContaining("recovered") }],
    });
  });
});

describe("the primary agent's own assessment", () => {
  const ASSESSED = {
    assessment: "the records recommend implement and nothing blocks it",
    evidence: ["jflow status: implement eligible"],
    resolution: "implement",
  };

  it("records an assessment of an unusable answer once continuing without Jev is approved", async () => {
    const h = project();
    const failed = await ask(h, dependencies(h, jev({ status: 503 })));
    if (failed.kind !== "failed") throw new Error("expected a failure");

    expect(assessWithoutJev(h.root, { decision: "next-action", traceReference: failed.failure.traceReference, ...ASSESSED, consequential: false }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("approv"),
    });

    approveFallback(h.root, { scope: "ticket", note: "go on" }, { now });
    expect(
      assessWithoutJev(h.root, { decision: "next-action", traceReference: failed.failure.traceReference, ...ASSESSED, consequential: false }, { now }),
    ).toMatchObject({ ok: true, outcome: { assessment: { id: "A-1", status: "resolved", resolution: "implement" } } });
    expect(jevRecord(h)?.assessments).toHaveLength(1);
  });

  it("takes only the failure on record, and keeps a binding decision without an answer the developer's", async () => {
    const h = project();
    const failed = await askDecision(
      h.root,
      "escalate",
      { taskSummary: "Boundary: other. x", candidates: [], excerpts: [] },
      dependencies(h, jev({ status: 503 })),
    );
    if (failed.kind !== "failed") throw new Error("expected a failure");
    approveFallback(h.root, { scope: "ticket", note: "go on" }, { now });

    expect(
      assessWithoutJev(h.root, { decision: "escalate", traceReference: "traces/made-up.json", ...ASSESSED, resolution: "proceed", consequential: false }, { now }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("on record") });
    expect(
      assessWithoutJev(
        h.root,
        { decision: "escalate", traceReference: failed.failure.traceReference, ...ASSESSED, resolution: "proceed", consequential: false },
        { now },
      ),
    ).toMatchObject({ ok: true, outcome: { assessment: { status: "escalated" }, askHuman: expect.anything() } });
  });

  it("counts an answer to unaccepted wording as unusable, whatever its confidence", async () => {
    const h = project();
    const skeleton = (decision: string) => ({ ...loadDecisionQuestion(pkg, decision), status: "skeleton" as const });
    const answered = await askDecision(
      h.root,
      "lesson-retention",
      input,
      dependencies(h, jev(ANSWER("lesson-retention", "retain", above("lesson-retention"))), { readQuestion: skeleton }),
    );
    if (answered.kind !== "answered") throw new Error("expected an answer");

    expect(
      assessWithoutJev(
        h.root,
        { decision: "lesson-retention", envelope: answered.envelope.id, ...ASSESSED, resolution: "retain", consequential: false },
        { now },
      ),
    ).toMatchObject({ ok: true, outcome: { assessment: { status: "resolved" } } });
  });

  it("escalates a consequential case to the developer", async () => {
    const h = project();
    const failed = await ask(h, dependencies(h, jev({ status: 503 })));
    if (failed.kind !== "failed") throw new Error("expected a failure");
    approveFallback(h.root, { scope: "ticket", note: "go on" }, { now });

    expect(
      assessWithoutJev(h.root, { decision: "next-action", traceReference: failed.failure.traceReference, ...ASSESSED, consequential: true }, { now }),
    ).toMatchObject({ ok: true, outcome: { assessment: { status: "escalated" }, askHuman: expect.anything() } });
  });

  it("records an assessment of an uncertain answer; below the threshold a binding decision stays the developer's", async () => {
    const h = project();
    const advisory = await askDecision(h.root, "lesson-retention", input, dependencies(h, jev(ANSWER("lesson-retention", "retain", below("lesson-retention")))));
    const binding = await askDecision(
      h.root,
      "escalate",
      { taskSummary: "Boundary: other. x", candidates: [], excerpts: [] },
      dependencies(h, jev(ANSWER("escalate", "proceed", below("escalate")))),
    );
    if (advisory.kind !== "answered" || binding.kind !== "answered") throw new Error("expected answers");

    expect(
      assessWithoutJev(h.root, { decision: "lesson-retention", envelope: advisory.envelope.id, ...ASSESSED, resolution: "retain", consequential: false }, { now }),
    ).toMatchObject({ ok: true, outcome: { assessment: { status: "resolved" } } });
    expect(
      assessWithoutJev(h.root, { decision: "escalate", envelope: binding.envelope.id, ...ASSESSED, resolution: "proceed", consequential: false }, { now }),
    ).toMatchObject({ ok: true, outcome: { assessment: { status: "escalated" }, askHuman: expect.anything() } });
  });

  it("refuses an assessment without evidence, or of an answer that was usable", async () => {
    const h = project();
    const sure = await askDecision(h.root, "lesson-retention", input, dependencies(h, jev(ANSWER("lesson-retention", "retain", above("lesson-retention")))));
    if (sure.kind !== "answered") throw new Error("expected an answer");

    expect(assessWithoutJev(h.root, { decision: "lesson-retention", envelope: sure.envelope.id, ...ASSESSED, consequential: false }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("usable"),
    });
    expect(
      assessWithoutJev(h.root, { decision: "lesson-retention", envelope: sure.envelope.id, ...ASSESSED, evidence: [], consequential: false }, { now }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
  });
});
