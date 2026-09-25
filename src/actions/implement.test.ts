import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import type { JevTransport, TransportRequest } from "../jev/client.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import type { ValidationInput } from "../jev/ticket-validation.js";
import { readRecord, writeRecord, type ProgressRecord, type TicketRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import type { ResolutionContext } from "./resolve.js";
import { checkTicket, countUnsuccessfulFix, EVIDENCE_DIRECTORY, startTicket } from "./implement.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T10:00:00.000Z";
const above = (decision: string) => {
  const threshold = confidenceThreshold(pkg, decision);
  return threshold + (1 - threshold) / 2;
};

const PARSES = "parses an empty file to an empty list";

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return { id: "T1", title: "Parser", acceptanceCriteria: [PARSES], dependsOn: [], status: "ready", ...overrides };
}

function contextWith(settings: Record<string, unknown>): ResolutionContext {
  const resolved = resolveConfiguration({ settings }, pkg);
  if (!resolved.ok) throw new Error("test configuration must be valid");
  return { workflowPackage: pkg, configuration: resolved.configuration };
}

/** An accepted plan in a Git repository, authorized for T1 alone unless `progress` says otherwise. */
function project(
  tickets: readonly TicketRecord[] = [ticket()],
  progress: ProgressRecord = {
    executionAuthorized: true,
    authorizationScope: "ticket",
    authorizationNote: "implement T1",
    assignedTicketId: "T1",
    ticketChangesPresent: false,
  },
): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
  harnesses.push(h);
  writeRecord(h.root, "tickets", { tickets });
  writeRecord(h.root, "progress", progress);
  return h;
}

function wholePlan(tickets: readonly TicketRecord[]): ProjectHarness {
  return project(tickets, {
    executionAuthorized: true,
    authorizationScope: "plan",
    authorizationNote: "implement the whole plan",
    ticketChangesPresent: false,
  });
}

const progressOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "progress");
  if (read.kind !== "present") throw new Error("no progress record");
  return read.record;
};
const ticketOf = (h: ProjectHarness, id: string) => {
  const read = readRecord(h.root, "tickets");
  if (read.kind !== "present") throw new Error("no tickets record");
  return read.record.tickets.find((entry) => entry.id === id);
};

type Answer = readonly [choice: string, reason: string, confidence: number];

/** A Jev answering `validate` from a queue, one answer per call, and `escalate` with a fixed answer. */
function jev(
  validate: Answer[],
  escalate: Answer = ["escalate", "uncertain", above("escalate")],
): JevTransport & { readonly sent: TransportRequest[]; readonly asked: (decision: string) => TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    const answer = decision === "escalate" ? escalate : validate.shift();
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
  const asked = (decision: string) =>
    sent.filter((request) => Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0] === decision);
  return Object.assign(transport, { sent, asked });
}

function dependencies(h: ProjectHarness, transport: JevTransport, context = h.context): DecisionDependencies {
  return {
    context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
  };
}

const met = (): Answer => ["met", "evidence-satisfies", above("validate")];
const notMet = (): Answer => ["not-met", "evidence-contradicts", above("validate")];
const short = (): Answer => ["insufficient-evidence", "evidence-missing", above("validate")];
const proceed = (): Answer => ["proceed", "routine", above("escalate")];

const checked: ValidationInput & { recommendation?: string } = {
  ticketId: "T1",
  evidence: [{ kind: "check", source: "npm test -- parser", text: "1 failed, 11 passed", exitCode: 1 }],
  checks: ["npm test -- parser"],
};
const RECOMMENDATION = "split the tokenizer out and test it alone";

describe("starting a ticket", () => {
  it("refuses without recorded execution authorization and changes nothing", () => {
    const h = project([ticket()], { executionAuthorized: false, ticketChangesPresent: false });

    const result = startTicket(h.root, { ticketId: "T1" }, h.context);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("execution has not been authorized") });
    expect(ticketOf(h, "T1")?.status).toBe("ready");
  });

  it("starts the ticket the developer authorized and reports the stage's delegation limits", () => {
    const h = project();

    const result = startTicket(h.root, {}, h.context);

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        ticket: { id: "T1", status: "in-progress", acceptanceCriteria: [PARSES] },
        delegationLimits: { maxParallelWorkers: 3, allowParallelWithinUnit: true },
        fix: { attempts: 0, limit: 2 },
      },
    });
    expect(ticketOf(h, "T1")?.status).toBe("in-progress");
    expect(progressOf(h)).toMatchObject({ assignedTicketId: "T1", ticketChangesPresent: true });
  });

  it("bounds parallel sub-work by the configured ceiling", () => {
    const h = project();

    const result = startTicket(h.root, {}, contextWith({ "delegation.maxParallelWorkers": 1 }));

    expect(result).toMatchObject({
      ok: true,
      outcome: { delegationLimits: { maxParallelWorkers: 1, allowParallelWithinUnit: false } },
    });
  });

  it("refuses a ticket the authorization does not cover", () => {
    const h = project([ticket(), ticket({ id: "T2", title: "Printer" })]);

    const result = startTicket(h.root, { ticketId: "T2" }, h.context);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("T1") });
    expect(ticketOf(h, "T2")?.status).toBe("ready");
  });

  it("refuses a second ticket while one is in progress", () => {
    const h = wholePlan([ticket({ status: "in-progress" }), ticket({ id: "T2", title: "Printer" })]);

    const result = startTicket(h.root, { ticketId: "T2" }, h.context);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("T1 is in progress") });
    expect(ticketOf(h, "T2")?.status).toBe("ready");
  });

  it("starts a ticket under whole-plan authorization only once escalate has let it, through implement next", () => {
    const h = wholePlan([ticket({ status: "done" }), ticket({ id: "T2", title: "Printer", dependsOn: ["T1"] })]);

    expect(startTicket(h.root, { ticketId: "T2" }, h.context)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("implement next"),
    });
    const result = startTicket(h.root, { ticketId: "T2" }, h.context, { escalated: true });

    expect(result).toMatchObject({ ok: true, outcome: { ticket: { id: "T2", status: "in-progress" } } });
    expect(progressOf(h)).toMatchObject({ authorizationScope: "plan", assignedTicketId: "T2" });
  });

  it("refuses under whole-plan authorization without a named ticket, or before its dependencies are done", () => {
    const h = wholePlan([ticket(), ticket({ id: "T2", title: "Printer", dependsOn: ["T1"] })]);

    expect(startTicket(h.root, {}, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("implement next") });
    expect(startTicket(h.root, { ticketId: "T2" }, h.context)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("T1"),
    });
    expect(ticketOf(h, "T2")?.status).toBe("ready");
  });

  it("starts an in-progress ticket again, to redo it after lost context", () => {
    const h = project([ticket({ status: "in-progress" })]);

    expect(startTicket(h.root, {}, h.context)).toMatchObject({ ok: true, outcome: { ticket: { status: "in-progress" } } });
  });

  it("refuses a ticket that is already done", () => {
    const h = project([ticket({ status: "done", commit: "abc123" })]);

    expect(startTicket(h.root, {}, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("done") });
  });
});

describe("checking a ticket through the validate gate", () => {
  function started(tickets: readonly TicketRecord[] = [ticket()]): ProjectHarness {
    const h = project(tickets);
    const result = startTicket(h.root, {}, h.context);
    if (!result.ok) throw new Error(result.reason);
    return h;
  }

  it("refuses a ticket that has not been started", async () => {
    const h = project();
    const transport = jev([met()]);

    const result = await checkTicket(h.root, checked, dependencies(h, transport));

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("start") });
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses once execution authorization is gone", async () => {
    const h = started();
    writeRecord(h.root, "progress", { executionAuthorized: false, ticketChangesPresent: true, assignedTicketId: "T1" });

    const result = await checkTicket(h.root, checked, dependencies(h, jev([met()])));

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("authoriz") });
  });

  it("records the checks as verification evidence in the form validate consumes", async () => {
    const h = started();
    const passing = { ...checked, evidence: [{ ...checked.evidence[0]!, text: "12 passed", exitCode: 0 }] };

    const result = await checkTicket(h.root, passing, dependencies(h, jev([met()])));

    expect(result).toMatchObject({ kind: "validated", evidence: `${EVIDENCE_DIRECTORY}/T1.json` });
    const stored = JSON.parse(readFileSync(join(h.root, EVIDENCE_DIRECTORY, "T1.json"), "utf8")) as ValidationInput;
    expect(stored).toMatchObject({ ticketId: "T1", evidence: passing.evidence, checks: passing.checks, recordedAt: now });
    expect(readFileSync(join(h.root, ".jflow", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("admits a ticket to review when every criterion is met, writing no completion state", async () => {
    const h = started();

    const result = await checkTicket(h.root, checked, dependencies(h, jev([met()])));

    expect(result).toMatchObject({ kind: "validated", validation: { disposition: "admitted-to-review" } });
    expect(result).not.toHaveProperty("askHuman");
    expect(ticketOf(h, "T1")).toMatchObject({ status: "in-progress" });
    expect(ticketOf(h, "T1")).not.toHaveProperty("commit");
    expect(progressOf(h).fixAttempts).toBeUndefined();
  });

  it("returns a ticket to fix on its first not-met without counting it: the implementation is not a fix attempt", async () => {
    const h = started();

    const result = await checkTicket(h.root, checked, dependencies(h, jev([notMet()])));

    expect(result).toMatchObject({
      kind: "validated",
      validation: { disposition: "returned-to-fix" },
      fix: { attempts: 0, limit: 2, counted: false },
    });
    expect(progressOf(h).fixAttempts).toEqual({ T1: 0 });
  });

  it("counts each later not-met and asks escalate at the limit with attempts, evidence and a recommendation", async () => {
    const h = started();
    const transport = jev([notMet(), notMet(), notMet()]);
    const deps = dependencies(h, transport);

    await checkTicket(h.root, checked, deps);
    const first = await checkTicket(h.root, checked, deps);
    expect(first).toMatchObject({ fix: { attempts: 1, counted: true } });
    expect(first).not.toHaveProperty("askHuman");
    expect(transport.asked("escalate")).toHaveLength(0);

    const second = await checkTicket(h.root, { ...checked, recommendation: RECOMMENDATION }, deps);

    expect(second).toMatchObject({
      kind: "validated",
      validation: { disposition: "returned-to-fix" },
      fix: { attempts: 2, limit: 2, counted: true, escalation: expect.any(String) },
      askHuman: { kind: "human-ask", boundary: "fix-failed" },
    });
    expect(progressOf(h).fixAttempts).toEqual({ T1: 2 });
    const [asked] = transport.asked("escalate");
    const packet = JSON.stringify((JSON.parse(asked!.body) as { state: object }).state);
    expect(packet).toContain("Boundary: fix-failed");
    expect(packet).toContain("2 unsuccessful fix attempts");
    expect(packet).toContain(PARSES);
    expect(packet).toContain("1 failed, 11 passed");
    expect(packet).toContain(RECOMMENDATION);
  });

  it("keeps fixing without asking when escalate confidently answers proceed at the limit", async () => {
    const h = started();
    const deps = dependencies(h, jev([notMet(), notMet()], proceed()), contextWith({ "review.fixRetryLimit": 1 }));

    await checkTicket(h.root, checked, deps);
    const result = await checkTicket(h.root, { ...checked, recommendation: RECOMMENDATION }, deps);

    expect(result).toMatchObject({ fix: { attempts: 1, limit: 1, escalation: expect.any(String) } });
    expect(result).not.toHaveProperty("askHuman");
  });

  it("asks escalate again for each failure past the limit", async () => {
    const h = started();
    const transport = jev([notMet(), notMet(), notMet()], proceed());
    const deps = dependencies(h, transport, contextWith({ "review.fixRetryLimit": 1 }));
    const advised = { ...checked, recommendation: RECOMMENDATION };

    await checkTicket(h.root, checked, deps);
    await checkTicket(h.root, advised, deps);
    const past = await checkTicket(h.root, advised, deps);

    expect(past).toMatchObject({ fix: { attempts: 2, limit: 1, escalation: expect.any(String) } });
    expect(transport.asked("escalate")).toHaveLength(2);
  });

  it("refuses, before asking Jev, an attempt that could reach the limit without a recommendation", async () => {
    const h = started();
    const transport = jev([notMet()]);
    const deps = dependencies(h, transport, contextWith({ "review.fixRetryLimit": 1 }));
    await checkTicket(h.root, checked, deps);

    const result = await checkTicket(h.root, checked, deps);

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("recommendation") });
    expect(transport.asked("validate")).toHaveLength(1);
    expect(progressOf(h).fixAttempts).toEqual({ T1: 0 });
  });

  it("does not count evidence that is merely short: running a missing check is not a fix", async () => {
    const h = started();
    const input = { ...checked, checks: ["npm test -- parser", "npm run typecheck"] };

    const result = await checkTicket(h.root, input, dependencies(h, jev([short()])));

    expect(result).toMatchObject({ validation: { disposition: "needs-check", missingChecks: ["npm run typecheck"] } });
    expect(result).not.toHaveProperty("fix");
    expect(progressOf(h).fixAttempts).toBeUndefined();
  });
});

describe("one fix counter per ticket, shared with review", () => {
  it("counts a blocking review finding on the same counter as a not-met criterion", async () => {
    const h = project([ticket({ status: "in-progress" })]);
    const deps = dependencies(h, jev([notMet()]));
    writeRecord(h.root, "progress", { ...progressOf(h), ticketChangesPresent: true });
    await checkTicket(h.root, checked, deps);

    const result = await countUnsuccessfulFix(
      h.root,
      { ticketId: "T1", summary: "review found the error line off by one", excerpts: [] },
      deps,
    );

    expect(result).toMatchObject({ ok: true, fix: { attempts: 1, limit: 2, counted: true } });
    expect(progressOf(h).fixAttempts).toEqual({ T1: 1 });
  });

  it("refuses to count against a ticket that is not in progress", async () => {
    const h = project();

    const result = await countUnsuccessfulFix(h.root, { ticketId: "T1", summary: "x", excerpts: [] }, dependencies(h, jev([])));

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not been started") });
    expect(existsSync(join(h.root, EVIDENCE_DIRECTORY))).toBe(false);
  });
});
