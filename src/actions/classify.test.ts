import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JevTransport, TransportRequest } from "../jev/client.js";
import { readEnvelope, type DecisionDependencies } from "../jev/decisions.js";
import { listTraces } from "../jev/traces.js";
import { readRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { classifyContent, contentKindOf } from "./classify.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-26T09:00:00.000Z";
const threshold = confidenceThreshold(pkg, "classify");
const above = threshold + (1 - threshold) / 2;

type Answer = readonly [choice: string, reason: string, confidence: number];

/** A Jev answering classify by the content kind the request carries. */
function classifyJev(
  answers: Partial<Record<string, Answer>>,
): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    const kind = /Content: ([a-z-]+)\./.exec(request.body)?.[1] ?? decision;
    const answer = answers[kind] ?? answers[decision];
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
  return Object.assign(transport, { sent });
}

function project(): ProjectHarness {
  const h = createProjectHarness();
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

const choicesSent = (request: TransportRequest) =>
  Object.keys((JSON.parse(request.body) as { questions: Record<string, { criteria: object }> }).questions["classify"]!.criteria);

describe("classify: one advisory question, three content kinds", () => {
  it("offers each content kind its own choices, and records the kind, reason code and confidence in the envelope", async () => {
    const h = project();
    const transport = classifyJev({
      "item-routing": ["todo", "clear-match", above],
      testability: ["untestable", "clear-match", above],
      "lesson-scope": ["src/parser", "clear-match", above],
    });

    const routing = await classifyContent(h.root, { kind: "item-routing", summary: "the export button is misaligned", excerpts: [] }, dependencies(h, transport));
    const testability = await classifyContent(h.root, { kind: "testability", summary: "the parser feels fast", excerpts: [] }, dependencies(h, transport));
    const scope = await classifyContent(
      h.root,
      { kind: "lesson-scope", summary: "reset the fixture clock", excerpts: [], scopes: ["src/parser", "src"] },
      dependencies(h, transport),
    );

    expect(transport.sent.map(choicesSent)).toEqual([
      ["todo", "in-scope"],
      ["testable", "untestable"],
      ["src/parser", "src", "unclear"],
    ]);
    expect(routing).toMatchObject({ ok: true, outcome: { kind: "answered", answer: "todo", route: "weigh", reasonCode: "clear-match" } });
    expect(testability).toMatchObject({ ok: true, outcome: { answer: "untestable" } });
    expect(scope).toMatchObject({ ok: true, outcome: { answer: "src/parser" } });
    if (!routing.ok || routing.outcome.kind !== "answered") throw new Error("not answered");
    const read = readEnvelope(h.root, routing.outcome.envelope);
    if (!read.ok) throw new Error(read.reason);
    expect(contentKindOf(read.envelope)).toBe("item-routing");
    expect(read.envelope.answer).toMatchObject({ reasonCode: "clear-match", confidence: above });
  });

  it("refuses a review finding, or any other kind, without asking Jev, and records the attempt", async () => {
    const h = project();
    const transport = classifyJev({});
    const traces = listTraces(h.root).length;

    const result = await classifyContent(
      h.root,
      { kind: "review-finding", summary: "the error line is off by one", excerpts: [] },
      dependencies(h, transport),
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("review finding") });
    expect(transport.sent).toHaveLength(0);
    const recorded = listTraces(h.root);
    expect(recorded.length).toBe(traces + 1);
    expect(readFileSync(join(h.root, recorded.at(-1)!), "utf8")).toContain("review-finding");
    expect(readRecord(h.root, "jev").kind).toBe("absent");
  });

  it("needs at least one candidate scope for lesson-scope, and a summary for any kind", async () => {
    const h = project();
    const transport = classifyJev({});

    expect(await classifyContent(h.root, { kind: "lesson-scope", summary: "s", excerpts: [], scopes: [] }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(await classifyContent(h.root, { kind: "testability", summary: " ", excerpts: [] }, dependencies(h, transport))).toMatchObject({ ok: false });
    expect(transport.sent).toHaveLength(0);
  });

  it("reports an answer outside the kind's choices as unlisted, not as a Jev outage", async () => {
    const h = project();

    const result = await classifyContent(
      h.root,
      { kind: "testability", summary: "c", excerpts: [] },
      dependencies(h, classifyJev({ testability: ["todo", "clear-match", above] })),
    );

    expect(result).toMatchObject({ ok: true, outcome: { kind: "unlisted", answer: "todo" } });
    expect(readRecord(h.root, "jev").kind).toBe("absent");
  });
});
