import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import type { JevTransport, TransportRequest } from "../jev/client.js";
import { recordChoice, type DecisionDependencies } from "../jev/decisions.js";
import { readRecord, writeRecord, type ProgressRecord, type TicketRecord } from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { startTicket } from "./implement.js";
import { nextTicket, parkTicket, recordIndependence, type IndependenceInput } from "./progression.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-25T15:00:00.000Z";

const ticket = (id: string, status: TicketRecord["status"], dependsOn: string[] = [], extra: Partial<TicketRecord> = {}): TicketRecord => ({
  id,
  title: `Ticket ${id}`,
  acceptanceCriteria: [`${id} works`],
  dependsOn,
  status,
  ...extra,
});

const WHOLE_PLAN: ProgressRecord = {
  executionAuthorized: true,
  authorizationScope: "plan",
  authorizationNote: "implement the whole plan",
  ticketChangesPresent: false,
};

/** T1 done; T2 and T3 ready and independent; T4 waits on T2. */
function project(
  tickets: readonly TicketRecord[] = [ticket("T1", "done"), ticket("T2", "ready"), ticket("T3", "ready"), ticket("T4", "ready", ["T2"])],
  progress: ProgressRecord = WHOLE_PLAN,
): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
  harnesses.push(h);
  h.writeFile("README.md", "readme\n");
  execFileSync("git", ["add", "README.md"], { cwd: h.root });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: h.root });
  writeRecord(h.root, "tickets", { tickets });
  writeRecord(h.root, "progress", progress);
  return h;
}

type Answer = readonly [choice: string, reason: string];

/** A Jev answering `escalate` from a queue. */
function jev(...answers: Answer[]): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const answer = answers.shift();
    if (answer === undefined) return { status: 500, body: "no scripted answer" };
    const threshold = confidenceThreshold(loadShippedWorkflowPackage(), "escalate");
    const confidence = threshold + (1 - threshold) / 2;
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          escalate: { type: "choice", choice: answer[0], confidence },
          "escalate.reason": { type: "choice", choice: answer[1], confidence },
        },
      }),
    };
  };
  return Object.assign(transport, { sent });
}
const PROCEED: Answer = ["proceed", "routine"];
const ESCALATE: Answer = ["escalate", "uncertain"];

function dependencies(h: ProjectHarness, transport: JevTransport): DecisionDependencies {
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async () => undefined,
  };
}

const ticketsOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "tickets");
  if (read.kind !== "present") throw new Error("no tickets");
  return Object.fromEntries(read.record.tickets.map((entry) => [entry.id, entry]));
};
const progressOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "progress");
  if (read.kind !== "present") throw new Error("no progress");
  return read.record;
};

const INDEPENDENT: Omit<IndependenceInput, "ticketId"> = {
  dependencies: "T3 depends on nothing; T2 is not among its dependencies",
  decisions: "T2 waits on the date-format decision, which T3 never touches",
  partialEdits: "T2's partial edit is src/printer.ts; T3 changes only src/lexer.ts",
};

/** T2 started under whole-plan authorization (escalate having let it start) with a partial edit, then parked. */
async function parkedT2(h: ProjectHarness): Promise<void> {
  const started = startTicket(h.root, { ticketId: "T2" }, h.context, { escalated: true });
  if (!started.ok) throw new Error(started.reason);
  h.writeFile("src/printer.ts", "half done\n");
  const parked = parkTicket(h.root, { ticketId: "T2", blocker: "waiting on the developer's date-format decision" }, { now });
  if (!parked.ok) throw new Error(parked.reason);
}

describe("moving to the next ticket", () => {
  it("starts the next eligible ticket under whole-plan authorization once escalate answers proceed, with no prompt", async () => {
    const h = project();
    const transport = jev(PROCEED);

    const result = await nextTicket(h.root, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "started", ticket: { id: "T2", status: "in-progress" }, escalation: expect.any(String) });
    expect(result).not.toHaveProperty("askHuman");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.body).toContain("Boundary: next-ticket.");
    expect(progressOf(h)).toMatchObject({ assignedTicketId: "T2", authorizationScope: "plan" });
  });

  it("starts the first ticket after the developer's whole-plan authorization without asking Jev, then asks again", async () => {
    const h = project([ticket("T1", "ready"), ticket("T2", "ready", ["T1"])], { ...WHOLE_PLAN, firstStartAuthorized: true });
    const transport = jev(PROCEED);

    const first = await nextTicket(h.root, dependencies(h, transport));

    expect(first).toMatchObject({ kind: "started", ticket: { id: "T1" } });
    expect(first).not.toHaveProperty("escalation");
    expect(transport.sent).toHaveLength(0);
    expect(progressOf(h).firstStartAuthorized).toBeUndefined();

    writeRecord(h.root, "tickets", { tickets: [ticket("T1", "done"), ticket("T2", "ready", ["T1"])] });
    const { assignedTicketId: _started, ...between } = progressOf(h);
    writeRecord(h.root, "progress", between);
    const second = await nextTicket(h.root, dependencies(h, transport));

    expect(second).toMatchObject({ kind: "started", ticket: { id: "T2" }, escalation: expect.any(String) });
    expect(transport.sent).toHaveLength(1);
  });

  it("starts an ordinary next ticket by rule, without Jev, and says which rules allowed it", async () => {
    const h = project([ticket("T1", "done"), ticket("T2", "ready", ["T1"])], {
      ...WHOLE_PLAN,
      reviews: { T1: { reviewer: { agent: "t1-reviewer", model: "m" }, disposition: "passed", findings: [], reviewedAt: now } },
    });
    const transport = jev();

    const result = await nextTicket(h.root, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "started", ticket: { id: "T2" }, startedBy: "rules" });
    expect(result).not.toHaveProperty("escalation");
    if (result.kind !== "started") return;
    expect(result.startReasons.join(" ")).toContain("T1 passed validate and independent review");
    expect(transport.sent).toHaveLength(0);
  });

  it("asks escalate when the start is not ordinary, naming what is unusual", async () => {
    const reviewed = { T1: { reviewer: { agent: "r", model: "m" }, disposition: "passed" as const, findings: [], reviewedAt: now } };
    const cases: { name: string; progress: ProgressRecord; unusual: string }[] = [
      { name: "failed fix attempts", progress: { ...WHOLE_PLAN, reviews: reviewed, fixAttempts: { T1: 1 } }, unusual: "1 unsuccessful fix attempt" },
      {
        name: "a verdict set aside",
        progress: {
          ...WHOLE_PLAN,
          reviews: reviewed,
          validations: {
            T1: {
              disposition: "admitted-to-review",
              criteria: [{ criterion: "T1 works", verdict: "met", by: "developer", note: "I checked it" }],
              missingChecks: [],
              validatedAt: now,
            },
          },
        },
        unusual: "set aside",
      },
      { name: "no review recorded", progress: WHOLE_PLAN, unusual: "no passed review" },
    ];
    for (const { name, progress, unusual } of cases) {
      const h = project([ticket("T1", "done"), ticket("T2", "ready", ["T1"])], progress);
      const transport = jev(PROCEED);

      const result = await nextTicket(h.root, dependencies(h, transport));

      expect(result, name).toMatchObject({ kind: "started", escalation: expect.any(String) });
      expect(transport.sent, name).toHaveLength(1);
      expect(transport.sent[0]?.body, name).toContain(unusual);
    }
  });

  it("gives escalate the authorization, the ticket's dependencies and the latest review when it is asked", async () => {
    // A failed fix attempt on T1 makes the start unusual, so escalate is asked.
    const h = project([ticket("T1", "done"), ticket("T2", "ready", ["T1"])], {
      ...WHOLE_PLAN,
      fixAttempts: { T1: 1 },
      reviews: {
        T1: { reviewer: { agent: "t1-reviewer", model: "gpt-review" }, disposition: "passed", findings: [], reviewedAt: now },
      },
    });
    const transport = jev(PROCEED);

    await nextTicket(h.root, dependencies(h, transport));

    const body = transport.sent[0]?.body ?? "";
    expect(body).toContain("Execution is authorized for the whole plan: implement the whole plan");
    expect(body).toContain("T2 depends on T1, done.");
    expect(body).toContain("T1 passed independent review by t1-reviewer (gpt-review)");
  });

  it("hands each ticket to a fresh implementer sub-agent under whole-plan authorization, unless configured off", async () => {
    const first = project();
    const on = await nextTicket(first.root, dependencies(first, jev(PROCEED)));
    const h = project();
    const resolved = resolveConfiguration({ settings: { "implement.ticketWorker": false } }, loadShippedWorkflowPackage());
    if (!resolved.ok) throw new Error("test configuration must be valid");
    const off = await nextTicket(h.root, {
      ...dependencies(h, jev(PROCEED)),
      context: { workflowPackage: loadShippedWorkflowPackage(), configuration: resolved.configuration },
    });

    expect(on).toMatchObject({ kind: "started", ticketWorker: true });
    expect(off).toMatchObject({ kind: "started", ticketWorker: false });
  });

  it("starts the first ticket by rule when nothing has finished, and never through implement start", async () => {
    const h = project([ticket("T1", "ready"), ticket("T2", "ready")]);
    const transport = jev();

    expect(startTicket(h.root, { ticketId: "T1" }, h.context)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("implement next"),
    });
    expect(await nextTicket(h.root, dependencies(h, transport))).toMatchObject({
      kind: "started",
      ticket: { id: "T1" },
      startedBy: "rules",
      startReasons: expect.arrayContaining(["no ticket has finished yet"]),
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("keeps whole-plan authorization as it was when a ticket is parked", async () => {
    const h = project();
    await parkedT2(h);

    expect(progressOf(h)).toMatchObject({
      executionAuthorized: true,
      authorizationScope: "plan",
      authorizationNote: "implement the whole plan",
    });
  });

  it("asks the developer and starts nothing when escalate answers escalate", async () => {
    const h = project();

    const result = await nextTicket(h.root, dependencies(h, jev(ESCALATE)));

    expect(result).toMatchObject({ kind: "ask", ticket: "T2", askHuman: { boundary: "next-ticket" } });
    expect(ticketsOf(h)["T2"]).toMatchObject({ status: "ready" });
    expect(progressOf(h).assignedTicketId).toBeUndefined();
  });

  it("starts the ticket on the developer's recorded proceed at that ask, without asking Jev again", async () => {
    const h = project();
    const transport = jev(ESCALATE);
    const asked = await nextTicket(h.root, dependencies(h, transport));
    if (asked.kind !== "ask" || asked.escalation === undefined) throw new Error("expected an ask with its envelope");
    const chosen = recordChoice(h.root, asked.escalation, { action: "proceed", by: "developer", reason: "go ahead" }, ["proceed", "escalate"], { now });
    if (!chosen.ok) throw new Error(chosen.reason);

    const result = await nextTicket(h.root, dependencies(h, transport), { escalation: asked.escalation });

    expect(result).toMatchObject({ kind: "started", ticket: { id: "T2" }, escalation: asked.escalation });
    expect(transport.sent).toHaveLength(1);
  });

  it("refuses an escalation that records no proceed, or was asked for another start", async () => {
    const h = project();
    const asked = await nextTicket(h.root, dependencies(h, jev(ESCALATE)));
    if (asked.kind !== "ask" || asked.escalation === undefined) throw new Error("expected an ask with its envelope");

    const unchosen = await nextTicket(h.root, dependencies(h, jev()), { escalation: asked.escalation });
    recordChoice(h.root, asked.escalation, { action: "escalate", by: "developer", reason: "not yet" }, ["proceed", "escalate"], { now });
    const stopped = await nextTicket(h.root, dependencies(h, jev()), { escalation: asked.escalation });
    writeRecord(h.root, "tickets", { tickets: [ticket("T1", "done"), ticket("T2", "done"), ticket("T3", "ready"), ticket("T4", "ready", ["T2"])] });
    const other = await nextTicket(h.root, dependencies(h, jev()), { escalation: asked.escalation });

    for (const result of [unchosen, stopped, other]) expect(result).toMatchObject({ kind: "refused" });
    expect(ticketsOf(h)["T3"]).toMatchObject({ status: "ready" });
  });

  it("asks the developer without a Jev call when execution is not authorized for the whole plan", async () => {
    for (const progress of [
      { executionAuthorized: false, ticketChangesPresent: false },
      { ...WHOLE_PLAN, authorizationScope: "ticket", authorizationNote: "implement T1", assignedTicketId: "T1" },
    ] as ProgressRecord[]) {
      const h = project([ticket("T1", "done"), ticket("T2", "ready")], progress);
      const transport = jev(PROCEED);

      const result = await nextTicket(h.root, dependencies(h, transport));

      expect(result).toMatchObject({ kind: "ask", ticket: "T2", askHuman: { reasons: [expect.stringContaining("authoriz")] } });
      expect(transport.sent).toHaveLength(0);
      expect(ticketsOf(h)["T2"]).toMatchObject({ status: "ready" });
    }
  });

  it("refuses while a ticket is in progress", async () => {
    const h = project([ticket("T1", "in-progress"), ticket("T2", "ready")], { ...WHOLE_PLAN, assignedTicketId: "T1" });
    const transport = jev(PROCEED);

    expect(await nextTicket(h.root, dependencies(h, transport))).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("T1 is in progress"),
    });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("parking a blocked ticket", () => {
  it("records it parked with its blocker, never done, keeping its partial edits as its own", async () => {
    const h = project();

    await parkedT2(h);

    expect(ticketsOf(h)["T2"]).toMatchObject({ status: "parked", parkedReason: "waiting on the developer's date-format decision" });
    expect(ticketsOf(h)["T2"]).not.toHaveProperty("commit");
    const progress = progressOf(h);
    expect(progress.assignedTicketId).toBeUndefined();
    expect(progress.changeOwnership).toContainEqual(expect.objectContaining({ path: "src/printer.ts", owner: "ticket", ticketId: "T2" }));
    expect(readProjectState(h.root)).toMatchObject({ state: { unclaimedChanges: [] } });
  });

  it("never broadens the authorization: under one-ticket scope nothing else may start", async () => {
    const h = project([ticket("T1", "in-progress"), ticket("T2", "ready")], {
      executionAuthorized: true,
      authorizationScope: "ticket",
      authorizationNote: "implement T1",
      assignedTicketId: "T1",
      ticketChangesPresent: true,
    });
    const before = progressOf(h);

    const parked = parkTicket(h.root, { ticketId: "T1", blocker: "the API contract is undecided" }, { now });

    expect(parked).toMatchObject({ ok: true });
    const progress = progressOf(h);
    expect(progress).toMatchObject({
      executionAuthorized: before.executionAuthorized,
      authorizationScope: "ticket",
      authorizationNote: before.authorizationNote,
      assignedTicketId: "T1",
    });
    expect(startTicket(h.root, { ticketId: "T2" }, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("T1 only") });
    const transport = jev(PROCEED);
    expect(await nextTicket(h.root, dependencies(h, transport))).toMatchObject({ kind: "ask" });
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses to park a ticket that is not in progress, or without naming the blocker", () => {
    const h = project();

    expect(parkTicket(h.root, { ticketId: "T2", blocker: "x" }, { now })).toMatchObject({ ok: false });
    startTicket(h.root, { ticketId: "T2" }, h.context);
    expect(parkTicket(h.root, { ticketId: "T2", blocker: " " }, { now })).toMatchObject({ ok: false });
  });
});

describe("independence from a parked blocker", () => {
  it("lets no ticket start beside a parked one without a recorded independence check", async () => {
    const h = project();
    await parkedT2(h);
    const transport = jev(PROCEED);

    expect(startTicket(h.root, { ticketId: "T3" }, h.context)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("independence"),
    });
    expect(await nextTicket(h.root, dependencies(h, transport))).toMatchObject({
      kind: "needs-independence-check",
      candidates: ["T3"],
      parked: [{ id: "T2", blocker: expect.any(String), partialEdits: ["src/printer.ts"] }],
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("records a check covering dependencies, unresolved decisions and partial edits, then proceeds", async () => {
    const h = project();
    await parkedT2(h);

    const recorded = recordIndependence(h.root, { ticketId: "T3", ...INDEPENDENT }, { now });

    expect(recorded).toMatchObject({
      ok: true,
      outcome: { check: { parked: ["T2"], partialEditPaths: ["src/printer.ts"], checkedAt: now, ...INDEPENDENT } },
    });
    expect(await nextTicket(h.root, dependencies(h, jev(PROCEED)))).toMatchObject({ kind: "started", ticket: { id: "T3" } });
  });

  it("refuses a check that leaves out a part, or for a ticket that depends on the parked one", async () => {
    const h = project();
    await parkedT2(h);

    expect(recordIndependence(h.root, { ticketId: "T3", ...INDEPENDENT, partialEdits: "" }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("partial edits"),
    });
    expect(recordIndependence(h.root, { ticketId: "T4", ...INDEPENDENT }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("T2"),
    });
    expect(progressOf(h).independenceChecks).toBeUndefined();
  });

  it("needs the check again once another ticket is parked", async () => {
    const h = project([ticket("T1", "ready"), ticket("T2", "ready"), ticket("T3", "ready")]);
    await parkedT2(h);
    recordIndependence(h.root, { ticketId: "T3", ...INDEPENDENT }, { now });
    recordIndependence(h.root, { ticketId: "T1", ...INDEPENDENT }, { now });
    expect(startTicket(h.root, { ticketId: "T1" }, h.context, { escalated: true })).toMatchObject({ ok: true });
    parkTicket(h.root, { ticketId: "T1", blocker: "another question" }, { now });

    expect(startTicket(h.root, { ticketId: "T3" }, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("T1") });
  });
});

describe("waiting", () => {
  it("starts nothing and says why when no ticket can safely proceed", async () => {
    const h = project([ticket("T1", "done"), ticket("T2", "ready"), ticket("T4", "ready", ["T2"])]);
    await parkedT2(h);
    const transport = jev(PROCEED);

    const result = await nextTicket(h.root, dependencies(h, transport));

    expect(result).toMatchObject({
      kind: "waiting",
      reasons: [expect.stringContaining("T2 is parked"), expect.stringContaining("T4 depends on T2")],
    });
    expect(transport.sent).toHaveLength(0);
    expect(ticketsOf(h)["T4"]).toMatchObject({ status: "ready" });
  });

  it("reports the plan finished when every ticket is done or withdrawn and the plan's review passed", async () => {
    const h = project([ticket("T1", "done"), ticket("T2", "withdrawn")], {
      ...WHOLE_PLAN,
      planReview: {
        scope: "single-ticket",
        ticketId: "T1",
        tickets: ["T1"],
        reviewer: { agent: "reviewer-1" },
        disposition: "passed",
        findings: [],
        reviewedAt: now,
      },
    });

    expect(await nextTicket(h.root, dependencies(h, jev()))).toMatchObject({ kind: "finished" });
  });
});
