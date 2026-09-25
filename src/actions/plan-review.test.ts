import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import type { JevTransport, TransportRequest } from "../jev/client.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import {
  readRecord,
  writeRecord,
  type ProgressRecord,
  type TicketRecord,
  type TicketValidation,
} from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { decidePlanFinding, planCompletion, recordPlanReview, startPlanReview } from "./plan-review.js";
import { nextTicket } from "./progression.js";
import type { ResolutionContext } from "./resolve.js";
import { recordReview, startReview } from "./review.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T16:00:00.000Z";

const done = (id: string): TicketRecord => ({
  id,
  title: `Ticket ${id}`,
  acceptanceCriteria: [`${id} works`],
  dependsOn: [],
  status: "done",
  commit: `c0mm17${id}`,
});

const WHOLE_PLAN: ProgressRecord = {
  executionAuthorized: true,
  authorizationScope: "plan",
  authorizationNote: "implement the whole plan",
  ticketChangesPresent: false,
  implementers: { T2: ["worker-2"] },
};

function project(tickets: readonly TicketRecord[] = [done("T1"), done("T2")], progress: ProgressRecord = WHOLE_PLAN): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
  harnesses.push(h);
  writeRecord(h.root, "tickets", { tickets });
  writeRecord(h.root, "progress", progress);
  return h;
}

/** A Jev that must not be asked. */
function silent(): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  return Object.assign(
    async (request: TransportRequest) => {
      sent.push(request);
      return { status: 500, body: "not scripted" };
    },
    { sent },
  );
}

function dependencies(h: ProjectHarness, transport: JevTransport, context: ResolutionContext = h.context): DecisionDependencies {
  return {
    context,
    apiKey: { status: "configured", source: "environment", key: "jev-test-key-0123456789" },
    transport,
    now: () => now,
    sleep: async () => undefined,
  };
}

const records = (h: ProjectHarness) => {
  const tickets = readRecord(h.root, "tickets");
  const progress = readRecord(h.root, "progress");
  if (tickets.kind !== "present" || progress.kind !== "present") throw new Error("records missing");
  return { tickets: tickets.record, progress: progress.record };
};
const complete = (h: ProjectHarness) => {
  const { tickets, progress } = records(h);
  return planCompletion(tickets, progress);
};

const REVIEWER = { agent: "plan-reviewer", model: "claude-sonnet-5" };
const CLASH = { kind: "correctness", summary: "T1's lexer and T2's printer disagree on line endings", evidence: ["src/lexer.ts:4"] } as const;

describe("the integrated review gates a multi-ticket plan's completion", () => {
  it("leaves a plan whose tickets are all done incomplete until the integrated review passes", async () => {
    const h = project();
    const transport = silent();

    expect(complete(h)).toMatchObject({ complete: false, reason: expect.stringContaining("integrated review") });
    expect(await nextTicket(h.root, dependencies(h, transport))).toMatchObject({ kind: "needs-plan-review" });
    expect(transport.sent).toHaveLength(0);
  });

  it("gives the reviewer every ticket with its evidence, the plan's acceptance criteria and the review model", () => {
    const h = project();
    h.writeFile(".jflow/evidence/T1.json", "{}");
    const context: ResolutionContext = (() => {
      const resolved = resolveConfiguration({ stageModels: { review: { model: "claude-sonnet-5" } } }, pkg);
      if (!resolved.ok) throw new Error("configuration");
      return { workflowPackage: pkg, configuration: resolved.configuration };
    })();

    expect(startPlanReview(h.root, context)).toMatchObject({
      ok: true,
      outcome: {
        tickets: [
          { id: "T1", acceptanceCriteria: ["T1 works"], commit: "c0mm17T1", evidence: ".jflow/evidence/T1.json" },
          { id: "T2", acceptanceCriteria: ["T2 works"] },
        ],
        planCriteria: ["seeded"],
        implementers: ["primary", "worker-2"],
        stageModel: { model: "claude-sonnet-5" },
      },
    });
  });

  it("is refused while a ticket is still open", () => {
    const h = project([done("T1"), { ...done("T2"), status: "ready" }]);

    expect(startPlanReview(h.root, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("T2") });
  });

  it("passes with a distinct reviewer, completing the plan", async () => {
    const h = project();
    const transport = silent();

    const result = await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [] }, dependencies(h, transport));

    expect(result).toMatchObject({ ok: true, review: { scope: "integrated", disposition: "passed", reviewer: REVIEWER } });
    expect(complete(h)).toEqual({ complete: true });
    expect(await nextTicket(h.root, dependencies(h, transport))).toMatchObject({ kind: "finished" });
  });

  it("refuses a reviewer that implemented any of the plan's tickets", async () => {
    const h = project();

    for (const agent of ["primary", "worker-2"]) {
      expect(await recordPlanReview(h.root, { reviewer: { agent }, findings: [] }, dependencies(h, silent()))).toMatchObject({
        ok: false,
        reason: expect.stringContaining("implemented"),
      });
    }
    expect(records(h).progress.planReview).toBeUndefined();
  });
});

describe("integrated findings follow ticket review's disposition rules", () => {
  it("blocks the plan on a confirmed finding and asks the developer, since fixing it needs new plan work", async () => {
    const h = project();
    const transport = silent();

    const result = await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [CLASH] }, dependencies(h, transport));

    expect(result).toMatchObject({
      ok: true,
      review: { disposition: "returned-to-fix", findings: [{ id: "F1", disposition: "blocking" }] },
      askHuman: { reasons: [expect.stringContaining("realign")] },
    });
    expect(complete(h)).toMatchObject({ complete: false, reason: expect.stringContaining("blocking") });
    expect(transport.sent).toHaveLength(0);
  });

  it("files an improvement as a todo without blocking the plan", async () => {
    const h = project();

    const result = await recordPlanReview(
      h.root,
      { reviewer: REVIEWER, findings: [{ kind: "improvement", summary: "share the newline helper" }] },
      dependencies(h, silent()),
    );

    expect(result).toMatchObject({ ok: true, review: { disposition: "passed", findings: [{ disposition: "todo", todo: "TODO-1" }] } });
    expect(complete(h)).toEqual({ complete: true });
  });

  it("puts a consequential dispute to the developer without Jev, and completes once they withdraw it", async () => {
    const h = project();
    const transport = silent();
    const dispute = { reason: "CRLF support is out of scope", evidence: [], touches: ["scope"] as const };

    const recorded = await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [{ ...CLASH, dispute }] }, dependencies(h, transport));
    expect(recorded).toMatchObject({ ok: true, review: { disposition: "awaiting-developer" }, askHuman: expect.anything() });
    expect(transport.sent).toHaveLength(0);
    expect(complete(h)).toMatchObject({ complete: false });

    const decided = await decidePlanFinding(
      h.root,
      { finding: "F1", outcome: "withdrawn", note: "leave CRLF out" },
      dependencies(h, transport),
    );

    expect(decided).toMatchObject({ ok: true, review: { disposition: "passed" } });
    expect(readRecord(h.root, "conflicts")).toMatchObject({ record: { conflicts: [{ status: "resolved" }] } });
    expect(complete(h)).toEqual({ complete: true });
  });

  it("takes no new integrated review after a blocked one until the plan's tickets change or the developer withdraws the finding", async () => {
    const h = project();
    await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [CLASH] }, dependencies(h, silent()));

    expect(startPlanReview(h.root, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("realign") });
    expect(await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [] }, dependencies(h, silent()))).toMatchObject({
      ok: false,
    });

    writeRecord(h.root, "tickets", { tickets: [...records(h).tickets.tickets, done("T3")] });
    expect(await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [] }, dependencies(h, silent()))).toMatchObject({
      ok: true,
      review: { disposition: "passed", tickets: ["T1", "T2", "T3"] },
    });
    expect(startPlanReview(h.root, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("passed") });
  });

  it("lets the developer withdraw a blocking integrated finding in their own words", async () => {
    const h = project();
    await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [CLASH] }, dependencies(h, silent()));

    const decided = await decidePlanFinding(h.root, { finding: "F1", outcome: "withdrawn", note: "CRLF can wait" }, dependencies(h, silent()));

    expect(decided).toMatchObject({
      ok: true,
      review: { disposition: "passed", findings: [{ disposition: "withdrawn", dispute: { resolution: { by: "developer", note: "CRLF can wait" } } }] },
    });
    expect(complete(h)).toEqual({ complete: true });
  });

  it("no longer counts once the plan's tickets change", async () => {
    const h = project();
    await recordPlanReview(h.root, { reviewer: REVIEWER, findings: [] }, dependencies(h, silent()));

    writeRecord(h.root, "tickets", { tickets: [...records(h).tickets.tickets, done("T3")] });

    expect(complete(h)).toMatchObject({ complete: false, reason: expect.stringContaining("T3") });
    expect(startPlanReview(h.root, h.context)).toMatchObject({ ok: true });
  });
});

describe("a single-ticket plan", () => {
  it("is not complete on a done ticket alone: a ticket reviewed without the plan scope needs the plan reviewed", () => {
    const h = project([done("T1"), { ...done("T2"), status: "withdrawn" }]);

    expect(complete(h)).toMatchObject({ complete: false });
    expect(startPlanReview(h.root, h.context)).toMatchObject({ ok: true, outcome: { tickets: [{ id: "T1" }] } });
  });

  const admitted: TicketValidation = {
    disposition: "admitted-to-review",
    criteria: [{ criterion: "T1 works", verdict: "met", by: "jev" }],
    missingChecks: [],
    validatedAt: now,
  };

  it("has its one review cover both scopes, with no second review", async () => {
    const h = project([{ ...done("T1"), status: "in-progress" }, { ...done("T2"), status: "withdrawn" }], {
      ...WHOLE_PLAN,
      assignedTicketId: "T1",
      ticketChangesPresent: true,
      validations: { T1: admitted },
    });

    expect(startReview(h.root, h.context)).toMatchObject({ ok: true, outcome: { scopes: ["ticket", "plan"], planCriteria: ["seeded"] } });
    await recordReview(h.root, { ticketId: "T1", reviewer: REVIEWER, findings: [] }, dependencies(h, silent()));

    expect(records(h).progress.planReview).toMatchObject({
      scope: "single-ticket",
      ticketId: "T1",
      disposition: "passed",
      tickets: ["T1"],
    });
    writeRecord(h.root, "tickets", {
      tickets: records(h).tickets.tickets.map((ticket) => (ticket.id === "T1" ? { ...ticket, status: "done" } : ticket)),
    });
    expect(complete(h)).toEqual({ complete: true });
    expect(startPlanReview(h.root, h.context)).toMatchObject({ ok: false, reason: expect.stringContaining("single") });
  });
});
