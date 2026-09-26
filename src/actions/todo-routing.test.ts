import { afterEach, describe, expect, it } from "vitest";

import type { JevTransport, TransportRequest } from "../jev/client.js";
import { permittedChoices, readEnvelope, recordChoice, type DecisionDependencies } from "../jev/decisions.js";
import { readRecord, writeRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { recordTodo, routeItem } from "./todo.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-26T11:00:00.000Z";
const threshold = confidenceThreshold(pkg, "classify");
const above = threshold + (1 - threshold) / 2;

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
          classify: { type: "choice", choice, confidence },
          "classify.reason": { type: "choice", choice: reason, confidence },
        },
      }),
    };
  };
  return Object.assign(transport, { sent });
}

/** Mid-implementation of T1, whose criteria the routing is weighed against. */
function project(): ProjectHarness {
  const h = createProjectHarness({
    state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1", ticketChangesPresent: true },
    gitRepository: true,
  });
  harnesses.push(h);
  writeRecord(h.root, "tickets", {
    tickets: [{ id: "T1", title: "CSV export", acceptanceCriteria: ["exported rows keep their header"], dependsOn: [], status: "in-progress" }],
  });
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

const ITEM = { summary: "the export button is misaligned on narrow screens", detail: "seen at 360px" };

const todosOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "todos");
  return read.kind === "present" ? read.record.items : [];
};

describe("routing a discovered item through classify", () => {
  it("asks classify with content kind item-routing over the item and the current ticket's criteria", async () => {
    const h = project();
    const transport = jev(["todo", "clear-match", above]);

    const result = await routeItem(h.root, ITEM, dependencies(h, transport));

    expect(result).toMatchObject({ ok: true, outcome: { kind: "answered", contentKind: "item-routing", answer: "todo", route: "weigh" } });
    expect(transport.sent[0]!.body).toContain("Content: item-routing.");
    expect(transport.sent[0]!.body).toContain("exported rows keep their header");
    expect(transport.sent[0]!.body).toContain("seen at 360px");
    expect(todosOf(h)).toEqual([]);
  });

  it("records the item with the answer it was weighed against, and the agent's choice on the envelope", async () => {
    const h = project();
    const routed = await routeItem(h.root, ITEM, dependencies(h, jev(["todo", "clear-match", above])));
    if (!routed.ok || routed.outcome.kind !== "answered") throw new Error("not answered");
    const { envelope } = routed.outcome;

    const recorded = recordTodo(h.root, { ...ITEM, routing: { envelope } }, { now });

    expect(recorded).toMatchObject({ ok: true, outcome: { item: { id: "TODO-1", routing: { envelope, answer: "todo" }, status: "open" } } });
    const read = readEnvelope(h.root, envelope);
    expect(read.ok && read.envelope.choice).toMatchObject({ action: "todo", by: "agent", followsAnswer: true });
  });

  it("records a todo against an in-scope answer only with a reason and evidence", async () => {
    const h = project();
    const routed = await routeItem(h.root, ITEM, dependencies(h, jev(["in-scope", "clear-match", above])));
    if (!routed.ok || routed.outcome.kind !== "answered") throw new Error("not answered");
    const { envelope } = routed.outcome;

    const bare = recordTodo(h.root, { ...ITEM, routing: { envelope, reason: "different screen" } }, { now });
    const evidenced = recordTodo(
      h.root,
      { ...ITEM, routing: { envelope, reason: "T1's criteria say nothing about layout", evidence: ["jflow/tickets.json#T1"] } },
      { now },
    );

    expect(bare).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
    expect(todosOf(h)).toHaveLength(1);
    expect(evidenced).toMatchObject({ ok: true });
  });

  it("records keeping an item in scope as the choice on the envelope, which records no todo and authorizes nothing", async () => {
    const h = project();
    const state = h.readState();
    const routed = await routeItem(h.root, ITEM, dependencies(h, jev(["in-scope", "clear-match", above])));
    if (!routed.ok || routed.outcome.kind !== "answered") throw new Error("not answered");

    const chosen = recordChoice(h.root, routed.outcome.envelope, { action: "in-scope", by: "agent" }, permittedChoices(h.root, "classify", h.context), {
      now,
    });

    expect(chosen).toMatchObject({ ok: true, envelope: { choice: { action: "in-scope", followsAnswer: true } } });
    expect(todosOf(h)).toEqual([]);
    expect(h.readState()).toEqual(state);
  });

  it("refuses routing an item against an envelope that is not an item-routing classification of it", async () => {
    const h = project();
    const routed = await routeItem(h.root, ITEM, dependencies(h, jev(["todo", "clear-match", above])));
    if (!routed.ok || routed.outcome.kind !== "answered") throw new Error("not answered");

    expect(recordTodo(h.root, { summary: "a different item", routing: { envelope: routed.outcome.envelope } }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another item"),
    });

    expect(recordTodo(h.root, { ...ITEM, routing: { envelope: "ENV-nope" } }, { now })).toMatchObject({ ok: false });
    expect(todosOf(h)).toEqual([]);
  });
});
