import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_NEEDS_HUMAN, EXIT_OK, EXIT_UNREADABLE, runCli, type CliIo } from "./cli.js";
import type { JevTransport } from "./jev/client.js";
import { createProjectHarness, type ProjectHarness } from "./testing/harness.js";
import { loadWorkflowPackage, SHIPPED_PACKAGE_DIRECTORY } from "./workflow/package.js";

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: () => Record<string, unknown>;
}

/** Fails any test that would reach the network; tests that ask Jev pass their own transport. */
const noJev: JevTransport = async () => {
  throw new Error("this test must not call Jev");
};

async function run(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
  jev: CliIo["jev"] = { env: {}, transport: noJev },
  packageDirectory?: string,
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    hostProbes: { env, exec: () => "git version test" },
    jev,
    checkRunner: (command) =>
      command.endsWith("# failing")
        ? { output: `ran ${command}\n1 failed`, exitCode: 1, timedOut: false }
        : { output: `ran ${command}\n1 passed`, exitCode: 0, timedOut: false },
    ...(packageDirectory === undefined ? {} : { packageDirectory }),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
}

describe("jflow helper CLI", () => {
  it("prints usage for help and for no command", async () => {
    const h = harness();

    expect((await run(["help"], h.root)).stdout).toContain("Usage");
    expect((await run([], h.root)).code).toBe(EXIT_OK);
  });

  it("reports status as JSON against the current directory", async () => {
    const h = harness({ state: { specificationAccepted: true } });

    const result = await run(["status"], h.root);

    expect(result.code).toBe(EXIT_OK);
    const outcome = result.json()["outcome"] as Record<string, unknown>;
    expect(outcome["kind"]).toBe("completed");
    expect((outcome["report"] as Record<string, unknown>)["project"]).toBe("initialized");
  });

  it("runs a named action and a sentence to the same outcome, honouring --root", async () => {
    const h = harness({ state: { specificationAccepted: true } });
    const elsewhere = harness();

    const named = await run(["run", "plan", "--root", h.root], elsewhere.root);
    const spoken = await run(["run", "break", "the", "spec", "into", "tickets", "--root", h.root], elsewhere.root);

    expect(named.code).toBe(EXIT_OK);
    expect(named.json()["outcome"]).toEqual(spoken.json()["outcome"]);
    expect((named.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("ready");
  });

  it("returns the clarifying question and a needs-human exit for an ambiguous request", async () => {
    const h = harness();

    const result = await run(["run", "should", "I", "troubleshoot", "or", "review?"], h.root);

    expect(result.code).toBe(EXIT_NEEDS_HUMAN);
    const outcome = result.json()["outcome"] as Record<string, unknown>;
    expect(outcome["kind"]).toBe("clarify");
    expect(result.json()["humanAsks"]).toHaveLength(1);
  });

  it("refuses a blocked action naming the unmet prerequisites", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true } });

    const result = await run(["run", "implement"], h.root);

    expect(result.code).toBe(EXIT_NEEDS_HUMAN);
    const outcome = result.json()["outcome"] as Record<string, unknown>;
    expect(outcome["kind"]).toBe("blocked");
    expect(JSON.stringify(outcome)).toContain("execution.authorized");
  });

  it("reports an unreadable project record with the unreadable exit code", async () => {
    const h = harness({ state: { specificationAccepted: true } });
    h.writeFile("jflow/progress.json", "{ broken");

    const result = await run(["run", "plan"], h.root);

    expect(result.code).toBe(EXIT_UNREADABLE);
    expect((result.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("malformed-record");
  });

  it("validates the package and a configuration file before anything runs", async () => {
    const h = harness();
    mkdirSync(join(h.root, "cfg"));
    writeFileSync(join(h.root, "cfg", "bad.json"), JSON.stringify({ stageModels: { deploy: { model: "x" } } }));
    writeFileSync(join(h.root, "cfg", "good.json"), JSON.stringify({ stageModels: { implement: { model: "x" } } }));

    const bad = await run(["validate", "--config", "cfg/bad.json"], h.root);
    const good = await run(["validate", "--config", "cfg/good.json"], h.root);
    const missing = await run(["validate", "--config", "cfg/none.json"], h.root);

    expect(bad.code).toBe(EXIT_NEEDS_HUMAN);
    expect(JSON.stringify(bad.json()["configuration"])).toContain("stageModels.deploy");
    expect(good.code).toBe(EXIT_OK);
    expect(good.json()["ok"]).toBe(true);
    expect(missing.code).toBe(EXIT_UNREADABLE);
  });

  it("reports host capabilities with verified/unverified labels", async () => {
    const h = harness();

    const result = await run(["check-host"], h.root);

    expect(result.code).toBe(EXIT_OK);
    const results = result.json()["results"] as { capability: string; status: string }[];
    expect(results.find((r) => r.capability === "shell")?.status).toBe("verified");
    expect(results.find((r) => r.capability === "pinned-worker-model")?.status).toBe("unverified");
  });

  it("rejects an unknown command, an unknown option and an option without a value", async () => {
    const h = harness();

    expect((await run(["deploy"], h.root)).code).toBe(EXIT_NEEDS_HUMAN);
    const dangling = await run(["status", "--root"], h.root);
    expect(dangling.code).toBe(EXIT_NEEDS_HUMAN);
    expect(dangling.stderr).toContain("--root");
    const unknown = await run(["status", "--verbose", "yes"], h.root);
    expect(unknown.code).toBe(EXIT_NEEDS_HUMAN);
    expect(unknown.stderr).toContain("--verbose");
  });

  it("takes a specification from draft to acceptance, after which plan is ready", async () => {
    const h = harness();
    writeFileSync(
      join(h.root, "draft.json"),
      JSON.stringify({
        title: "CSV export",
        problem: "Users cannot get their data out.",
        scenarios: ["A user exports the current list"],
        acceptanceCriteria: ["The file opens in a spreadsheet"],
        constraints: [],
        exclusions: ["Scheduled exports"],
        decisions: [{ id: "D1", statement: "UTF-8 with BOM" }],
      }),
    );

    const written = await run(["specification", "write", "draft.json"], h.root);
    const planBefore = await run(["run", "plan"], h.root);
    const tooEarly = await run(["specification", "accept"], h.root);
    const noBasis = await run(["specification", "confirm", "D1"], h.root);
    const confirmed = await run(["specification", "confirm", "D1", "--basis", "developer said yes"], h.root);
    const accepted = await run(["specification", "accept", "--note", "yes, exactly that"], h.root);
    const planAfter = await run(["run", "plan"], h.root);

    expect(written.code).toBe(EXIT_OK);
    expect((planBefore.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("blocked");
    expect(tooEarly.code).toBe(EXIT_NEEDS_HUMAN);
    expect(tooEarly.json()["reason"]).toContain("D1");
    expect(noBasis.code).toBe(EXIT_NEEDS_HUMAN);
    expect(confirmed.code).toBe(EXIT_OK);
    expect(accepted.code).toBe(EXIT_OK);
    expect((accepted.json()["record"] as Record<string, unknown>)["acceptanceNote"]).toBe("yes, exactly that");
    expect((planAfter.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("ready");
  });

  it("reports a missing draft file as unreadable and a bad subcommand as needing the developer", async () => {
    const h = harness();

    expect((await run(["specification", "write", "none.json"], h.root)).code).toBe(EXIT_UNREADABLE);
    expect((await run(["specification", "frobnicate"], h.root)).code).toBe(EXIT_NEEDS_HUMAN);
    expect((await run(["specification", "confirm"], h.root)).code).toBe(EXIT_NEEDS_HUMAN);
  });

  it("takes a plan from draft to acceptance, keeping authorization a separate recorded step", async () => {
    const h = harness({ state: { specificationAccepted: true }, gitRepository: true });
    // Drafts live outside the project's working tree, as the skill writes them.
    const draft = join(harness().root, "plan.json");
    writeFileSync(
      draft,
      JSON.stringify({
        title: "CSV export",
        summary: "Export the list.",
        tickets: [
          { id: "T1", title: "Serialise", acceptanceCriteria: ["rows round-trip"], dependsOn: [] },
          { id: "T2", title: "Button", acceptanceCriteria: [], dependsOn: ["T1"] },
        ],
      }),
    );

    const refused = await run(["plan", "write", draft], h.root);
    expect(refused.code).toBe(EXIT_NEEDS_HUMAN);
    expect(JSON.stringify(refused.json()["issues"])).toContain("tickets[1].acceptanceCriteria");

    writeFileSync(
      draft,
      JSON.stringify({
        title: "CSV export",
        summary: "Export the list.",
        tickets: [{ id: "T1", title: "Serialise", acceptanceCriteria: ["rows round-trip"], dependsOn: [] }],
      }),
    );
    const written = await run(["plan", "write", draft], h.root);
    const looksGood = await run(["plan", "accept", "--note", "looks good"], h.root);
    const implementAsks = await run(["run", "implement"], h.root);
    const go = await run(["plan", "authorize", "--scope", "ticket", "--ticket", "T1", "--note", "go ahead with T1"], h.root);
    const implementReady = await run(["run", "implement"], h.root);

    expect(written.code).toBe(EXIT_OK);
    expect(looksGood.code).toBe(EXIT_OK);
    expect(implementAsks.code).toBe(EXIT_NEEDS_HUMAN);
    expect(JSON.stringify(implementAsks.json()["outcome"])).toContain("execution.authorized");
    expect(go.code).toBe(EXIT_OK);
    expect((implementReady.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("ready");
  });

  it("asks about pre-existing changes and records the developer's answer", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    writeFileSync(join(h.root, "notes.md"), "mine\n");

    const asks = await run(["run", "implement"], h.root);
    const noNote = await run(["changes", "claim", "--owner", "developer"], h.root);
    const badOwner = await run(["changes", "claim", "--owner", "jflow", "--note", "x"], h.root);
    const claimed = await run(["changes", "claim", "notes.md", "--owner", "developer", "--note", "leave my notes"], h.root);
    const ready = await run(["run", "implement"], h.root);

    expect(asks.code).toBe(EXIT_NEEDS_HUMAN);
    expect(JSON.stringify(asks.json()["humanAsks"])).toContain("notes.md");
    expect(noNote.code).toBe(EXIT_NEEDS_HUMAN);
    expect(badOwner.code).toBe(EXIT_NEEDS_HUMAN);
    expect(claimed.code).toBe(EXIT_OK);
    expect(claimed.json()).toMatchObject({ ok: true, outcome: { unclaimedChanges: [] } });
    expect((ready.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("ready");
  });

  it("captures a todo mid-implementation, recommends next, and promotes only on the developer's words", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });

    const added = await run(["todo", "add", "CSV", "export", "drops", "headers", "--detail", "seen in T1"], h.root);
    const empty = await run(["todo", "add"], h.root);
    const listed = await run(["todo", "list"], h.root);
    const next = await run(["next"], h.root);
    const unworded = await run(["todo", "promote", "TODO-1"], h.root);
    const promoted = await run(["todo", "promote", "TODO-1", "--note", "fold it into this plan"], h.root);

    expect(added.code).toBe(EXIT_OK);
    expect(added.json()).toMatchObject({ ok: true, outcome: { item: { id: "TODO-1", summary: "CSV export drops headers" } } });
    expect(empty.code).toBe(EXIT_NEEDS_HUMAN);
    expect(listed.json()).toMatchObject({ ok: true, todos: { items: [{ id: "TODO-1" }] } });
    expect(next.code).toBe(EXIT_OK);
    expect(next.json()["outcome"]).toMatchObject({
      kind: "completed",
      action: "next",
      report: { recommendation: { action: "implement" }, openTodos: [{ id: "TODO-1" }] },
    });
    expect(unworded.code).toBe(EXIT_NEEDS_HUMAN);
    expect(promoted.json()).toMatchObject({ ok: true, outcome: { addTicketWith: "realign" } });
  });

  it("lists local traces and deletes them only on an explicit clean", async () => {
    const h = harness();
    h.writeFile(".jflow/traces/2026-09-23-escalate-abc.json", "{}\n");

    const listed = await run(["traces", "list"], h.root);
    const cleaned = await run(["traces", "clean"], h.root);
    const after = await run(["traces", "list"], h.root);

    expect(listed.json()).toEqual({ ok: true, traces: [".jflow/traces/2026-09-23-escalate-abc.json"], jevDecisions: [] });
    expect(cleaned.json()).toEqual({ ok: true, removed: [".jflow/traces/2026-09-23-escalate-abc.json"], jevDecisions: [] });
    expect(after.json()).toEqual({ ok: true, traces: [], jevDecisions: [] });
    expect((await run(["traces", "purge"], h.root)).code).toBe(EXIT_NEEDS_HUMAN);
  });

  it("records acceptance and whole-plan authorization from one instruction", async () => {
    const h = harness({ state: { specificationAccepted: true }, gitRepository: true });
    writeFileSync(
      join(h.root, "plan.json"),
      JSON.stringify({
        title: "p",
        summary: "s",
        tickets: [{ id: "T1", title: "t", acceptanceCriteria: ["c"], dependsOn: [] }],
      }),
    );
    await run(["plan", "write", "plan.json"], h.root);

    const both = await run(["plan", "accept", "--note", "approved, implement the whole plan", "--authorize", "plan"], h.root);

    expect(both.code).toBe(EXIT_OK);
    const outcome = both.json()["outcome"] as Record<string, Record<string, unknown>>;
    expect(outcome["plan"]?.["status"]).toBe("accepted");
    expect(outcome["progress"]?.["authorizationScope"]).toBe("plan");
    expect((await run(["plan", "accept", "--authorize", "sideways"], h.root)).code).toBe(EXIT_NEEDS_HUMAN);
    expect((await run(["plan", "authorize", "--scope", "plan"], h.root)).code).toBe(EXIT_NEEDS_HUMAN);
  });
});

describe("jflow helper CLI: Jev decisions and conflicts", () => {
  const KEY = "jev-test-key-0123456789";

  function jev(choice: string, reason: string): NonNullable<CliIo["jev"]> & { readonly sent: string[] } {
    const sent: string[] = [];
    const transport: JevTransport = async (request) => {
      sent.push(request.body);
      const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
      return {
        status: 200,
        body: JSON.stringify({
          model: "jev-1.13",
          answers: { [decision]: { choice, confidence: 0.99 }, [`${decision}.reason`]: { choice: reason } },
        }),
      };
    };
    return { env: { JFLOW_JEV_API_KEY: KEY }, transport, sent };
  }

  it("has next report the records' recommendation and ask the developer for a missing Jev key", async () => {
    const h = harness({ state: { specificationAccepted: true } });

    const next = await run(["next"], h.root);

    expect(next.code).toBe(EXIT_OK);
    expect(next.json()).toMatchObject({
      outcome: { report: { recommendation: { action: "plan" } } },
      jev: { kind: "needs-configuration", askHuman: expect.stringContaining("JFLOW_JEV_API_KEY") },
    });
  });

  it("has next ask next-action, and records a choice that sets the answer aside only with evidence", async () => {
    const h = harness({ state: { specificationAccepted: true } });
    const answering = jev("plan", "prerequisites-met");

    const next = await run(["next"], h.root, {}, answering);
    const reported = next.json()["jev"] as Record<string, unknown>;
    const envelope = String(reported["envelope"]);
    const shown = await run(["decide", "show", envelope], h.root);
    const unexplained = await run(["decide", "choose", envelope, "--action", "brainstorm", "--by", "agent"], h.root);
    const blocked = await run(
      ["decide", "choose", envelope, "--action", "implement", "--by", "agent", "--reason", "r", "--evidence", "e"],
      h.root,
    );
    const setAside = await run(
      [
        "decide",
        "choose",
        envelope,
        "--action",
        "brainstorm",
        "--by",
        "agent",
        "--reason",
        "the spec misses the export scenario",
        "--evidence",
        "jflow/specification.json#scenarios",
      ],
      h.root,
    );

    expect(answering.sent).toHaveLength(1);
    expect(reported).toMatchObject({ kind: "answered", answer: "plan", reasonCode: "prerequisites-met", route: "weigh" });
    expect(answering.sent[0]).not.toContain(KEY);
    expect(shown.json()).toMatchObject({ ok: true, envelope: { id: envelope, decision: "next-action" } });
    expect(unexplained.code).toBe(EXIT_NEEDS_HUMAN);
    expect(blocked.json()).toMatchObject({ ok: false, reason: expect.stringContaining("not permitted") });
    expect(setAside.code).toBe(EXIT_OK);
    expect(setAside.json()).toMatchObject({
      ok: true,
      envelope: { choice: { action: "brainstorm", by: "agent", followsAnswer: false } },
    });
  });

  it("asks a declared decision by name over a drafted input, and refuses an undeclared one", async () => {
    const h = harness();
    h.writeFile("input.json", JSON.stringify({ taskSummary: "T1 fix failed", candidates: [], excerpts: [] }));
    const answering = jev("escalate", "uncertain");

    const asked = await run(["decide", "ask", "escalate", "input.json"], h.root, {}, answering);
    const undeclared = await run(["decide", "ask", "disposition", "input.json"], h.root, {}, answering);

    expect(asked.code).toBe(EXIT_OK);
    expect(asked.json()).toMatchObject({ ok: true, decision: { kind: "answered", answer: "escalate", reasonCode: "uncertain" } });
    expect(undeclared.code).toBe(EXIT_NEEDS_HUMAN);
    expect(answering.sent).toHaveLength(1);
  });

  it("has learn propose a lesson, decide to retain it, and list what was saved", async () => {
    const h = harness();
    const lesson = {
      statement: "Reset the fixture clock before each parser test.",
      scope: "src/parser tests",
      evidence: [{ kind: "commit", reference: "a1b2c3d" }],
    };
    h.writeFile("lesson.json", JSON.stringify(lesson));
    h.writeFile("workflow-lesson.json", JSON.stringify({ ...lesson, scope: "workflow rules" }));
    const answering = jev("retain", "evidence-backed");

    const proposed = await run(["learn", "propose", "lesson.json"], h.root, {}, answering);
    const refused = await run(["learn", "propose", "workflow-lesson.json"], h.root, {}, answering);
    const incomplete = await run(["learn", "decide", "L-1", "--outcome", "kept"], h.root);
    const decided = await run(["learn", "decide", "L-1", "--outcome", "retained", "--by", "agent"], h.root);
    const listed = await run(["learn", "list"], h.root);

    expect(proposed.code).toBe(EXIT_OK);
    expect(proposed.json()).toMatchObject({
      ok: true,
      outcome: { lesson: { id: "L-1", status: "candidate" }, advice: { answer: "retain", route: "weigh" }, next: "decide" },
    });
    expect(refused.code).toBe(EXIT_NEEDS_HUMAN);
    // lesson-retention and classify's lesson-scope for the one lesson; the refused one asks nothing.
    expect(answering.sent).toHaveLength(2);
    expect(incomplete.code).toBe(EXIT_NEEDS_HUMAN);
    expect(decided.code).toBe(EXIT_OK);
    expect(decided.json()).toMatchObject({
      ok: true,
      outcome: { report: { saved: "retained", lesson: "L-1", evidence: lesson.evidence, record: "jflow/lessons.json" } },
    });
    expect(listed.json()).toMatchObject({ ok: true, lessons: [{ id: "L-1", status: "active" }] });
  });

  it("has learn check a retained lesson before use, supersede it with evidence, and leave it out of use after", async () => {
    const h = harness();
    h.writeFile("lesson.json", JSON.stringify({
      statement: "Reset the fixture clock before each parser test.",
      scope: "src/parser tests",
      evidence: [{ kind: "commit", reference: "a1b2c3d" }],
    }));
    await run(["learn", "propose", "lesson.json"], h.root, {}, jev("retain", "evidence-backed"));
    await run(["learn", "decide", "L-1", "--outcome", "retained", "--by", "agent"], h.root);

    const checked = await run(["learn", "check", "L-1", "--task", "T1 parser dates", "--outcome", "applies", "--reason", "T1 adds clock-reading tests"], h.root);
    const unreasoned = await run(["learn", "check", "L-1", "--task", "T2", "--outcome", "skipped"], h.root);
    const superseded = await run(
      ["learn", "supersede", "L-1", "--successor", "commit 7c7c7c7 resets the clock in the parser", "--evidence", "npm test -- parser passes without the reset", "--by", "agent"],
      h.root,
    );
    const active = await run(["learn", "active"], h.root);
    const reused = await run(["learn", "check", "L-1", "--task", "T3", "--outcome", "applies", "--reason", "r"], h.root);

    expect(checked.code).toBe(EXIT_OK);
    expect(checked.json()).toMatchObject({ ok: true, outcome: { apply: true } });
    expect(unreasoned.code).toBe(EXIT_NEEDS_HUMAN);
    expect(superseded.code).toBe(EXIT_OK);
    expect(superseded.json()).toMatchObject({ ok: true, outcome: { superseded: true, lesson: { status: "superseded" } } });
    expect(active.json()).toMatchObject({ ok: true, lessons: [] });
    expect(reused.code).toBe(EXIT_NEEDS_HUMAN);
  });

  it("has wrap write the resume record, exit 1 on a discrepancy, and show it", async () => {
    const h = harness({ state: { specificationAccepted: true } });
    // Drafts live outside the project's working tree, as the skill writes them.
    const drafts = harness();
    drafts.writeFile("clean.json", JSON.stringify({ summary: "specified the importer", nextSteps: ["run plan"] }));
    drafts.writeFile(
      "found.json",
      JSON.stringify({ summary: "specified the importer", discrepancies: [{ summary: "the spec names a file that does not exist" }] }),
    );

    const missing = await run(["wrap", "show"], h.root);
    const clean = await run(["wrap", drafts.path("clean.json")], h.root);
    const shown = await run(["wrap", "show"], h.root);
    const found = await run(["wrap", drafts.path("found.json")], h.root);

    expect(missing.code).toBe(EXIT_NEEDS_HUMAN);
    expect(clean.code).toBe(EXIT_OK);
    expect(clean.json()).toMatchObject({ ok: true, outcome: { record: "jflow/resume.json", discrepancies: [] } });
    expect(shown.json()).toMatchObject({ ok: true, resume: { summary: "specified the importer", nextSteps: ["run plan"], recommendation: { action: "plan" } } });
    expect(found.code).toBe(EXIT_NEEDS_HUMAN);
    expect(found.json()).toMatchObject({ ok: true, outcome: { discrepancies: [{ source: "agent" }] } });
  });

  it("has replay re-ask stored envelopes under a proposed threshold, and say when there is nothing to replay", async () => {
    const h = harness();
    h.writeFile("boundary.json", JSON.stringify({ kind: "fix-failed", summary: "T3 fix failed twice", excerpts: [] }));
    await run(["escalate", "boundary.json"], h.root, {}, jev("proceed", "routine"));

    const replayed = await run(["replay", "escalate", "--threshold", "1"], h.root, {}, jev("proceed", "routine"));
    const nothing = await run(["replay", "validate", "--threshold", "0.5"], h.root, {}, jev("met", "evidence-satisfies"));
    const unproposed = await run(["replay", "escalate"], h.root);
    const blank = await run(["replay", "escalate", "--threshold", " "], h.root);

    expect(replayed.code).toBe(EXIT_OK);
    expect(replayed.json()).toMatchObject({
      ok: true,
      report: { decision: "escalate", replayed: 1, changed: 1, routeChanges: [{ from: "act", to: "ask-human", count: 1 }] },
    });
    expect(nothing.code).toBe(EXIT_NEEDS_HUMAN);
    expect(nothing.json()).toMatchObject({ ok: true, report: { envelopes: 0, nothingToReplay: expect.any(String) } });
    expect(unproposed.code).toBe(EXIT_NEEDS_HUMAN);
    expect(blank.code).toBe(EXIT_NEEDS_HUMAN);
  });

  it("has resume report where the work stands without writing, and reconcile ask escalate about each discrepancy", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" } });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({ tickets: [{ id: "T1", title: "parse", acceptanceCriteria: ["parses"], dependsOn: [], status: "in-progress" }] }),
    );
    h.writeFile("reconcile.json", JSON.stringify({ discrepancies: [{ ticketId: "T1", summary: "the parser test now fails", evidence: ["npm test: 1 failed"] }] }));
    const before = h.snapshot();

    const shown = await run(["resume"], h.root);
    const unchanged = h.snapshot();
    const reconciled = await run(["resume", "reconcile", "reconcile.json"], h.root, {}, jev("escalate", "uncertain"));

    expect(shown.code).toBe(EXIT_OK);
    expect(shown.json()).toMatchObject({ ok: true, report: { authorization: { executionAuthorized: true }, continueWith: { ticketId: "T1" } } });
    expect(unchanged).toEqual(before);
    expect(reconciled.code).toBe(EXIT_NEEDS_HUMAN);
    expect(reconciled.json()).toMatchObject({ ok: true, outcome: { discrepancies: [{ ticketId: "T1", ask: true }] } });
  });

  it("has realign record a recommendation that starts nothing, and realign the plan only with the developer's words", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" } });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({ tickets: [{ id: "T1", title: "parse", acceptanceCriteria: ["parses"], dependsOn: [], status: "in-progress" }] }),
    );
    h.writeFile("realign.json", JSON.stringify({ direction: "also parse TSV", changes: [{ action: "rescope", ticketId: "T1", acceptanceCriteria: ["parses CSV", "parses TSV"] }] }));

    const recommended = await run(["realign", "recommend", "--source", "review", "--summary", "TSV input showed up"], h.root);
    const planBefore = h.snapshot()["jflow/plan.json"];
    const unsaid = await run(["realign", "realign.json"], h.root);
    const realigned = await run(["realign", "realign.json", "--note", "yes, add TSV"], h.root);
    const shown = await run(["realign", "show"], h.root);

    expect(recommended.code).toBe(EXIT_OK);
    expect(recommended.json()).toMatchObject({ ok: true, outcome: { recommendation: { id: "R-1", status: "open" } } });
    expect(planBefore).toContain('"accepted"');
    expect(unsaid.code).toBe(EXIT_NEEDS_HUMAN);
    expect(realigned.code).toBe(EXIT_OK);
    expect(realigned.json()).toMatchObject({ ok: true, outcome: { realignment: { id: "RA-1", note: "yes, add TSV" } } });
    expect(h.snapshot()["jflow/plan.json"]).toContain('"awaiting-acceptance"');
    expect(shown.json()).toMatchObject({ ok: true, realign: { recommendations: [{ id: "R-1" }], realignments: [{ id: "RA-1" }] } });
  });

  it("has proposal draft a change from recurring observations, and change the package only on accept", async () => {
    const h = harness();
    const packageDirectory = mkdtempSync(join(tmpdir(), "jflow-package-"));
    cpSync(SHIPPED_PACKAGE_DIRECTORY, packageDirectory, { recursive: true });
    try {
      for (const ticket of ["T1", "T2"]) {
        h.writeFile("boundary.json", JSON.stringify({ kind: "fix-failed", summary: `${ticket} fix failed once`, excerpts: [] }));
        await run(["escalate", "boundary.json"], h.root, {}, jev("escalate", "uncertain"));
      }

      const observations = await run(["proposal", "observations"], h.root);
      const patterns = await run(["proposal", "patterns"], h.root);
      const [pattern] = patterns.json()["patterns"] as { observations: string[] }[];
      h.writeFile(
        "proposal.json",
        JSON.stringify({ decision: "escalate", change: { kind: "authority", authority: "advisory" }, observations: pattern!.observations, rationale: "Fix failures escalate every time." }),
      );
      const drafted = await run(["proposal", "draft", "proposal.json"], h.root, {}, { env: {}, transport: noJev }, packageDirectory);
      const untouched = readFileSync(join(packageDirectory, "jflow.workflow.json"), "utf8");
      const unsaid = await run(["proposal", "accept", "P-1"], h.root, {}, undefined, packageDirectory);
      const accepted = await run(["proposal", "accept", "P-1", "--note", "Make it advisory."], h.root, {}, undefined, packageDirectory);
      const listed = await run(["proposal", "list"], h.root);

      expect(observations.code).toBe(EXIT_OK);
      expect(observations.json()).toMatchObject({ ok: true, observations: [{ kind: "escalation" }, { kind: "escalation" }] });
      expect(pattern!.observations).toHaveLength(2);
      expect(drafted.code).toBe(EXIT_OK);
      expect(drafted.json()).toMatchObject({ ok: true, outcome: { proposal: { id: "P-1", status: "pending", replay: { replayed: 2 } } } });
      expect(untouched).toBe(readFileSync(join(SHIPPED_PACKAGE_DIRECTORY, "jflow.workflow.json"), "utf8"));
      expect(unsaid.code).toBe(EXIT_NEEDS_HUMAN);
      expect(accepted.code).toBe(EXIT_OK);
      expect(loadWorkflowPackage(packageDirectory).decisions["escalate"]!.authority).toBe("advisory");
      expect(listed.json()).toMatchObject({ ok: true, proposals: [{ id: "P-1", status: "accepted" }] });
    } finally {
      rmSync(packageDirectory, { recursive: true, force: true });
    }
  });

  it("has worker recommend ask model-selection over the stage's options, and worker assign record following it", async () => {
    const h = harness();
    const drafts = harness();
    drafts.writeFile(
      "config.json",
      JSON.stringify({ stageModels: { implement: { model: "worker-a", efforts: ["low", "high"] } } }),
    );
    drafts.writeFile("draft.json", JSON.stringify({ stage: "implement", role: "implementer", ticketId: "T1", task: "parse dates" }));
    const config = ["--config", drafts.path("config.json")];

    const recommended = await run(["worker", "recommend", drafts.path("draft.json"), ...config], h.root, {}, jev("worker-a @ high", "needs-higher-effort"));
    const envelope = (recommended.json()["outcome"] as { decision: { envelope: string } }).decision.envelope;
    drafts.writeFile(
      "assign.json",
      JSON.stringify({ stage: "implement", role: "implementer", agent: "worker-1", model: "worker-a", effort: "high", ticketId: "T1", selection: { envelope } }),
    );
    const assigned = await run(["worker", "assign", drafts.path("assign.json"), ...config], h.root);
    const unkeyed = await run(["worker", "recommend", drafts.path("draft.json"), ...config], h.root);

    expect(recommended.code).toBe(EXIT_OK);
    expect(recommended.json()).toMatchObject({ ok: true, outcome: { kind: "recommended", recommendation: { model: "worker-a", effort: "high" } } });
    expect(assigned.code).toBe(EXIT_OK);
    expect(assigned.json()).toMatchObject({ ok: true, outcome: { assignment: { effort: "high", selection: envelope } } });
    expect(unkeyed.code).toBe(EXIT_NEEDS_HUMAN);
  });

  it("has classify refuse a review finding, block an untestable plan, and route an item before it is recorded", async () => {
    const h = harness({ state: { specificationAccepted: true } });
    const drafts = harness();
    drafts.writeFile("finding.json", JSON.stringify({ kind: "review-finding", summary: "off by one", excerpts: [] }));
    drafts.writeFile(
      "plan.json",
      JSON.stringify({ title: "P", summary: "S", tickets: [{ id: "T1", title: "Button", acceptanceCriteria: ["it feels right"], dependsOn: [] }] }),
    );

    const finding = await run(["decide", "ask", "classify", drafts.path("finding.json")], h.root, {}, jev("todo", "clear-match"));
    const blocked = await run(["plan", "write", drafts.path("plan.json")], h.root, {}, jev("untestable", "clear-match"));
    const routed = await run(["todo", "route", "the", "export", "button", "is", "misaligned"], h.root, {}, jev("todo", "clear-match"));
    const envelope = (routed.json()["outcome"] as { envelope: string }).envelope;
    const recorded = await run(["todo", "add", "the", "export", "button", "is", "misaligned", "--routing", envelope], h.root);

    expect(finding.code).toBe(EXIT_NEEDS_HUMAN);
    expect(finding.json()).toMatchObject({ ok: false, reason: expect.stringContaining("review finding") });
    expect(blocked.code).toBe(EXIT_NEEDS_HUMAN);
    expect(blocked.json()).toMatchObject({ ok: false, untestable: [{ ticketId: "T1", criterion: 0 }] });
    expect(routed.code).toBe(EXIT_OK);
    expect(recorded.json()).toMatchObject({ ok: true, outcome: { item: { routing: { envelope, answer: "todo" } } } });
  });

  it("asks escalate at a boundary: proceed exits 0 with no ask, escalate and hard rules exit 1 with one", async () => {
    const h = harness();
    h.writeFile("boundary.json", JSON.stringify({ kind: "fix-failed", summary: "T3 fix failed twice", excerpts: [] }));
    h.writeFile("gate.json", JSON.stringify({ kind: "plan-acceptance", summary: "the breakdown is ready", excerpts: [] }));
    const proceeding = jev("proceed", "routine");
    const escalating = jev("escalate", "consequential");

    const proceeded = await run(["escalate", "boundary.json"], h.root, {}, proceeding);
    const escalated = await run(["escalate", "boundary.json"], h.root, {}, escalating);
    const gated = await run(["escalate", "gate.json"], h.root, {}, escalating);

    expect(proceeded.code).toBe(EXIT_OK);
    expect(proceeded.json()).toMatchObject({ ok: true, ask: false, decision: { answer: "proceed", route: "act" } });
    expect(proceeded.json()).not.toHaveProperty("askHuman");
    expect(escalated.code).toBe(EXIT_NEEDS_HUMAN);
    expect(escalated.json()).toMatchObject({
      ok: true,
      ask: true,
      askHuman: { kind: "human-ask", boundary: "fix-failed", reasonCode: "consequential" },
    });
    expect(gated.code).toBe(EXIT_NEEDS_HUMAN);
    expect(gated.json()).toMatchObject({ ok: true, kind: "hard-rule", askHuman: { boundary: "plan-acceptance" } });
    expect(escalating.sent).toHaveLength(1);
  });

  it("validates a ticket over recorded evidence and sets a not-met verdict aside only with evidence", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true } });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({
        tickets: [{ id: "T1", title: "Parser", acceptanceCriteria: ["parses an empty file"], dependsOn: [], status: "in-progress" }],
      }),
    );
    h.writeFile(
      "evidence.json",
      JSON.stringify({ ticketId: "T1", evidence: [], checks: ["npm test"] }),
    );
    const answering = jev("not-met", "evidence-contradicts");

    const validated = await run(["ticket", "validate", "evidence.json"], h.root, {}, answering);
    const override = ["ticket", "override", "T1", "--criterion", "0", "--verdict", "met", "--by", "agent", "--reason", "flaky"];
    const unexplained = await run(override, h.root, {}, answering);
    const overridden = await run([...override, "--evidence", "npm test: 1 passed on rerun"], h.root, {}, answering);

    expect(validated.code).toBe(EXIT_OK);
    expect(validated.json()).toMatchObject({ ok: true, kind: "validated", validation: { disposition: "returned-to-fix" } });
    expect(unexplained.code).toBe(EXIT_NEEDS_HUMAN);
    expect(unexplained.json()).toMatchObject({ ok: false, reason: expect.stringContaining("evidence-based reason") });
    expect(overridden.code).toBe(EXIT_OK);
    expect(overridden.json()).toMatchObject({ ok: true, validation: { disposition: "admitted-to-review" } });
  });

  it("lists every Jev decision a command asked in its output, and none when it asked nothing", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({
        tickets: [{ id: "T1", title: "T1", acceptanceCriteria: ["parses an empty file", "reports a bad date"], dependsOn: [], status: "ready" }],
      }),
    );
    const started = await run(["implement", "start"], h.root);
    h.writeFile("named.json", JSON.stringify({ ticketId: "T1", evidence: [], checks: ["npm test"] }));
    const checked = await run(["implement", "check", "named.json"], h.root, {}, jev("met", "evidence-satisfies"));

    expect(started.json()).toMatchObject({ ok: true, jevDecisions: [] });
    const decisions = checked.json()["jevDecisions"] as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(2);
    for (const entry of decisions) {
      expect(entry).toMatchObject({
        decision: "validate",
        status: "answered",
        answer: "met",
        confidence: expect.any(Number),
        threshold: expect.any(Number),
        route: expect.any(String),
        envelope: expect.stringMatching(/^ENV-/),
      });
    }
  });

  it("runs the ticket's checks itself and refuses check output the agent wrote", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({ tickets: [{ id: "T1", title: "T1", acceptanceCriteria: ["parses an empty file"], dependsOn: [], status: "ready" }] }),
    );
    await run(["implement", "start"], h.root);
    h.writeFile(
      "written.json",
      JSON.stringify({ ticketId: "T1", evidence: [{ kind: "check", source: "npm test", text: "41 tests passed", exitCode: 0 }], checks: ["npm test"] }),
    );
    h.writeFile("named.json", JSON.stringify({ ticketId: "T1", evidence: [], checks: ["npm test"] }));
    const answering = jev("met", "evidence-satisfies");

    const written = await run(["implement", "check", "written.json"], h.root, {}, answering);
    const named = await run(["implement", "check", "named.json"], h.root, {}, answering);

    expect(written.code).toBe(EXIT_NEEDS_HUMAN);
    expect(written.json()).toMatchObject({ ok: false, reason: expect.stringContaining("jflow runs the checks itself") });
    expect(named.code).toBe(EXIT_OK);
    const stored = JSON.parse(readFileSync(join(h.root, ".jflow/evidence/T1.json"), "utf8")) as { evidence: unknown[] };
    expect(stored.evidence).toEqual([{ kind: "check", source: "npm test", text: "ran npm test\n1 passed", exitCode: 0 }]);
    expect(answering.sent[0]).toContain("ran npm test");
  });

  it("starts only the authorized ticket and checks it through validate, recording the evidence", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    const ticket = (id: string) => ({ id, title: id, acceptanceCriteria: ["parses an empty file"], dependsOn: [], status: "ready" });
    h.writeFile("jflow/tickets.json", JSON.stringify({ tickets: [ticket("T1"), ticket("T2")] }));

    const started = await run(["implement", "start"], h.root);
    const second = await run(["implement", "start", "T2"], h.root);
    h.writeFile(
      "evidence.json",
      JSON.stringify({ ticketId: "T1", evidence: [], checks: ["npm test"] }),
    );
    const checked = await run(["implement", "check", "evidence.json"], h.root, {}, jev("met", "evidence-satisfies"));

    expect(started.code).toBe(EXIT_OK);
    expect(started.json()).toMatchObject({ ok: true, outcome: { ticket: { id: "T1", status: "in-progress" } } });
    expect(second.code).toBe(EXIT_NEEDS_HUMAN);
    expect(second.json()).toMatchObject({ ok: false, reason: expect.stringContaining("authorized for ticket T1 only") });
    expect(checked.code).toBe(EXIT_OK);
    expect(checked.json()).toMatchObject({
      ok: true,
      kind: "validated",
      validation: { disposition: "admitted-to-review" },
      evidence: ".jflow/evidence/T1.json",
    });
  });

  it("reviews an admitted ticket with a distinct reviewer, blocking on a finding and filing an improvement", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({ tickets: [{ id: "T1", title: "T1", acceptanceCriteria: ["parses an empty file"], dependsOn: [], status: "ready" }] }),
    );
    await run(["implement", "start"], h.root);
    const early = await run(["review", "start"], h.root);
    h.writeFile(
      "evidence.json",
      JSON.stringify({ ticketId: "T1", evidence: [], checks: ["npm test"] }),
    );
    await run(["implement", "check", "evidence.json"], h.root, {}, jev("met", "evidence-satisfies"));
    const started = await run(["review", "start"], h.root);
    const findings = [
      { kind: "correctness", summary: "empty input throws", evidence: ["src/parse.ts:3"] },
      { kind: "improvement", summary: "name the magic number" },
    ];
    h.writeFile("self.json", JSON.stringify({ ticketId: "T1", reviewer: { agent: "primary" }, findings }));
    h.writeFile("review.json", JSON.stringify({ ticketId: "T1", reviewer: { agent: "reviewer-1" }, findings }));
    const self = await run(["review", "record", "self.json"], h.root);
    const recorded = await run(["review", "record", "review.json"], h.root);
    const decided = await run(["review", "decide", "T1", "--finding", "F1", "--outcome", "withdrawn", "--note", "fine"], h.root);

    expect(early.code).toBe(EXIT_NEEDS_HUMAN);
    expect(early.json()).toMatchObject({ ok: false, reason: expect.stringContaining("validate") });
    expect(started.code).toBe(EXIT_OK);
    expect(started.json()).toMatchObject({ ok: true, outcome: { ticket: { id: "T1" }, evidence: ".jflow/evidence/T1.json" } });
    expect(self.code).toBe(EXIT_NEEDS_HUMAN);
    expect(recorded.code).toBe(EXIT_OK);
    expect(recorded.json()).toMatchObject({
      ok: true,
      review: { disposition: "returned-to-fix", findings: [{ disposition: "blocking" }, { disposition: "todo", todo: "TODO-1" }] },
      fix: { attempts: 0 },
    });
    expect(decided.code).toBe(EXIT_NEEDS_HUMAN);
    expect(decided.json()).toMatchObject({ ok: false, reason: expect.stringContaining("not waiting") });

    const refused = await run(["implement", "complete"], h.root);
    expect(refused.code).toBe(EXIT_NEEDS_HUMAN);
    expect(refused.json()).toMatchObject({ ok: false, reason: expect.stringContaining("validate") });

    await run(["implement", "check", "evidence.json"], h.root, {}, jev("met", "evidence-satisfies"));
    h.writeFile("clean.json", JSON.stringify({ ticketId: "T1", reviewer: { agent: "reviewer-2" }, findings: [] }));
    await run(["review", "record", "clean.json"], h.root);
    const completed = await run(["implement", "complete"], h.root);
    expect(completed.code).toBe(EXIT_OK);
    expect(completed.json()).toMatchObject({
      ok: true,
      outcome: { ticket: { id: "T1", status: "done" }, commit: { hash: expect.any(String) }, authorization: "ended" },
    });
  });

  it("troubleshoots a failed check without edits, then records the fix under the started ticket", async () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    h.writeFile(
      "jflow/tickets.json",
      JSON.stringify({ tickets: [{ id: "T1", title: "T1", acceptanceCriteria: ["parses an empty file"], dependsOn: [], status: "ready" }] }),
    );
    await run(["implement", "start"], h.root);
    const drafts = join(h.root, ".jflow");
    h.writeFile(".jflow/written.json", JSON.stringify({ check: { source: "npm test", text: "1 failed", exitCode: 1 } }));
    h.writeFile(".jflow/passing.json", JSON.stringify({ check: { source: "npm test" } }));
    h.writeFile(".jflow/failure.json", JSON.stringify({ check: { source: "npm test # failing" } }));
    h.writeFile(".jflow/diagnosis.json", JSON.stringify({ id: "DIAG-1", finding: "empty input", evidence: ["src/p.ts:1"], recommendation: "return []" }));

    const written = await run(["troubleshoot", "start", join(drafts, "written.json")], h.root);
    const passing = await run(["troubleshoot", "start", join(drafts, "passing.json")], h.root);
    const started = await run(["troubleshoot", "start", join(drafts, "failure.json")], h.root);
    const recorded = await run(["troubleshoot", "record", join(drafts, "diagnosis.json")], h.root);
    const fixed = await run(["implement", "fix", "DIAG-1", "--note", "returned []"], h.root);

    expect(written.json()).toMatchObject({ ok: false, reason: expect.stringContaining("jflow runs the failed check itself") });
    expect(passing.json()).toMatchObject({ ok: false, reason: expect.stringContaining("exited 0") });
    expect(started.code).toBe(EXIT_OK);
    expect(started.json()).toMatchObject({
      ok: true,
      outcome: { diagnosis: { id: "DIAG-1", ticketId: "T1", check: { source: "npm test # failing", exitCode: 1 } } },
    });
    expect(JSON.stringify(started.json())).toContain("ran npm test # failing");
    expect(recorded.json()).toMatchObject({ ok: true, outcome: { diagnosis: { status: "diagnosed" } } });
    expect(fixed.code).toBe(EXIT_OK);
    expect(fixed.json()).toMatchObject({ ok: true, outcome: { diagnosis: { status: "applied", application: { ticketId: "T1" } } } });
  });

  it("parks a blocked ticket, records an independence check, and moves to the next ticket on escalate's proceed", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
    const ticket = (id: string) => ({ id, title: id, acceptanceCriteria: [`${id} works`], dependsOn: [], status: "ready" });
    h.writeFile("jflow/tickets.json", JSON.stringify({ tickets: [ticket("T1"), ticket("T2")] }));
    await run(["plan", "authorize", "--scope", "plan", "--note", "implement the whole plan"], h.root);
    const first = await run(["implement", "next"], h.root, {}, jev("proceed", "routine"));
    expect(first.json()).toMatchObject({ kind: "started", ticket: { id: "T1" } });

    const parked = await run(["implement", "park", "T1", "--blocker", "the date format is undecided"], h.root);
    const unchecked = await run(["implement", "next"], h.root);
    h.writeFile(
      ".jflow/check.json",
      JSON.stringify({ ticketId: "T2", dependencies: "none", decisions: "T2 has no dates", partialEdits: "T1 left none" }),
    );
    const checked = await run(["implement", "independence", join(h.root, ".jflow", "check.json")], h.root);
    const next = await run(["implement", "next"], h.root, {}, jev("proceed", "routine"));

    expect(parked.json()).toMatchObject({ ok: true, outcome: { ticket: { status: "parked" } } });
    expect(unchecked.code).toBe(EXIT_OK);
    expect(unchecked.json()).toMatchObject({ kind: "needs-independence-check", candidates: ["T2"] });
    expect(checked.json()).toMatchObject({ ok: true, outcome: { check: { parked: ["T1"] } } });
    expect(next.code).toBe(EXIT_OK);
    expect(next.json()).toMatchObject({ ok: true, kind: "started", ticket: { id: "T2" } });
  });

  it("reviews a finished multi-ticket plan as a whole before it is complete", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true }, gitRepository: true });
    const ticket = (id: string) => ({ id, title: id, acceptanceCriteria: [`${id} works`], dependsOn: [], status: "done" });
    h.writeFile("jflow/tickets.json", JSON.stringify({ tickets: [ticket("T1"), ticket("T2")] }));
    h.writeFile(".jflow/plan-review.json", JSON.stringify({ reviewer: { agent: "plan-reviewer" }, findings: [] }));

    const started = await run(["review", "plan", "start"], h.root);
    const recorded = await run(["review", "plan", "record", join(h.root, ".jflow", "plan-review.json")], h.root);
    const again = await run(["review", "plan", "start"], h.root);

    expect(started.code).toBe(EXIT_OK);
    expect(started.json()).toMatchObject({ ok: true, outcome: { tickets: [{ id: "T1" }, { id: "T2" }], planCriteria: ["seeded"] } });
    expect(recorded.code).toBe(EXIT_OK);
    expect(recorded.json()).toMatchObject({ ok: true, review: { scope: "integrated", disposition: "passed" } });
    expect(again.json()).toMatchObject({ ok: false, reason: expect.stringContaining("complete") });
  });

  it("records a stage worker on its configured model, and asks when the model is unavailable with no fallback", async () => {
    const h = harness();
    h.writeFile("cfg/models.json", JSON.stringify({ stageModels: { implement: { model: "builder-model" } } }));
    h.writeFile(
      ".jflow/worker.json",
      JSON.stringify({ stage: "implement", role: "implementer", agent: "worker-1", model: "builder-model" }),
    );
    h.writeFile(
      ".jflow/down.json",
      JSON.stringify({
        stage: "implement",
        role: "implementer",
        agent: "worker-2",
        model: "anything",
        unavailable: { model: "builder-model", reason: "unavailable" },
      }),
    );
    const config = join(h.root, "cfg", "models.json");

    const assigned = await run(["worker", "assign", join(h.root, ".jflow", "worker.json"), "--config", config], h.root);
    const down = await run(["worker", "assign", join(h.root, ".jflow", "down.json"), "--config", config], h.root);
    const finished = await run(["worker", "finish", "W-1"], h.root);

    expect(assigned.code).toBe(EXIT_OK);
    expect(assigned.json()).toMatchObject({ ok: true, outcome: { assignment: { id: "W-1", model: "builder-model" } } });
    expect(down.code).toBe(EXIT_NEEDS_HUMAN);
    expect(down.json()).toMatchObject({ ok: true, outcome: { askHuman: expect.anything() } });
    expect(finished.json()).toMatchObject({ ok: true, outcome: { assignment: { status: "finished" } } });
  });

  it("retries a failing Jev, then waits for the developer's approval to go on without it, shown in status", async () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" } });
    const sent: string[] = [];
    const down: NonNullable<CliIo["jev"]> = {
      env: { JFLOW_JEV_API_KEY: KEY },
      transport: async (request) => {
        sent.push(request.body);
        return { status: 503, body: "overloaded" };
      },
      sleep: async () => undefined,
    };
    h.writeFile(".jflow/input.json", JSON.stringify({ taskSummary: "what next", candidates: [], excerpts: [] }));

    const asked = await run(["decide", "ask", "next-action", join(h.root, ".jflow", "input.json")], h.root, {}, down);
    const approved = await run(["jev", "approve", "--scope", "ticket", "--note", "go on without it for T1"], h.root);
    const status = await run(["status"], h.root);

    expect(sent).toHaveLength(3);
    expect(asked.code).toBe(EXIT_NEEDS_HUMAN);
    expect(asked.json()).toMatchObject({ decision: { kind: "failed", attempts: 3, fallback: "awaiting-approval" } });
    expect(approved.json()).toMatchObject({ ok: true, outcome: { fallback: { status: "approved", scope: "ticket", scopeId: "T1" } } });
    expect(JSON.stringify(status.json())).toContain('"status": "approved"'.replace(": ", ":"));
  });

  it("escalates a consequential conflict and records the developer's decision", async () => {
    const h = harness();
    h.writeFile("conflict.json", JSON.stringify({ summary: "review wants an excluded flag", touches: ["scope"] }));

    const raised = await run(["conflict", "raise", "conflict.json"], h.root);
    const decided = await run(["conflict", "decide", "C1", "--note", "leave it out"], h.root);

    expect(raised.code).toBe(EXIT_NEEDS_HUMAN);
    expect(raised.json()).toMatchObject({ ok: true, outcome: { askHuman: { kind: "human-ask" } } });
    expect(decided.json()).toMatchObject({ ok: true, outcome: { conflict: { status: "resolved" } } });
  });
});
