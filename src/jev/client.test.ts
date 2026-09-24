import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readWorkingTree } from "../project/worktree.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { askJev, JEV_ENDPOINT, loadDecisionQuestion, type JevTransport, type TransportRequest } from "./client.js";
import { buildEvidencePacket } from "./evidence.js";
import { cleanTraces, listTraces } from "./traces.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const KEY = "jev-test-key-0123456789";
const now = "2026-09-23T10:00:00.000Z";
const question = loadDecisionQuestion(loadShippedWorkflowPackage(), "escalate");
const evidence = buildEvidencePacket(
  { decision: "escalate", taskSummary: "T1's fix failed once", candidates: ["proceed", "escalate"], excerpts: [] },
  { excludeFullConversation: true, excludeFullRepository: true, maxPacketChars: 2000 },
);

/** A transport that records what it was sent and replies with a fixed response. */
function fakeTransport(status: number, body: unknown): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  };
  return Object.assign(transport, { sent });
}

const answered = {
  model: "jev-1.13",
  answers: {
    escalate: { type: "choice", choice: "escalate", probabilities: { proceed: 0.2, escalate: 0.8 }, confidence: 0.8 },
    "escalate.reason": { type: "choice", choice: "uncertain", confidence: 0.7 },
  },
  usage: { input_tokens: 10, output_tokens: 1 },
};

function configured(root: string, transport: JevTransport) {
  return {
    root,
    apiKey: { status: "configured" as const, source: "environment" as const, key: KEY },
    transport,
    timeoutMs: 30000,
    now: () => now,
  };
}

describe("askJev", () => {
  it("asks the developer how to configure a missing key, calling nothing and falling back to nothing", async () => {
    const h = harness();
    const transport = fakeTransport(200, answered);

    const result = await askJev(
      { question, evidence },
      {
        ...configured(h.root, transport),
        apiKey: { status: "missing", askHuman: "No Jev API key is configured.", mayProceedWithoutJev: false },
      },
    );

    expect(result).toEqual({
      kind: "needs-configuration",
      askHuman: "No Jev API key is configured.",
      mayProceedWithoutJev: false,
    });
    expect(transport.sent).toEqual([]);
    expect(listTraces(h.root)).toEqual([]);
  });

  it("sends the bounded packet as one typed question with the key only in the header", async () => {
    const h = harness();
    const transport = fakeTransport(200, answered);

    await askJev({ question, evidence }, configured(h.root, transport));

    expect(transport.sent).toHaveLength(1);
    const [request] = transport.sent;
    expect(request?.url).toBe(JEV_ENDPOINT);
    expect(request?.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(request?.body ?? "")).toEqual({
      model: "jev-latest",
      state: evidence,
      questions: {
        escalate: {
          type: "choice",
          instructions: question.prompt,
          criteria: { proceed: "proceed", escalate: "escalate" },
        },
        "escalate.reason": {
          type: "choice",
          instructions: expect.stringContaining("closed reason code"),
          criteria: Object.fromEntries(question.reasons.map((reason) => [reason, reason])),
        },
      },
    });
  });

  it("keeps the exact exchange in a local trace, outside version control and without the key", async () => {
    const h = harness({ gitRepository: true });
    const transport = fakeTransport(200, answered);

    const result = await askJev({ question, evidence }, configured(h.root, transport));

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    const trace = readFileSync(join(h.root, result.summary.traceReference), "utf8");
    expect(JSON.parse(trace)).toMatchObject({
      decision: "escalate",
      request: {
        url: JEV_ENDPOINT,
        headers: { Authorization: "Bearer [credential redacted]", "Content-Type": "application/json" },
        body: JSON.parse(transport.sent[0]!.body),
      },
      response: { status: 200, body: answered },
    });
    expect(trace).not.toContain(KEY);
    expect(readWorkingTree(h.root)).toEqual({ kind: "present", changedPaths: [] });
  });

  it("returns a portable summary: the answer, its confidence and a trace reference, no raw exchange", async () => {
    const h = harness();

    const result = await askJev({ question, evidence }, configured(h.root, fakeTransport(200, answered)));

    expect(result).toEqual({
      kind: "answered",
      summary: {
        decision: "escalate",
        questionVersion: question.version,
        questionStatus: question.status,
        model: "jev-1.13",
        answer: "escalate",
        reasonCode: "uncertain",
        confidence: 0.8,
        omittedEvidence: 0,
        answeredAt: now,
        traceReference: expect.stringMatching(/^\.jflow\/traces\/.+\.json$/),
      },
    });
  });

  it.each([
    [401, false],
    [422, false],
    [429, true],
    [529, true],
    [503, true],
  ])("reports HTTP %i as a failure, retryable: %s, with its trace kept", async (status, retryable) => {
    const h = harness();

    const result = await askJev({ question, evidence }, configured(h.root, fakeTransport(status, { error: "x" })));

    expect(result).toMatchObject({ kind: "failed", failure: { status, retryable } });
    expect(listTraces(h.root)).toHaveLength(1);
  });

  it("reports a timeout or network error as a retryable failure", async () => {
    const h = harness();
    const transport: JevTransport = async () => {
      throw new Error("The operation was aborted due to timeout");
    };

    const result = await askJev({ question, evidence }, configured(h.root, transport));

    expect(result).toMatchObject({ kind: "failed", failure: { retryable: true, error: expect.stringContaining("timeout") } });
  });

  it("reports a response without a usable answer as a failure rather than guessing", async () => {
    const h = harness();

    const result = await askJev(
      { question, evidence },
      configured(h.root, fakeTransport(200, { model: "jev", answers: { escalate: { type: "choice", choice: "maybe" } } })),
    );

    expect(result).toMatchObject({ kind: "failed", failure: { retryable: false, error: expect.stringContaining("maybe") } });
  });

  it("reports an answer without a code from the closed reason set as a failure", async () => {
    const h = harness();
    const unexplained = { ...answered, answers: { escalate: answered.answers.escalate, "escalate.reason": { choice: "vibes" } } };

    const result = await askJev({ question, evidence }, configured(h.root, fakeTransport(200, unexplained)));

    expect(result).toMatchObject({ kind: "failed", failure: { retryable: false, error: expect.stringContaining("vibes") } });
  });
});

describe("askJev's own guards", () => {
  it("strips the key from evidence even when the caller forgot to name it", async () => {
    const h = harness();
    const transport = fakeTransport(200, answered);
    const leaky = { ...evidence, taskSummary: `configured with ${KEY}` };

    await askJev({ question, evidence: leaky }, configured(h.root, transport));

    expect(transport.sent[0]?.body).not.toContain(KEY);
  });

  it("keeps a trace of a request that failed in transit, without the key in the error", async () => {
    const h = harness();
    const transport: JevTransport = async () => {
      throw new Error(`connect failed for ${KEY}`);
    };

    const result = await askJev({ question, evidence }, configured(h.root, transport));

    expect(result.kind).toBe("failed");
    const [reference] = listTraces(h.root);
    const trace = readFileSync(join(h.root, reference!), "utf8");
    expect(trace).toContain("connect failed");
    expect(trace).not.toContain(KEY);
  });

  it("restores the trace directory's ignore-everything rule if it was changed", async () => {
    const h = harness({ gitRepository: true });
    h.writeFile(".jflow/.gitignore", "!traces/\n");

    await askJev({ question, evidence }, configured(h.root, fakeTransport(200, answered)));

    expect(readFileSync(join(h.root, ".jflow/.gitignore"), "utf8")).toBe("*\n");
    expect(readWorkingTree(h.root)).toEqual({ kind: "present", changedPaths: [] });
  });
});

describe("traces", () => {
  it("are never deleted except by an explicit cleanup, which leaves the project records readable", async () => {
    const h = harness({ state: { specificationAccepted: true } });
    const before = h.readState();
    await askJev({ question, evidence }, configured(h.root, fakeTransport(200, answered)));
    await askJev({ question, evidence }, configured(h.root, fakeTransport(200, answered)));
    expect(listTraces(h.root)).toHaveLength(2);

    const cleaned = cleanTraces(h.root);

    expect(cleaned.removed).toHaveLength(2);
    expect(listTraces(h.root)).toEqual([]);
    expect(h.readState()).toEqual(before);
    expect(Object.keys(h.snapshot()).filter((path) => path.startsWith("jflow/"))).toEqual(["jflow/progress.json", "jflow/specification.json"]);
  });
});
