import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import {
  readRecord,
  writeRecord,
  type ProgressRecord,
  type TicketRecord,
  type TicketReview,
  type TicketValidation,
} from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { completeTicket } from "./completion.js";
import type { ResolutionContext } from "./resolve.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T13:00:00.000Z";

const admitted: TicketValidation = {
  disposition: "admitted-to-review",
  criteria: [{ criterion: "parses an empty file", verdict: "met", by: "jev" }],
  missingChecks: [],
  validatedAt: "2026-09-25T11:00:00.000Z",
};

const reviewed = (disposition: TicketReview["disposition"]): TicketReview => ({
  reviewer: { agent: "reviewer-1", model: "claude-sonnet-5" },
  disposition,
  findings: [],
  reviewedAt: "2026-09-25T12:00:00.000Z",
});

const PASSED: Partial<ProgressRecord> = { validations: { T1: admitted }, reviews: { T1: reviewed("passed") } };

function contextWith(settings: Record<string, unknown>): ResolutionContext {
  const resolved = resolveConfiguration({ settings }, pkg);
  if (!resolved.ok) throw new Error("test configuration must be valid");
  return { workflowPackage: pkg, configuration: resolved.configuration };
}

const git = (h: ProjectHarness, ...args: string[]) => execFileSync("git", args, { cwd: h.root, encoding: "utf8" });

/**
 * T1 in progress in a repository with one commit, holding the developer's
 * own `notes.md` from before the ticket started, and the ticket's work.
 */
function project(progress: Partial<ProgressRecord> = PASSED, scope: "ticket" | "plan" = "ticket"): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
  harnesses.push(h);
  h.writeFile("README.md", "readme\n");
  git(h, "add", "README.md");
  git(h, "commit", "--quiet", "-m", "initial");
  h.writeFile("notes.md", "the developer's notes\n");
  const tickets: TicketRecord[] = [
    { id: "T1", title: "Parser", acceptanceCriteria: ["parses an empty file"], dependsOn: [], status: "in-progress" },
    { id: "T2", title: "Printer", acceptanceCriteria: ["prints"], dependsOn: ["T1"], status: "ready" },
  ];
  writeRecord(h.root, "tickets", { tickets });
  writeRecord(h.root, "progress", {
    executionAuthorized: true,
    authorizationScope: scope,
    authorizationNote: scope === "ticket" ? "implement T1" : "implement the whole plan",
    assignedTicketId: "T1",
    ticketChangesPresent: true,
    changeOwnership: [{ path: "notes.md", owner: "developer", note: "mine, leave it" }],
    ...progress,
  });
  h.writeFile("src/parser.ts", "export const parse = () => [];\n");
  h.writeFile("README.md", "readme, with the parser\n");
  return h;
}

const commitCount = (h: ProjectHarness) => Number(git(h, "rev-list", "--count", "HEAD").trim());
const ticketsOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "tickets");
  if (read.kind !== "present") throw new Error("no tickets record");
  return read.record.tickets;
};
const progressOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "progress");
  if (read.kind !== "present") throw new Error("no progress record");
  return read.record;
};

describe("completing a ticket that passed checks and review", () => {
  it("makes one local commit of the ticket's changes and the project records, and nothing else", () => {
    const h = project();

    const result = completeTicket(h.root, { ticketId: "T1" }, h.context, { now });

    expect(result).toMatchObject({ ok: true, outcome: { commit: { hash: expect.any(String) } } });
    if (!result.ok) return;
    expect(commitCount(h)).toBe(2);
    const committed = git(h, "show", "--name-only", "--format=%s", "HEAD").trim().split("\n");
    expect(committed[0]).toBe("T1: Parser");
    expect(committed.slice(2).sort()).toEqual(
      ["README.md", "jflow/plan.json", "jflow/progress.json", "jflow/specification.json", "jflow/tickets.json", "src/parser.ts"].sort(),
    );
    expect(result.outcome.leftOut).toEqual(["notes.md"]);
    expect(git(h, "status", "--porcelain=v1")).toContain("?? notes.md");
    expect(result.outcome.commit?.hash).toBe(git(h, "rev-parse", "HEAD").trim());
  });

  it("records the ticket done, marks the commit as the ticket's, leaves no record uncommitted, and ends a one-ticket authorization", () => {
    const h = project();

    const result = completeTicket(h.root, {}, h.context, { now });

    expect(result).toMatchObject({ ok: true, outcome: { authorization: "ended", ticket: { id: "T1", status: "done" } } });
    expect(ticketsOf(h)[0]).toMatchObject({ id: "T1", status: "done" });
    expect(git(h, "log", "-1", "--format=%(trailers:key=Jflow-Ticket,valueonly)").trim()).toBe("T1");
    expect(git(h, "status", "--porcelain=v1", "--", "jflow")).toBe("");
    const progress = progressOf(h);
    expect(progress).toMatchObject({ executionAuthorized: false, ticketChangesPresent: false });
    expect(progress.assignedTicketId).toBeUndefined();
    expect(progress.authorizationScope).toBeUndefined();
    // The committed records already say the ticket is done.
    expect(git(h, "show", "HEAD:jflow/tickets.json")).toContain('"done"');
  });

  it("keeps whole-plan authorization for the next ticket", () => {
    const h = project(PASSED, "plan");

    const result = completeTicket(h.root, { ticketId: "T1" }, h.context, { now });

    expect(result).toMatchObject({ ok: true, outcome: { authorization: "continues" } });
    expect(progressOf(h)).toMatchObject({ executionAuthorized: true, authorizationScope: "plan", ticketChangesPresent: false });
    expect(progressOf(h).assignedTicketId).toBeUndefined();
  });

  it("drops the finished ticket's adopted changes, so a later ticket commits its own edits to them", () => {
    const h = project({
      ...PASSED,
      changeOwnership: [
        { path: "notes.md", owner: "developer", note: "mine" },
        { path: "draft.ts", owner: "ticket", ticketId: "T1", note: "part of the parser" },
      ],
    });
    h.writeFile("draft.ts", "adopted\n");

    completeTicket(h.root, { ticketId: "T1" }, h.context, { now });

    expect(progressOf(h).changeOwnership).toEqual([{ path: "notes.md", owner: "developer", note: "mine" }]);
    expect(git(h, "show", "--name-only", "--format=", "HEAD")).toContain("draft.ts");
  });

  it("leaves out changes another ticket adopted and changes the developer staged", () => {
    const h = project({
      ...PASSED,
      changeOwnership: [
        { path: "notes.md", owner: "developer", note: "mine" },
        { path: "later.ts", owner: "ticket", ticketId: "T2", note: "for the printer" },
      ],
    });
    h.writeFile("later.ts", "printer draft\n");
    h.writeFile("staged.md", "staged by the developer\n");
    git(h, "add", "staged.md");
    writeRecord(h.root, "progress", {
      ...progressOf(h),
      changeOwnership: [...(progressOf(h).changeOwnership ?? []), { path: "staged.md", owner: "developer", note: "mine too" }],
    });

    const result = completeTicket(h.root, { ticketId: "T1" }, h.context, { now });

    expect(result).toMatchObject({ ok: true, outcome: { leftOut: ["later.ts", "notes.md", "staged.md"] } });
    const committed = git(h, "show", "--name-only", "--format=", "HEAD");
    expect(committed).not.toContain("later.ts");
    expect(committed).not.toContain("staged.md");
    expect(git(h, "status", "--porcelain=v1")).toContain("A  staged.md");
  });

  it("records completion without a commit when commit-on-success is off", () => {
    const h = project();

    const result = completeTicket(h.root, { ticketId: "T1" }, contextWith({ commitOnSuccess: false }), { now });

    expect(result).toMatchObject({ ok: true, outcome: { ticket: { status: "done" } } });
    if (!result.ok) return;
    expect(result.outcome.commit).toBeUndefined();
    expect(commitCount(h)).toBe(1);
    expect(ticketsOf(h)[0]).toMatchObject({ status: "done" });
    expect(ticketsOf(h)[0]).not.toHaveProperty("commit");
  });
});

describe("a ticket that has not passed produces no commit", () => {
  it.each([
    ["no review", { validations: { T1: admitted } }],
    ["a review that returned it to fix", { reviews: { T1: reviewed("returned-to-fix") } }],
    ["a review waiting for the developer", { validations: { T1: admitted }, reviews: { T1: reviewed("awaiting-developer") } }],
    ["a passed review but no all-met validation", { reviews: { T1: reviewed("passed") } }],
  ] as const)("refuses a ticket with %s and changes nothing", (_, progress) => {
    const h = project(progress);
    const before = { tickets: ticketsOf(h), progress: progressOf(h) };

    const result = completeTicket(h.root, { ticketId: "T1" }, h.context, { now });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/review|validate/) });
    expect(commitCount(h)).toBe(1);
    expect({ tickets: ticketsOf(h), progress: progressOf(h) }).toEqual(before);
  });

  it("refuses a ticket that is not the one in progress", () => {
    const h = project();

    expect(completeTicket(h.root, { ticketId: "T2" }, h.context, { now })).toMatchObject({ ok: false });
    expect(commitCount(h)).toBe(1);
  });

  it("restores the records when Git refuses the commit, and reports why", () => {
    const h = project();
    const hook = join(h.root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const before = { tickets: ticketsOf(h), progress: progressOf(h) };

    const result = completeTicket(h.root, { ticketId: "T1" }, h.context, { now });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("lint failed") });
    expect(commitCount(h)).toBe(1);
    expect({ tickets: ticketsOf(h), progress: progressOf(h) }).toEqual(before);
  });
});
