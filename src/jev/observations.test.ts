import { afterEach, describe, expect, it } from "vitest";

import { fixLimit } from "../actions/implement.js";
import { writeRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import type { JevTransport, TransportRequest } from "./client.js";
import { askDecision, recordChoice, type DecisionDependencies } from "./decisions.js";
import { askEscalation } from "./escalation.js";
import { findPatterns, readObservations, RECURRENCE_MINIMUM } from "./observations.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-26T09:00:00.000Z";
const threshold = confidenceThreshold(pkg, "escalate");
const above = threshold + (1 - threshold) / 2;
const below = threshold / 2;

type Answer = readonly [choice: string, reason: string, confidence: number];

/** A Jev that answers by what the request body contains; the first matching rule wins, and no match is an HTTP 500. */
function jev(rules: readonly (readonly [needle: string, answer: Answer])[]): JevTransport {
  return async (request: TransportRequest) => {
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    const answer = rules.find(([needle]) => request.body.includes(needle))?.[1];
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

function project(): ProjectHarness {
  const h = createProjectHarness();
  harnesses.push(h);
  return h;
}

describe("harness observations", () => {
  it("are read from the stored envelopes, traces and records, one per thing that happened", async () => {
    const h = project();
    const deps = dependencies(
      h,
      jev([
        ["parser", ["escalate", "uncertain", above]],
        ["lexer", ["proceed", "routine", below]],
        ["next-action", ["plan", "prerequisites-met", above]],
      ]),
    );
    await askEscalation(h.root, { kind: "fix-failed", summary: "T1 parser fix failed", excerpts: [] }, deps);
    await askEscalation(h.root, { kind: "fix-failed", summary: "T2 lexer fix failed", excerpts: [] }, deps);
    const advised = await askDecision(h.root, "next-action", { taskSummary: "next-action", candidates: [], excerpts: [] }, deps);
    if (advised.kind !== "answered") throw new Error("next-action was not answered");
    recordChoice(h.root, advised.envelope.id, { action: "brainstorm", by: "agent", reason: "no spec yet", evidence: ["status"] }, ["plan", "brainstorm"], { now });
    await askEscalation(h.root, { kind: "other", summary: "nothing scripted for this one", excerpts: [] }, { ...deps, sleep: async () => undefined });
    const limit = fixLimit(h.context);
    writeRecord(h.root, "progress", { executionAuthorized: false, ticketChangesPresent: false, fixAttempts: { T1: limit, T2: limit - 1 } });

    const view = readObservations(h.root, h.context);

    expect(view.unreadable).toEqual([]);
    const summary = view.observations.map(({ kind, decision, where, reasonCode, ticket }) => ({ kind, decision, where, reasonCode, ticket }));
    expect(summary).toEqual(
      expect.arrayContaining([
        { kind: "escalation", decision: "escalate", where: "fix-failed", reasonCode: "uncertain", ticket: undefined },
        { kind: "low-confidence", decision: "escalate", where: "fix-failed", reasonCode: "routine", ticket: undefined },
        { kind: "override", decision: "next-action", where: "all", reasonCode: "prerequisites-met", ticket: undefined },
        { kind: "jev-failure", decision: "escalate", where: undefined, reasonCode: undefined, ticket: undefined },
        { kind: "fix-limit", decision: undefined, where: undefined, reasonCode: undefined, ticket: "T1" },
      ]),
    );
    // A retried failure is one observation per call Jev did not answer; nothing is filtered.
    expect(view.observations.filter((observation) => observation.kind === "jev-failure").length).toBeGreaterThanOrEqual(1);
    expect(view.observations.filter((observation) => observation.kind === "fix-limit")).toHaveLength(1);
    expect(new Set(view.observations.map((observation) => observation.id)).size).toBe(view.observations.length);
  });

  it("are a view, not a store: reading them writes nothing", async () => {
    const h = project();
    await askEscalation(h.root, { kind: "fix-failed", summary: "parser", excerpts: [] }, dependencies(h, jev([["parser", ["escalate", "uncertain", above]]])));
    const before = h.snapshot();

    const first = readObservations(h.root, h.context);
    const second = readObservations(h.root, h.context);

    expect(h.snapshot()).toEqual(before);
    expect(second).toEqual(first);
  });

  it("list what they cannot read instead of dropping it silently", () => {
    const h = project();
    h.writeFile(".jflow/envelopes/ENV-0-escalate-broken.json", "{ not json");

    expect(readObservations(h.root, h.context).unreadable).toEqual([expect.objectContaining({ source: expect.stringContaining("ENV-0-escalate-broken") })]);
  });
});

describe("recurring observation patterns", () => {
  it("group observations of one kind, decision, place and reason code that recur, linking each observation", async () => {
    const h = project();
    const deps = dependencies(h, jev([["fix", ["escalate", "uncertain", above]], ["next", ["escalate", "consequential", above]]]));
    for (let n = 0; n < RECURRENCE_MINIMUM; n += 1) {
      await askEscalation(h.root, { kind: "fix-failed", summary: `T${n} fix failed`, excerpts: [] }, deps);
    }
    await askEscalation(h.root, { kind: "next-ticket", summary: "next ticket", excerpts: [] }, deps);
    const { observations } = readObservations(h.root, h.context);

    const patterns = findPatterns(observations);

    expect(patterns).toEqual([
      expect.objectContaining({
        kind: "escalation",
        decision: "escalate",
        where: "fix-failed",
        reasonCode: "uncertain",
        count: RECURRENCE_MINIMUM,
        suggests: expect.arrayContaining([{ change: "threshold", for: "fix-failed" }, { change: "question" }]),
      }),
    ]);
    expect(patterns[0]!.observations).toHaveLength(RECURRENCE_MINIMUM);
    expect(patterns[0]!.observations.every((id) => observations.some((observation) => observation.id === id))).toBe(true);
  });
});
