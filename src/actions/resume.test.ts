import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { JevTransport, TransportRequest } from "../jev/client.js";
import type { DecisionDependencies } from "../jev/decisions.js";
import { readRecord, writeRecord, type ProgressRecord, type TicketRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { readResume, reconcileResume, settleDiscrepancies, verifyTicket } from "./resume.js";
import { wrapSession } from "./wrap.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-26T14:00:00.000Z";
const pkg = loadShippedWorkflowPackage();
const highest = Math.max(confidenceThreshold(pkg, "escalate"), confidenceThreshold(pkg, "validate"));
const confident = highest + (1 - highest) / 2;

type Answer = readonly [choice: string, reason: string];

/** A Jev answering from a queue, whatever the decision; no answer left is an HTTP 500. */
function jev(...answers: Answer[]): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    const answer = answers.shift();
    if (answer === undefined) return { status: 500, body: "no scripted answer" };
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          [decision]: { type: "choice", choice: answer[0], confidence: confident },
          [`${decision}.reason`]: { type: "choice", choice: answer[1], confidence: confident },
        },
      }),
    };
  };
  return Object.assign(transport, { sent });
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

const ticket = (id: string, status: TicketRecord["status"], extra: Partial<TicketRecord> = {}): TicketRecord => ({
  id,
  title: `Ticket ${id}`,
  acceptanceCriteria: [`${id} works`],
  dependsOn: [],
  status,
  ...extra,
});

const ADMITTED = {
  disposition: "admitted-to-review" as const,
  criteria: [{ criterion: "T1 works", verdict: "met" as const, by: "jev" as const }],
  missingChecks: [],
  validatedAt: "2026-09-25T10:00:00Z",
};

/**
 * A session wrapped mid-plan: T1 done, validated and committed; T2 in progress with a partial edit;
 * T3 recorded done with no verification evidence; T4 ready and unaffected.
 */
function wrapped(): { readonly h: ProjectHarness; readonly progress: ProgressRecord } {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
  harnesses.push(h);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: h.root, encoding: "utf8" }).trim();
  h.writeFile("README.md", "readme\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "T1");
  const commit = git("rev-parse", "HEAD");
  writeRecord(h.root, "tickets", {
    tickets: [ticket("T1", "done", { commit }), ticket("T2", "in-progress"), ticket("T3", "done", { commit }), ticket("T4", "ready")],
  });
  const progress: ProgressRecord = {
    executionAuthorized: true,
    authorizationScope: "plan",
    authorizationNote: "implement the whole plan",
    assignedTicketId: "T2",
    ticketChangesPresent: true,
    validations: { T1: ADMITTED },
    fixAttempts: { T2: 1 },
    changeOwnership: [{ path: "src/parser.ts", owner: "ticket", ticketId: "T2", note: "T2's work" }],
  };
  writeRecord(h.root, "progress", progress);
  h.writeFile("src/parser.ts", "half done\n");
  const result = wrapSession(h.root, { summary: "T2's parser is half done.", nextSteps: ["finish src/parser.ts"] }, h.context, { now: "2026-09-25T18:00:00Z" });
  if (!result.ok) throw new Error(result.reason);
  return { h, progress };
}

/** T3's completion claim verified, so reconcile can run. */
function verified(h: ProjectHarness, progress: ProgressRecord): ProgressRecord {
  const next = { ...progress, validations: { ...progress.validations, T3: { ...ADMITTED, criteria: [{ ...ADMITTED.criteria[0]!, criterion: "T3 works" }] } } };
  writeRecord(h.root, "progress", next);
  return next;
}

const progressOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "progress");
  if (read.kind !== "present") throw new Error("no progress");
  return read.record;
};
const ticketsOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "tickets");
  if (read.kind !== "present") throw new Error("no tickets");
  return Object.fromEntries(read.record.tickets.map((entry) => [entry.id, entry]));
};

describe("reading where the work stands in a fresh session", () => {
  it("reconciles the records with the files, limited to the affected work, and continues the ticket from its edits", () => {
    const { h } = wrapped();
    const before = h.snapshot();

    const result = readResume(h.root, h.context);

    expect(result).toMatchObject({
      ok: true,
      report: {
        resume: { summary: "T2's parser is half done." },
        authorization: { executionAuthorized: true, scope: "plan", note: "implement the whole plan", needsDeveloper: false },
        continueWith: { ticketId: "T2", uncommittedChanges: ["src/parser.ts"] },
        unverified: [{ ticketId: "T3" }],
        affected: ["T2", "T3"],
        discrepancies: [],
      },
    });
    expect(h.snapshot()).toEqual(before);
  });

  it("takes authorization from the progress record, never from the resume record, and says so when they differ", () => {
    const { h, progress } = wrapped();
    const { authorizationScope: _scope, authorizationNote: _note, ...rest } = progress;
    writeRecord(h.root, "progress", { ...rest, executionAuthorized: false });

    const result = readResume(h.root, h.context);

    expect(result).toMatchObject({
      ok: true,
      report: {
        authorization: { executionAuthorized: false, needsDeveloper: true },
        discrepancies: [expect.objectContaining({ summary: expect.stringContaining("authoriz") })],
      },
    });
  });

  it("finds where the files moved on since wrap: recorded edits that are gone, and changes no one owns", () => {
    const { h } = wrapped();
    execFileSync("git", ["checkout", "--quiet", "--", "."], { cwd: h.root });
    execFileSync("rm", ["-f", "src/parser.ts"], { cwd: h.root });
    h.writeFile("notes.txt", "stray\n");

    const result = readResume(h.root, h.context);

    expect(result.ok && result.report.discrepancies.map((entry) => entry.summary)).toEqual(
      expect.arrayContaining([expect.stringContaining("src/parser.ts"), expect.stringContaining("notes.txt")]),
    );
  });

  it("reports the recommendation the session ended with beside the current one, which is the one to act on", () => {
    const { h } = wrapped();

    const result = readResume(h.root, h.context);

    const resume = readRecord(h.root, "resume");
    const previous = resume.kind === "present" ? resume.record.recommendation : undefined;
    expect(previous).toBeDefined();
    expect(result).toMatchObject({ ok: true, report: { recommendation: { previous, current: { action: expect.any(String), reason: expect.any(String) } } } });
  });

  it("does not hand stray changes made since wrap to the ticket being continued", () => {
    const { h } = wrapped();
    h.writeFile("notes.txt", "stray\n");

    const result = readResume(h.root, h.context);

    expect(result).toMatchObject({ ok: true, report: { continueWith: { ticketId: "T2", uncommittedChanges: ["src/parser.ts"] } } });
  });

  it("needs the developer when one-ticket authorization covered a ticket that is no longer being worked on", () => {
    const { h, progress } = wrapped();
    writeRecord(h.root, "progress", { ...progress, authorizationScope: "ticket", authorizationNote: "do T1", assignedTicketId: "T1" });

    const result = readResume(h.root, h.context);

    expect(result).toMatchObject({ ok: true, report: { authorization: { executionAuthorized: true, scope: "ticket", needsDeveloper: true } } });
  });

  it("works from the records alone when no resume record was left", () => {
    const { h } = wrapped();
    execFileSync("rm", ["jflow/resume.json"], { cwd: h.root });

    const result = readResume(h.root, h.context);
    expect(result).toMatchObject({ ok: true, report: { continueWith: { ticketId: "T2" } } });
    expect(result.ok && result.report.resume).toBeUndefined();
  });
});

describe("verifying a completion claim", () => {
  const evidence = { ticketId: "T3", evidence: [{ kind: "check" as const, source: "npm test", text: "8 passed", exitCode: 0 }], checks: ["npm test"] };

  it("judges the claim on the checks just run, and no longer lists it once all its criteria are met", async () => {
    const { h } = wrapped();

    const result = await verifyTicket(h.root, evidence, dependencies(h, jev(["met", "evidence-satisfies"])));

    expect(result).toMatchObject({ kind: "validated", validation: { disposition: "admitted-to-review" } });
    expect(progressOf(h).validations?.["T3"]).toMatchObject({ disposition: "admitted-to-review" });
    expect(readResume(h.root, h.context)).toMatchObject({ ok: true, report: { unverified: [] } });
  });

  it("records a failed claim as a discrepancy without reopening the ticket", async () => {
    const { h } = wrapped();

    await verifyTicket(h.root, evidence, dependencies(h, jev(["not-met", "evidence-contradicts"])));

    expect(ticketsOf(h)["T3"]).toMatchObject({ status: "done" });
    const report = readResume(h.root, h.context);
    expect(report.ok && report.report.discrepancies).toEqual([expect.objectContaining({ ticketId: "T3", summary: expect.stringContaining("returned-to-fix") })]);
  });

  it("refuses a ticket that is not done, a diff as evidence, and no evidence", async () => {
    const { h } = wrapped();
    const deps = dependencies(h);

    expect(await verifyTicket(h.root, { ...evidence, ticketId: "T2" }, deps)).toMatchObject({ kind: "refused" });
    expect(await verifyTicket(h.root, { ...evidence, evidence: [{ kind: "check", source: "git diff", text: "diff --git a/x b/x" }] }, deps)).toMatchObject({ kind: "refused" });
    expect(await verifyTicket(h.root, { ...evidence, evidence: [] }, deps)).toMatchObject({ kind: "refused" });
  });
});

describe("reconciling discrepancies", () => {
  it("asks escalate at resume-discrepancy with the evidence for each, and records only those that ask the developer", async () => {
    const { h, progress } = wrapped();
    verified(h, progress);
    const transport = jev(["proceed", "routine"], ["escalate", "consequential"]);

    const result = await reconcileResume(
      h.root,
      {
        discrepancies: [
          { summary: "the README typo fixed after wrap is not in any ticket", evidence: ["git log -1"] },
          { ticketId: "T1", summary: "npm test -- importer fails although T1 is done", evidence: ["npm test -- importer: 1 failed"] },
        ],
      },
      dependencies(h, transport),
    );

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]!.body).toContain("Boundary: resume-discrepancy.");
    expect(transport.sent[1]!.body).toContain("npm test -- importer: 1 failed");
    expect(result).toMatchObject({
      ok: true,
      outcome: {
        discrepancies: [
          { summary: expect.stringContaining("README"), ask: false, escalation: expect.any(String) },
          { ticketId: "T1", ask: true, escalation: expect.any(String) },
        ],
        askHuman: [expect.objectContaining({ boundary: "resume-discrepancy" })],
      },
    });
    expect(progressOf(h).reconciliation).toMatchObject({
      lastReconciledAt: now,
      discrepancies: [{ ticketId: "T1", summary: "npm test -- importer fails although T1 is done", consequential: true }],
    });
  });

  it("reconciles nothing itself: tickets, edits, fix counters and authorization stay as they were", async () => {
    const { h, progress: wrappedProgress } = wrapped();
    const progress = verified(h, wrappedProgress);
    const before = h.snapshot();

    await reconcileResume(h.root, { discrepancies: [{ ticketId: "T2", summary: "T2's partial edit fails to compile", evidence: [] }] }, dependencies(h, jev(["escalate", "uncertain"])));

    const after = h.snapshot();
    const changed = Object.keys({ ...before, ...after }).filter((path) => before[path] !== after[path]);
    expect(changed.filter((path) => !path.startsWith(".jflow/"))).toEqual(["jflow/progress.json"]);
    expect(ticketsOf(h)["T2"]).toMatchObject({ status: "in-progress" });
    const { reconciliation: _reconciliation, ...rest } = progressOf(h);
    expect(rest).toEqual(progress);
  });

  it("refuses while a completion claim is unverified: its checks run first, and no escalate answer waves it through", async () => {
    const { h } = wrapped();
    const transport = jev(["proceed", "routine"]);

    const result = await reconcileResume(h.root, {}, dependencies(h, transport));

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("T3") });
    expect(transport.sent).toHaveLength(0);
  });

  it("does not ask again about a discrepancy already waiting on the developer, and never again once they settle it", async () => {
    const { h, progress } = wrapped();
    verified(h, progress);
    const draft = { discrepancies: [{ ticketId: "T1", summary: "npm test -- importer fails although T1 is done", evidence: [] }] };
    await reconcileResume(h.root, draft, dependencies(h, jev(["escalate", "uncertain"])));
    const transport = jev();

    const again = await reconcileResume(h.root, draft, dependencies(h, transport));

    expect(transport.sent).toHaveLength(0);
    expect(again).toMatchObject({ ok: true, outcome: { discrepancies: [{ ticketId: "T1", ask: true, awaiting: true }], askHuman: [expect.objectContaining({ boundary: "resume-discrepancy" })] } });

    expect(settleDiscrepancies(h.root, { note: " " }, { now })).toMatchObject({ ok: false });
    expect(settleDiscrepancies(h.root, { note: "known flake; leave T1 done" }, { now })).toMatchObject({ ok: true, outcome: { settled: [{ ticketId: "T1" }] } });
    const settled = await reconcileResume(h.root, draft, dependencies(h, transport));
    expect(transport.sent).toHaveLength(0);
    expect(settled).toMatchObject({ ok: true, outcome: { discrepancies: [], askHuman: [] } });
    expect(progressOf(h).reconciliation).toMatchObject({ discrepancies: [], settled: [{ ticketId: "T1", note: "known flake; leave T1 done" }] });
  });

  it("records a realign recommendation for a scope-changing discrepancy, asks the developer without Jev, and starts nothing", async () => {
    const { h, progress } = wrapped();
    verified(h, progress);
    const transport = jev();
    const plan = h.snapshot()["jflow/plan.json"];

    const result = await reconcileResume(
      h.root,
      { discrepancies: [{ summary: "the developer's notes after wrap drop the CSV export entirely", evidence: ["notes.md"], changesScope: true }] },
      dependencies(h, transport),
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        discrepancies: [{ summary: expect.stringContaining("CSV export"), ask: true, recommendation: "R-1" }],
        askHuman: [expect.objectContaining({ boundary: "consequential-conflict" })],
      },
    });
    expect(transport.sent).toHaveLength(0);
    // Asked again in a later session, it neither re-asks nor records a second recommendation.
    await reconcileResume(h.root, { discrepancies: [{ summary: "the developer's notes after wrap drop the CSV export entirely", evidence: [], changesScope: true }] }, dependencies(h, transport));
    const realign = readRecord(h.root, "realign");
    expect(realign.kind === "present" && realign.record).toMatchObject({ recommendations: [{ id: "R-1", source: "resume", status: "open" }], realignments: [] });
    expect(h.snapshot()["jflow/plan.json"]).toBe(plan);
  });

  it("refuses a discrepancy without a summary", async () => {
    const { h } = wrapped();

    expect(await reconcileResume(h.root, { discrepancies: [{ summary: " ", evidence: [] }] }, dependencies(h))).toMatchObject({ ok: false });
  });
});
