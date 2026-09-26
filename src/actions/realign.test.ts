import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { JevTransport, TransportRequest } from "../jev/client.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import { readRecord, writeRecord, type ProgressRecord, type SpecificationRecord, type TicketRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { EVIDENCE_DIRECTORY, startTicket } from "./implement.js";
import { acceptPlan, writePlan } from "./plan.js";
import { realignPlan, recommendRealign, type RealignDraft } from "./realign.js";
import { acceptSpecification } from "./specification.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-26T12:00:00.000Z";
const pkg = loadShippedWorkflowPackage();
const highest = Math.max(confidenceThreshold(pkg, "validate"), confidenceThreshold(pkg, "classify"));
const confident = highest + (1 - highest) / 2;

const ticket = (id: string, status: TicketRecord["status"], extra: Partial<TicketRecord> = {}): TicketRecord => ({
  id,
  title: `Ticket ${id}`,
  acceptanceCriteria: [`${id} works`],
  dependsOn: [],
  status,
  ...extra,
});

const SPECIFICATION: SpecificationRecord = {
  title: "Importer",
  problem: "CSV files cannot be imported.",
  scenarios: ["import a file"],
  acceptanceCriteria: ["a CSV file imports"],
  constraints: [],
  exclusions: [],
  decisions: [{ id: "D1", statement: "Only UTF-8 input.", status: "confirmed", basis: "yes, UTF-8 only" }],
  status: "accepted",
  writtenAt: "2026-09-25T09:00:00Z",
  acceptedAt: "2026-09-25T09:30:00Z",
  acceptanceNote: "accepted",
};

const PROGRESS: ProgressRecord = {
  executionAuthorized: true,
  authorizationScope: "plan",
  authorizationNote: "implement the whole plan",
  assignedTicketId: "T2",
  ticketChangesPresent: true,
  validations: {
    T1: { disposition: "admitted-to-review", criteria: [{ criterion: "T1 works", verdict: "met", by: "jev" }], missingChecks: [], validatedAt: "2026-09-25T10:00:00Z" },
  },
  reviews: { T1: { reviewer: { agent: "reviewer-1" }, disposition: "passed", findings: [], reviewedAt: "2026-09-25T11:00:00Z" } },
  fixAttempts: { T2: 1 },
};

/** T1 and T5 done, T2 in progress and assigned, T3 parked, T4 ready and untouched by the realign. */
function project(): ProjectHarness {
  const h = createProjectHarness();
  harnesses.push(h);
  writeRecord(h.root, "specification", SPECIFICATION);
  writeRecord(h.root, "plan", { title: "Importer plan", summary: "Five tickets.", status: "accepted", writtenAt: "2026-09-25T09:40:00Z", acceptedAt: "2026-09-25T09:45:00Z", acceptanceNote: "looks good" });
  writeRecord(h.root, "tickets", {
    tickets: [
      ticket("T1", "done", { commit: "abc1234" }),
      ticket("T2", "in-progress"),
      ticket("T3", "parked", { parkedReason: "waiting on the date format" }),
      ticket("T4", "ready", { dependsOn: ["T1"] }),
      ticket("T5", "done", { commit: "def5678" }),
    ],
  });
  writeRecord(h.root, "progress", PROGRESS);
  h.writeFile(`${EVIDENCE_DIRECTORY}/T1.json`, JSON.stringify({ ticketId: "T1", evidence: [{ kind: "check", source: "npm test", text: "12 passed", exitCode: 0 }], checks: ["npm test"], recordedAt: "2026-09-25T10:00:00Z" }));
  return h;
}

type Answer = readonly [choice: string, reason: string, confidence: number];

const TESTABLE: Answer = ["testable", "clear-match", confident];

/**
 * A Jev answering validate from a queue (no answer left is an HTTP 500),
 * and classify from its own queue, testable once that is empty. `sent`
 * holds the validate requests.
 */
function jev(...answers: Answer[]): JevTransport & { readonly sent: TransportRequest[]; readonly classify: Answer[] } {
  const sent: TransportRequest[] = [];
  const classify: Answer[] = [];
  const transport = async (request: TransportRequest) => {
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    if (decision === "validate") sent.push(request);
    const answer = decision === "classify" ? (classify.shift() ?? TESTABLE) : answers.shift();
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
  return Object.assign(transport, { sent, classify });
}

function dependencies(h: ProjectHarness, transport: JevTransport = jev()): DecisionDependencies {
  return {
    context: h.context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async () => undefined,
  };
}

function records(h: ProjectHarness) {
  const read = <K extends "specification" | "plan" | "tickets" | "progress" | "realign">(kind: K) => {
    const result = readRecord(h.root, kind);
    if (result.kind !== "present") throw new Error(`no ${kind} record`);
    return result.record;
  };
  const tickets = Object.fromEntries(read("tickets").tickets.map((entry) => [entry.id, entry]));
  return { specification: read("specification"), plan: read("plan"), tickets, progress: read("progress"), realign: () => read("realign") };
}

const DRAFT: RealignDraft = {
  direction: "Drop the date column; imports must also report skipped rows.",
  changes: [
    { action: "rescope", ticketId: "T1", acceptanceCriteria: ["T1 works", "T1 reports skipped rows"] },
    { action: "rescope", ticketId: "T2", title: "Ticket T2 without dates" },
    { action: "add", ticketId: "T6", title: "Skipped-row report", acceptanceCriteria: ["the import lists skipped rows"], dependsOn: ["T1"] },
    { action: "withdraw", ticketId: "T3", reason: "the date column is dropped" },
  ],
};

const NOTE = "Change of plan: drop dates, report skipped rows.";

describe("realign", () => {
  it("re-scopes, adds and withdraws the affected tickets and leaves the others and their records untouched", async () => {
    const h = project();
    const before = records(h);

    const result = await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, jev(["met", "evidence-satisfies", confident], ["met", "evidence-satisfies", confident])));

    expect(result).toMatchObject({ ok: true });
    const after = records(h);
    expect(after.tickets["T2"]).toEqual({ ...before.tickets["T2"], title: "Ticket T2 without dates" });
    expect(after.tickets["T3"]).toMatchObject({ status: "withdrawn" });
    expect(after.tickets["T6"]).toMatchObject({ id: "T6", title: "Skipped-row report", acceptanceCriteria: ["the import lists skipped rows"], dependsOn: ["T1"], status: "ready" });
    expect(after.tickets["T4"]).toEqual(before.tickets["T4"]);
    expect(after.tickets["T5"]).toEqual(before.tickets["T5"]);
    expect(after.progress.fixAttempts).toEqual(before.progress.fixAttempts);
    expect(after.realign().realignments).toMatchObject([
      {
        id: "RA-1",
        direction: DRAFT.direction,
        note: NOTE,
        changes: [
          { action: "rescope", ticketId: "T1", criteriaChanged: true },
          { action: "rescope", ticketId: "T2", criteriaChanged: false },
          { action: "add", ticketId: "T6" },
          { action: "withdraw", ticketId: "T3", reason: "the date column is dropped" },
        ],
        priorAuthorization: { scope: "plan", note: "implement the whole plan" },
      },
    ]);
  });

  it("classifies the criteria it adds or changes, and refuses a confidently untestable one with nothing written", async () => {
    const h = project();
    const transport = jev();
    transport.classify.push(TESTABLE, TESTABLE, ["untestable", "clear-match", confident]);
    const before = h.snapshot();

    const result = await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, transport));

    expect(result).toMatchObject({ ok: false, untestable: [{ ticketId: "T6", criterion: 0, text: "the import lists skipped rows" }] });
    expect(transport.sent).toHaveLength(0);
    expect(h.snapshot()["jflow/tickets.json"]).toBe(before["jflow/tickets.json"]);
  });

  it("records the testability of the criteria it added or changed", async () => {
    const h = project();

    await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, jev(["met", "evidence-satisfies", confident], ["met", "evidence-satisfies", confident])));

    const after = records(h);
    expect(after.tickets["T6"]!.testability).toMatchObject([{ criterion: "the import lists skipped rows", answer: "testable" }]);
    expect(after.tickets["T1"]!.testability).toMatchObject([{ answer: "testable" }, { answer: "testable" }]);
    expect(after.tickets["T2"]!.testability).toBeUndefined();
  });

  it("clears the plan review, which covered the old scope", async () => {
    const h = project();
    const planReview = { reviewer: { agent: "reviewer-2" }, disposition: "passed" as const, findings: [], reviewedAt: "2026-09-25T11:30:00Z", scope: "integrated" as const, tickets: ["T1", "T2", "T3", "T4", "T5"] };
    writeRecord(h.root, "progress", { ...PROGRESS, planReview });

    await realignPlan(h.root, { direction: "Hold T4.", changes: [{ action: "park", ticketId: "T4", reason: "held" }] }, { note: NOTE }, dependencies(h));

    expect(records(h).progress.planReview).toBeUndefined();
  });

  it("records a parked or withdrawn in-progress ticket's uncommitted edits as its own, and unassigns it", async () => {
    const h = project();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: h.root });
    git("init", "--quiet");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "initial");
    h.writeFile("src/printer.ts", "half done\n");

    await realignPlan(h.root, { direction: "Hold T2.", changes: [{ action: "park", ticketId: "T2", reason: "held" }] }, { note: NOTE }, dependencies(h));

    const after = records(h);
    expect(after.progress.assignedTicketId).toBeUndefined();
    expect(after.progress.ticketChangesPresent).toBe(false);
    expect(after.progress.changeOwnership).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/printer.ts", owner: "ticket", ticketId: "T2" })]),
    );
  });

  it("parks an affected ticket with its reason", async () => {
    const h = project();

    const result = await realignPlan(h.root, { direction: "Hold the printer work.", changes: [{ action: "park", ticketId: "T4", reason: "held by the developer" }] }, { note: NOTE }, dependencies(h));

    expect(result).toMatchObject({ ok: true });
    expect(records(h).tickets["T4"]).toMatchObject({ status: "parked", parkedReason: "held by the developer" });
  });

  it("re-validates a completed ticket whose criteria changed and, all met, sends it back through review", async () => {
    const h = project();
    const transport = jev(["met", "evidence-satisfies", confident], ["met", "evidence-satisfies", confident]);

    const result = await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, transport));

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.body).toContain("T1 reports skipped rows");
    expect(transport.sent[1]!.body).toContain("12 passed");
    expect(result).toMatchObject({ ok: true, outcome: { revalidated: [{ ticketId: "T1", disposition: "admitted-to-review", status: "ready" }] } });
    const after = records(h);
    // Validation never replaces review (D47): its review covered the old criteria.
    expect(after.tickets["T1"]).toMatchObject({ status: "ready", commit: "abc1234", acceptanceCriteria: ["T1 works", "T1 reports skipped rows"] });
    expect(after.progress.validations?.["T1"]).toMatchObject({ disposition: "admitted-to-review", criteria: [{ verdict: "met" }, { verdict: "met" }] });
    expect(after.progress.reviews?.["T1"]).toBeUndefined();
  });

  it("reopens a completed ticket the changed criteria find unmet, and clears its review so it can be reviewed again", async () => {
    const h = project();

    const result = await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, jev(["met", "evidence-satisfies", confident], ["not-met", "evidence-contradicts", confident])));

    expect(result).toMatchObject({ ok: true, outcome: { revalidated: [{ ticketId: "T1", disposition: "returned-to-fix", status: "ready" }] } });
    const after = records(h);
    expect(after.tickets["T1"]).toMatchObject({ status: "ready" });
    expect(after.progress.validations?.["T1"]).toMatchObject({ disposition: "returned-to-fix" });
    expect(after.progress.reviews?.["T1"]).toBeUndefined();
  });

  it("writes nothing when a completed ticket cannot be re-validated, and says the developer is needed", async () => {
    const h = project();
    const before = h.snapshot();

    const result = await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, jev()));

    expect(result).toMatchObject({ ok: false, askHuman: expect.objectContaining({ kind: "human-ask" }) });
    // Only the Jev failure itself is recorded (the fallback status); no plan record changes.
    const after = h.snapshot();
    const plans = (files: Record<string, string>) =>
      Object.keys(files).filter((path) => path.startsWith("jflow/") && path !== "jflow/jev.json").map((path) => [path, files[path]]);
    expect(plans(after)).toEqual(plans(before));
  });

  it("records the reconciled specification and breakdown as awaiting acceptance, and refuses implement until the developer accepts", async () => {
    const h = project();

    await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, jev(["met", "evidence-satisfies", confident], ["met", "evidence-satisfies", confident])));

    const after = records(h);
    expect(after.specification).toMatchObject({ status: "awaiting-acceptance", decisions: SPECIFICATION.decisions });
    expect(after.specification.acceptedAt).toBeUndefined();
    expect(after.plan).toMatchObject({ status: "awaiting-acceptance", writtenAt: now });
    expect(after.progress).toMatchObject({ executionAuthorized: false });
    expect(after.progress.authorizationScope).toBeUndefined();
    expect(startTicket(h.root, { ticketId: "T4" }, h.context)).toMatchObject({ ok: false });
    expect(h.runAction("implement")).toMatchObject({ kind: "blocked" });

    // The plan cannot be accepted before the specification it rests on.
    expect(acceptPlan(h.root, { now, note: "fine" })).toMatchObject({ ok: false, reason: expect.stringContaining("specification") });
    expect(acceptSpecification(h.root, { now, note: "yes, the new direction" })).toMatchObject({ ok: true });
    expect(acceptPlan(h.root, { now, note: "fine" })).toMatchObject({ ok: true });
    // Accepting is not authorizing: the prior authorization did not carry over.
    expect(records(h).progress.executionAuthorized).toBe(false);
    expect(h.runAction("implement")).toMatchObject({ kind: "blocked" });
  });

  it("takes a revised specification, keeping the decisions the developer already confirmed and proposing new ones", async () => {
    const h = project();
    const specification = {
      ...SPECIFICATION,
      acceptanceCriteria: ["a CSV file imports", "skipped rows are reported"],
      decisions: [
        { id: "D1", statement: "Only UTF-8 input." },
        { id: "D2", statement: "No date column." },
      ],
    };

    const result = await realignPlan(h.root, { direction: "No dates.", specification, changes: [] }, { note: NOTE }, dependencies(h));

    expect(result).toMatchObject({ ok: true });
    expect(records(h).specification).toMatchObject({
      acceptanceCriteria: ["a CSV file imports", "skipped rows are reported"],
      decisions: [
        { id: "D1", status: "confirmed", basis: "yes, UTF-8 only" },
        { id: "D2", status: "proposed" },
      ],
      status: "awaiting-acceptance",
    });
  });

  it("makes no code edits and writes no completion state", async () => {
    const h = project();
    h.writeFile("src/importer.ts", "work in progress\n");
    const before = h.snapshot();

    await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, jev(["met", "evidence-satisfies", confident], ["met", "evidence-satisfies", confident])));

    const after = h.snapshot();
    const changed = Object.keys({ ...before, ...after }).filter((path) => before[path] !== after[path]);
    expect(changed.every((path) => path.startsWith("jflow/") || path.startsWith(".jflow/"))).toBe(true);
    const done = (tickets: Record<string, TicketRecord>) => Object.values(tickets).filter((entry) => entry.status === "done").map((entry) => entry.id);
    expect(done(records(h).tickets)).toEqual(["T5"]);
  });

  it("refuses without the developer's words, a change that does not fit the ticket, and a plan that was never accepted", async () => {
    const h = project();
    const deps = dependencies(h);

    expect(await realignPlan(h.root, DRAFT, { note: " " }, deps)).toMatchObject({ ok: false, reason: expect.stringContaining("developer") });
    expect(await realignPlan(h.root, { direction: "x", changes: [{ action: "withdraw", ticketId: "T5", reason: "no" }] }, { note: NOTE }, deps)).toMatchObject({ ok: false, reason: expect.stringContaining("T5") });
    expect(await realignPlan(h.root, { direction: "x", changes: [{ action: "add", ticketId: "T4", title: "dup", acceptanceCriteria: ["x"] }] }, { note: NOTE }, deps)).toMatchObject({ ok: false });
    expect(await realignPlan(h.root, { direction: "x", changes: [{ action: "rescope", ticketId: "T9", title: "x" }] }, { note: NOTE }, deps)).toMatchObject({ ok: false });
    expect(await realignPlan(h.root, { direction: "x", changes: [{ action: "rescope", ticketId: "T4", acceptanceCriteria: [] }] }, { note: NOTE }, deps)).toMatchObject({ ok: false });
    expect(await realignPlan(h.root, { direction: "x", changes: [{ action: "withdraw", ticketId: "T3", reason: "gone" }, { action: "rescope", ticketId: "T4", dependsOn: ["T3"] }] }, { note: NOTE }, deps)).toMatchObject({ ok: false, reason: expect.stringContaining("T3") });
    expect(await realignPlan(h.root, { direction: "", changes: [] }, { note: NOTE }, deps)).toMatchObject({ ok: false });
    expect(records(h).plan.status).toBe("accepted");

    const fresh = createProjectHarness({ state: { specificationAccepted: true } });
    harnesses.push(fresh);
    writePlan(fresh.root, { title: "p", summary: "s", tickets: [{ id: "T1", title: "t", acceptanceCriteria: ["c"], dependsOn: [] }] }, { now });
    expect(await realignPlan(fresh.root, DRAFT, { note: NOTE }, dependencies(fresh))).toMatchObject({ ok: false, reason: expect.stringContaining("accepted") });
  });

  it("can be run again on its own breakdown before acceptance, and plan write cannot replace that breakdown", async () => {
    const h = project();
    await realignPlan(h.root, DRAFT, { note: NOTE }, dependencies(h, jev(["met", "evidence-satisfies", confident], ["met", "evidence-satisfies", confident])));

    const again = await realignPlan(h.root, { direction: "Also hold T4.", changes: [{ action: "park", ticketId: "T4", reason: "held" }] }, { note: "hold T4 too" }, dependencies(h));
    const replaced = writePlan(h.root, { title: "p", summary: "s", tickets: [{ id: "T1", title: "t", acceptanceCriteria: ["c"], dependsOn: [] }] }, { now });

    expect(again).toMatchObject({ ok: true });
    expect(records(h).realign().realignments).toHaveLength(2);
    expect(replaced).toMatchObject({ ok: false, reason: expect.stringContaining("realign") });
    expect(records(h).tickets["T1"]).toMatchObject({ status: "ready", acceptanceCriteria: ["T1 works", "T1 reports skipped rows"] });
  });
});

describe("recommending realign", () => {
  it("records the recommendation and starts nothing", () => {
    const h = project();
    const before = h.snapshot();

    const result = recommendRealign(h.root, { source: "review", summary: "The review found the date column contradicts the new export format.", evidence: ["review of T2"] }, { now });

    expect(result).toMatchObject({ ok: true, outcome: { recommendation: { id: "R-1", source: "review", status: "open" } } });
    const after = h.snapshot();
    const changed = Object.keys({ ...before, ...after }).filter((path) => before[path] !== after[path]);
    expect(changed).toEqual(["jflow/realign.json"]);
    expect(records(h).realign().realignments).toEqual([]);
  });

  it("is marked addressed by the realign the developer then runs", async () => {
    const h = project();
    recommendRealign(h.root, { source: "resume", summary: "T3's blocker is gone.", evidence: [] }, { now });

    await realignPlan(h.root, { direction: "Unblock T3.", changes: [{ action: "rescope", ticketId: "T4", title: "T4 renamed" }], recommendations: ["R-1"] }, { note: NOTE }, dependencies(h));

    expect(records(h).realign().recommendations).toMatchObject([{ id: "R-1", status: "addressed", addressedBy: "RA-1" }]);
  });

  it("refuses a recommendation without a source or summary", () => {
    const h = project();

    expect(recommendRealign(h.root, { source: "chat" as never, summary: "x", evidence: [] }, { now })).toMatchObject({ ok: false });
    expect(recommendRealign(h.root, { source: "review", summary: " ", evidence: [] }, { now })).toMatchObject({ ok: false });
  });
});
