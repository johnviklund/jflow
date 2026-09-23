import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_NEEDS_HUMAN, EXIT_OK, EXIT_UNREADABLE, runCli } from "./cli.js";
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

function run(argv: readonly string[], cwd: string, env: Record<string, string> = {}): Run {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    hostProbes: { env, exec: () => "git version test" },
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
}

describe("jflow helper CLI", () => {
  it("prints usage for help and for no command", () => {
    const h = harness();

    expect(run(["help"], h.root).stdout).toContain("Usage");
    expect(run([], h.root).code).toBe(EXIT_OK);
  });

  it("reports status as JSON against the current directory", () => {
    const h = harness({ state: { specificationAccepted: true } });

    const result = run(["status"], h.root);

    expect(result.code).toBe(EXIT_OK);
    const outcome = result.json()["outcome"] as Record<string, unknown>;
    expect(outcome["kind"]).toBe("completed");
    expect((outcome["report"] as Record<string, unknown>)["project"]).toBe("initialized");
  });

  it("runs a named action and a sentence to the same outcome, honouring --root", () => {
    const h = harness({ state: { specificationAccepted: true } });
    const elsewhere = harness();

    const named = run(["run", "plan", "--root", h.root], elsewhere.root);
    const spoken = run(["run", "break", "the", "spec", "into", "tickets", "--root", h.root], elsewhere.root);

    expect(named.code).toBe(EXIT_OK);
    expect(named.json()["outcome"]).toEqual(spoken.json()["outcome"]);
    expect((named.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("ready");
  });

  it("returns the clarifying question and a needs-human exit for an ambiguous request", () => {
    const h = harness();

    const result = run(["run", "should", "I", "troubleshoot", "or", "review?"], h.root);

    expect(result.code).toBe(EXIT_NEEDS_HUMAN);
    const outcome = result.json()["outcome"] as Record<string, unknown>;
    expect(outcome["kind"]).toBe("clarify");
    expect(result.json()["humanAsks"]).toHaveLength(1);
  });

  it("refuses a blocked action naming the unmet prerequisites", () => {
    const h = harness({ state: { specificationAccepted: true, planAccepted: true } });

    const result = run(["run", "implement"], h.root);

    expect(result.code).toBe(EXIT_NEEDS_HUMAN);
    const outcome = result.json()["outcome"] as Record<string, unknown>;
    expect(outcome["kind"]).toBe("blocked");
    expect(JSON.stringify(outcome)).toContain("execution.authorized");
  });

  it("reports an unreadable project record with the unreadable exit code", () => {
    const h = harness({ state: { specificationAccepted: true } });
    h.writeFile("jflow/progress.json", "{ broken");

    const result = run(["run", "plan"], h.root);

    expect(result.code).toBe(EXIT_UNREADABLE);
    expect((result.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("malformed-record");
  });

  it("validates the package and a configuration file before anything runs", () => {
    const h = harness();
    mkdirSync(join(h.root, "cfg"));
    writeFileSync(join(h.root, "cfg", "bad.json"), JSON.stringify({ stageModels: { deploy: { model: "x" } } }));
    writeFileSync(join(h.root, "cfg", "good.json"), JSON.stringify({ stageModels: { implement: { model: "x" } } }));

    const bad = run(["validate", "--config", "cfg/bad.json"], h.root);
    const good = run(["validate", "--config", "cfg/good.json"], h.root);
    const missing = run(["validate", "--config", "cfg/none.json"], h.root);

    expect(bad.code).toBe(EXIT_NEEDS_HUMAN);
    expect(JSON.stringify(bad.json()["configuration"])).toContain("stageModels.deploy");
    expect(good.code).toBe(EXIT_OK);
    expect(good.json()["ok"]).toBe(true);
    expect(missing.code).toBe(EXIT_UNREADABLE);
  });

  it("reports host capabilities with verified/unverified labels", () => {
    const h = harness();

    const result = run(["check-host"], h.root);

    expect(result.code).toBe(EXIT_OK);
    const results = result.json()["results"] as { capability: string; status: string }[];
    expect(results.find((r) => r.capability === "shell")?.status).toBe("verified");
    expect(results.find((r) => r.capability === "pinned-worker-model")?.status).toBe("unverified");
  });

  it("rejects an unknown command, an unknown option and an option without a value", () => {
    const h = harness();

    expect(run(["deploy"], h.root).code).toBe(EXIT_NEEDS_HUMAN);
    const dangling = run(["status", "--root"], h.root);
    expect(dangling.code).toBe(EXIT_NEEDS_HUMAN);
    expect(dangling.stderr).toContain("--root");
    const unknown = run(["status", "--verbose", "yes"], h.root);
    expect(unknown.code).toBe(EXIT_NEEDS_HUMAN);
    expect(unknown.stderr).toContain("--verbose");
  });

  it("takes a specification from draft to acceptance, after which plan is ready", () => {
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

    const written = run(["specification", "write", "draft.json"], h.root);
    const planBefore = run(["run", "plan"], h.root);
    const tooEarly = run(["specification", "accept"], h.root);
    const noBasis = run(["specification", "confirm", "D1"], h.root);
    const confirmed = run(["specification", "confirm", "D1", "--basis", "developer said yes"], h.root);
    const accepted = run(["specification", "accept", "--note", "yes, exactly that"], h.root);
    const planAfter = run(["run", "plan"], h.root);

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

  it("reports a missing draft file as unreadable and a bad subcommand as needing the developer", () => {
    const h = harness();

    expect(run(["specification", "write", "none.json"], h.root).code).toBe(EXIT_UNREADABLE);
    expect(run(["specification", "frobnicate"], h.root).code).toBe(EXIT_NEEDS_HUMAN);
    expect(run(["specification", "confirm"], h.root).code).toBe(EXIT_NEEDS_HUMAN);
  });

  it("takes a plan from draft to acceptance, keeping authorization a separate recorded step", () => {
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

    const refused = run(["plan", "write", draft], h.root);
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
    const written = run(["plan", "write", draft], h.root);
    const looksGood = run(["plan", "accept", "--note", "looks good"], h.root);
    const implementAsks = run(["run", "implement"], h.root);
    const go = run(["plan", "authorize", "--scope", "ticket", "--ticket", "T1", "--note", "go ahead with T1"], h.root);
    const implementReady = run(["run", "implement"], h.root);

    expect(written.code).toBe(EXIT_OK);
    expect(looksGood.code).toBe(EXIT_OK);
    expect(implementAsks.code).toBe(EXIT_NEEDS_HUMAN);
    expect(JSON.stringify(implementAsks.json()["outcome"])).toContain("execution.authorized");
    expect(go.code).toBe(EXIT_OK);
    expect((implementReady.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("ready");
  });

  it("asks about pre-existing changes and records the developer's answer", () => {
    const h = harness({
      state: { specificationAccepted: true, planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" },
      gitRepository: true,
    });
    writeFileSync(join(h.root, "notes.md"), "mine\n");

    const asks = run(["run", "implement"], h.root);
    const noNote = run(["changes", "claim", "--owner", "developer"], h.root);
    const badOwner = run(["changes", "claim", "--owner", "jflow", "--note", "x"], h.root);
    const claimed = run(["changes", "claim", "notes.md", "--owner", "developer", "--note", "leave my notes"], h.root);
    const ready = run(["run", "implement"], h.root);

    expect(asks.code).toBe(EXIT_NEEDS_HUMAN);
    expect(JSON.stringify(asks.json()["humanAsks"])).toContain("notes.md");
    expect(noNote.code).toBe(EXIT_NEEDS_HUMAN);
    expect(badOwner.code).toBe(EXIT_NEEDS_HUMAN);
    expect(claimed.code).toBe(EXIT_OK);
    expect(claimed.json()).toMatchObject({ ok: true, outcome: { unclaimedChanges: [] } });
    expect((ready.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("ready");
  });

  it("records acceptance and whole-plan authorization from one instruction", () => {
    const h = harness({ state: { specificationAccepted: true }, gitRepository: true });
    writeFileSync(
      join(h.root, "plan.json"),
      JSON.stringify({
        title: "p",
        summary: "s",
        tickets: [{ id: "T1", title: "t", acceptanceCriteria: ["c"], dependsOn: [] }],
      }),
    );
    run(["plan", "write", "plan.json"], h.root);

    const both = run(["plan", "accept", "--note", "approved, implement the whole plan", "--authorize", "plan"], h.root);

    expect(both.code).toBe(EXIT_OK);
    const outcome = both.json()["outcome"] as Record<string, Record<string, unknown>>;
    expect(outcome["plan"]?.["status"]).toBe("accepted");
    expect(outcome["progress"]?.["authorizationScope"]).toBe("plan");
    expect(run(["plan", "accept", "--authorize", "sideways"], h.root).code).toBe(EXIT_NEEDS_HUMAN);
    expect(run(["plan", "authorize", "--scope", "plan"], h.root).code).toBe(EXIT_NEEDS_HUMAN);
  });
});
