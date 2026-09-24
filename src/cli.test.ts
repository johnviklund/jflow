import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_NEEDS_HUMAN, EXIT_OK, EXIT_UNREADABLE, runCli, type CliIo } from "./cli.js";
import type { JevTransport } from "./jev/client.js";
import { createProjectHarness, type ProjectHarness } from "./testing/harness.js";

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
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    hostProbes: { env, exec: () => "git version test" },
    jev,
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

    expect(listed.json()).toEqual({ ok: true, traces: [".jflow/traces/2026-09-23-escalate-abc.json"] });
    expect(cleaned.json()).toEqual({ ok: true, removed: [".jflow/traces/2026-09-23-escalate-abc.json"] });
    expect(after.json()).toEqual({ ok: true, traces: [] });
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
      JSON.stringify({ ticketId: "T1", evidence: [{ kind: "check", source: "npm test", text: "1 failed", exitCode: 1 }], checks: ["npm test"] }),
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
      JSON.stringify({ ticketId: "T1", evidence: [{ kind: "check", source: "npm test", text: "1 passed", exitCode: 0 }], checks: ["npm test"] }),
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
