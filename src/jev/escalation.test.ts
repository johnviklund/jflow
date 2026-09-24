import { afterEach, describe, expect, it } from "vitest";

import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import type { JevTransport, TransportRequest } from "./client.js";
import { listEnvelopes, readEnvelope, rebuildJevRequest, recordChoice, type DecisionDependencies } from "./decisions.js";
import {
  askEscalation,
  BOUNDARY_KINDS,
  escalationOf,
  HARD_RULES,
  type Boundary,
  type EscalationResult,
} from "./escalation.js";
import { listTraces } from "./traces.js";

const harnesses: ProjectHarness[] = [];

function harness(): ProjectHarness {
  const created = createProjectHarness();
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-24T10:00:00.000Z";

/** Confidences on either side of the escalate threshold; its value is never asserted (D45). */
const threshold = confidenceThreshold(pkg, "escalate");
const above = threshold + (1 - threshold) / 2;
const below = threshold / 2;

function jevAnswering(
  choice: string,
  reason: string,
  confidence: number,
): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          escalate: { type: "choice", choice, confidence },
          "escalate.reason": { type: "choice", choice: reason, confidence },
        },
      }),
    };
  };
  return Object.assign(transport, { sent });
}

function dependencies(h: ProjectHarness, transport: JevTransport, overrides: Partial<DecisionDependencies> = {}): DecisionDependencies {
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    ...overrides,
  };
}

const fixFailed: Boundary = {
  kind: "fix-failed",
  summary: "T3's second fix attempt left one test failing",
  excerpts: [{ source: "npm test", text: "1 failed: parses an empty file" }],
};

function answered(result: EscalationResult): Extract<EscalationResult, { kind: "answered" }> {
  if (result.kind !== "answered") throw new Error(`expected an answer, got ${result.kind}`);
  return result;
}

describe("asking escalate at a human-facing boundary", () => {
  it("proceeds without a human ask on a confident proceed answer", async () => {
    const h = harness();

    const result = answered(await askEscalation(h.root, fixFailed, dependencies(h, jevAnswering("proceed", "routine", above))));

    expect(result.ask).toBe(false);
    expect(result).not.toHaveProperty("askHuman");
    expect(result.decision).toMatchObject({ kind: "answered", answer: "proceed", route: "act" });
  });

  it("asks the human on a confident escalate answer, carrying the boundary kind, reason code and confidence", async () => {
    const h = harness();

    const result = answered(
      await askEscalation(h.root, fixFailed, dependencies(h, jevAnswering("escalate", "consequential", above))),
    );

    expect(result.ask).toBe(true);
    expect(result.askHuman).toMatchObject({ kind: "human-ask", boundary: "fix-failed", reasonCode: "consequential", confidence: above });
    expect(result.askHuman?.reasons.join(" ")).toContain(fixFailed.summary);
  });

  it.each(["proceed", "escalate"])("routes a below-threshold %s answer to the human", async (choice) => {
    const h = harness();

    const result = answered(await askEscalation(h.root, fixFailed, dependencies(h, jevAnswering(choice, "uncertain", below))));

    expect(result.ask).toBe(true);
    expect(result.decision).toMatchObject({ route: "ask-human" });
    expect(result.askHuman).toMatchObject({ boundary: "fix-failed", confidence: below });
  });

  it.each(BOUNDARY_KINDS)("sends the %s boundary kind in the packet", async (kind) => {
    const h = harness();
    const transport = jevAnswering("proceed", "routine", above);

    await askEscalation(h.root, { ...fixFailed, kind }, dependencies(h, transport));

    expect(transport.sent[0]!.body).toContain(kind);
  });

  it("refuses an unknown boundary kind without calling Jev", async () => {
    const h = harness();
    const transport = jevAnswering("proceed", "routine", above);

    const result = await askEscalation(h.root, { ...fixFailed, kind: "whenever" }, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("whenever") });
    expect(transport.sent).toEqual([]);
  });
});

describe("hard rules never reach Jev", () => {
  it.each(HARD_RULES)("asks the developer at %s without consulting Jev", async (rule) => {
    const h = harness();
    const transport = jevAnswering("proceed", "routine", above);

    const result = await askEscalation(h.root, { ...fixFailed, kind: rule }, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "hard-rule", ask: true, askHuman: { kind: "human-ask", boundary: rule } });
    expect(transport.sent).toEqual([]);
    expect(listTraces(h.root)).toEqual([]);
    expect(listEnvelopes(h.root)).toEqual([]);
  });

  it("asks the developer when no key is configured, since continuing without Jev is theirs to approve", async () => {
    const h = harness();
    const transport = jevAnswering("proceed", "routine", above);

    const result = await askEscalation(
      h.root,
      fixFailed,
      dependencies(h, transport, {
        apiKey: { status: "missing", askHuman: "No Jev API key is configured.", mayProceedWithoutJev: false },
      }),
    );

    expect(result).toMatchObject({ kind: "needs-configuration", ask: true, askHuman: { boundary: "fix-failed" } });
    expect(transport.sent).toEqual([]);
  });

  it("asks the developer when Jev fails, never proceeding on its own", async () => {
    const h = harness();
    const failing: JevTransport = async () => ({ status: 500, body: "down" });

    const result = await askEscalation(h.root, fixFailed, dependencies(h, failing));

    expect(result).toMatchObject({ kind: "failed", ask: true, askHuman: { boundary: "fix-failed" } });
  });
});

describe("the escalation record", () => {
  it.each([
    ["proceed", above, false],
    ["escalate", above, true],
    ["proceed", below, true],
  ] as const)("records a %s answer at confidence %s as ask=%s, rebuildable from the envelope alone", async (choice, confidence, ask) => {
    const h = harness();
    const transport = jevAnswering(choice, "routine", confidence);

    const result = answered(await askEscalation(h.root, fixFailed, dependencies(h, transport)));

    const stored = readEnvelope(h.root, result.envelope);
    if (!stored.ok) throw new Error(stored.reason);
    expect(escalationOf(stored.envelope)).toEqual({ boundary: "fix-failed", ask });
    expect(rebuildJevRequest(stored.envelope)).toBe(transport.sent[0]!.body);
  });

  it("keeps the boundary kind when bounding cuts the packet down", async () => {
    const h = harness();
    const { configuration } = h.context;
    const tight = {
      ...h.context,
      configuration: { ...configuration, settings: { ...configuration.settings, "evidenceSharing.maxPacketChars": 40 } },
    };
    const long: Boundary = { ...fixFailed, summary: "x".repeat(500), excerpts: [{ source: "log", text: "y".repeat(500) }] };

    const result = answered(
      await askEscalation(h.root, long, dependencies(h, jevAnswering("escalate", "uncertain", above), { context: tight })),
    );

    const stored = readEnvelope(h.root, result.envelope);
    if (!stored.ok) throw new Error(stored.reason);
    expect(stored.envelope.request.packet.omitted).not.toEqual([]);
    expect(escalationOf(stored.envelope).boundary).toBe("fix-failed");
  });

  it("still reads as asked after the developer answers proceed", async () => {
    const h = harness();
    const result = answered(await askEscalation(h.root, fixFailed, dependencies(h, jevAnswering("proceed", "routine", below))));

    const chosen = recordChoice(
      h.root,
      result.envelope,
      { action: "proceed", by: "developer", reason: "go ahead" },
      ["proceed", "escalate"],
      { now },
    );

    if (!chosen.ok) throw new Error(chosen.reason);
    expect(escalationOf(chosen.envelope)).toEqual({ boundary: "fix-failed", ask: true });
  });

  it("records the workflow's no-ask choice on a confident proceed", async () => {
    const h = harness();

    const result = answered(await askEscalation(h.root, fixFailed, dependencies(h, jevAnswering("proceed", "routine", above))));

    expect(readEnvelope(h.root, result.envelope)).toMatchObject({
      ok: true,
      envelope: { choice: { action: "proceed", by: "workflow", followsAnswer: true } },
    });
  });

  it("gets past an escalate answer only with a recorded evidence-based reason", async () => {
    const h = harness();
    const result = answered(
      await askEscalation(h.root, fixFailed, dependencies(h, jevAnswering("escalate", "uncertain", above))),
    );
    const permitted = ["proceed", "escalate"];

    expect(recordChoice(h.root, result.envelope, { action: "proceed", by: "agent", reason: "looks fine" }, permitted, { now }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("evidence-based reason") });

    const overridden = recordChoice(
      h.root,
      result.envelope,
      { action: "proceed", by: "agent", reason: "the failure was a flaky test", evidence: ["npm test: all passed on rerun"] },
      permitted,
      { now },
    );
    expect(overridden).toMatchObject({ ok: true });
    if (!overridden.ok) return;
    expect(escalationOf(overridden.envelope)).toEqual({ boundary: "fix-failed", ask: false });
  });
});
