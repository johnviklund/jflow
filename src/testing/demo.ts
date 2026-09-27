import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { CheckRunner } from "../actions/checks.js";
import { runCli } from "../cli.js";
import type { TransportRequest } from "../jev/client.js";
import { readRecord, type ProjectRecords, type RecordKind } from "../project/records.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { loadShippedWorkflowPackage, SHIPPED_PACKAGE_DIRECTORY } from "../workflow/package.js";

/**
 * The release-demonstration driver (issue #23, D51): a project directory,
 * the helper's command line exactly as the skill runs it, and a scripted
 * Jev. Each demonstration drives a narrative through `runCli` and asserts
 * what is observable: the records, the working tree and Git, the asks the
 * helper returned, and the authorization. Nothing here inspects agent
 * prompt wording, and no confidence is written as a number: an answer is
 * `confident` or `unsure` relative to its decision's declared threshold,
 * whatever that threshold is (D37).
 *
 * Test scaffolding only; not part of the library surface.
 */

export const DEMO_KEY = "jev-demo-key-0123456789";

export type Certainty = "confident" | "unsure";

interface Scripted {
  readonly choice: string;
  readonly reason: string;
  readonly certainty: Certainty;
}

export interface JevCall {
  readonly decision: string;
  readonly body: string;
}

/** A Jev answering each decision from its own queue, down on request, and keeping every call. */
export class ScriptedJev {
  readonly calls: JevCall[] = [];
  /** Calls that found no scripted answer; a demonstration asserts there were none unless it means them. */
  readonly unscripted: JevCall[] = [];
  private readonly queues = new Map<string, Scripted[]>();
  private readonly standing = new Map<string, Scripted>();
  private outage: number | undefined;

  /** Queues one answer for `decision`. */
  answer(decision: string, choice: string, reason: string, certainty: Certainty = "confident"): this {
    this.queues.set(decision, [...(this.queues.get(decision) ?? []), { choice, reason, certainty }]);
    return this;
  }

  /** Answers `decision` this way whenever its queue is empty. */
  always(decision: string, choice: string, reason: string, certainty: Certainty = "confident"): this {
    this.standing.set(decision, { choice, reason, certainty });
    return this;
  }

  /** Every call fails with this HTTP status until `restore`. */
  down(status = 503): this {
    this.outage = status;
    return this;
  }

  restore(): this {
    this.outage = undefined;
    return this;
  }

  callsTo(decision: string): readonly JevCall[] {
    return this.calls.filter((call) => call.decision === decision);
  }

  readonly transport = async (request: TransportRequest): Promise<{ status: number; body: string }> => {
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    const call = { decision, body: request.body };
    this.calls.push(call);
    if (this.outage !== undefined) return { status: this.outage, body: "unavailable" };
    const scripted = this.queues.get(decision)?.shift() ?? this.standing.get(decision);
    if (scripted === undefined) {
      this.unscripted.push(call);
      return { status: 500, body: "no scripted answer" };
    }
    const threshold = confidenceThreshold(loadShippedWorkflowPackage(), decision);
    const confidence = scripted.certainty === "confident" ? threshold + (1 - threshold) / 2 : threshold / 2;
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-demo",
        answers: {
          [decision]: { type: "choice", choice: scripted.choice, confidence },
          [`${decision}.reason`]: { type: "choice", choice: scripted.reason, confidence },
        },
      }),
    };
  };
}

// The helper's JSON output is read loosely here, as the skill reads it.
export type Json = any;

export interface DemoRun {
  readonly code: number;
  readonly json: Json;
  readonly stderr: string;
}

export interface Demo {
  readonly root: string;
  readonly jev: ScriptedJev;
  /** Where accepted proposals write: a copy of the shipped package, never the package itself. */
  readonly packageDirectory: string;
  /** Every ask the helper returned, in order, with the command that returned it. */
  readonly asks: { readonly command: string; readonly ask: Json }[];
  /** Runs one helper command in the project; drafts are paths from `draft`. */
  run(...argv: string[]): Promise<DemoRun>;
  /** Writes a draft JSON file outside the project, as the skill does, and returns its path. */
  draft(name: string, value: unknown): string;
  /** Writes a project file, as the agent's edits would. */
  edit(path: string, content: string): void;
  git(...args: string[]): string;
  record<K extends RecordKind>(kind: K): ProjectRecords[K];
  /** A record, or undefined while it has not been written. */
  maybe<K extends RecordKind>(kind: K): ProjectRecords[K] | undefined;
  /** Every file under the project but `.git`, keyed by path. */
  snapshot(): Record<string, string>;
  /** The files of the package copy acceptance writes. */
  packageFiles(): Record<string, string>;
  cleanup(): void;
}

function listFiles(root: string, directory = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory() && entry.name === ".git" && directory === root) continue;
    if (entry.isDirectory()) Object.assign(files, listFiles(root, full));
    else files[relative(root, full)] = readFileSync(full, "utf8");
  }
  return files;
}

const asksIn = (json: Json): Json[] => {
  if (json === null || typeof json !== "object") return [];
  const found: Json[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (key === "askHuman" || key === "humanAsks") found.push(...(Array.isArray(value) ? value : [value]));
    else if (typeof value === "object") found.push(...asksIn(value));
  }
  return found;
};

/**
 * A fresh project directory: a Git repository with one initial commit, and
 * nothing of jflow's yet. `root` reopens an existing project in a new
 * session, with a new Jev and no memory of the last one.
 */
/** The configuration a demo runs with unless it passes its own: a model for every stage that runs sub-agents. */
const DEMO_CONFIG = { stageModels: { implement: { model: "demo-implementer" }, review: { model: "demo-reviewer" } } };

export function demoProject(options: { readonly root?: string; readonly config?: unknown } = {}): Demo {
  const fresh = options.root === undefined;
  const root = options.root ?? mkdtempSync(join(tmpdir(), "jflow-demo-"));
  const drafts = mkdtempSync(join(tmpdir(), "jflow-demo-drafts-"));
  const packageDirectory = mkdtempSync(join(tmpdir(), "jflow-demo-package-"));
  cpSync(SHIPPED_PACKAGE_DIRECTORY, packageDirectory, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (fresh) {
    git("init", "--quiet");
    for (const [key, value] of [["user.name", "jflow demo"], ["user.email", "demo@example.com"], ["commit.gpgsign", "false"]] as const) {
      git("config", key, value);
    }
    writeFileSync(join(root, "README.md"), "# demo project\n");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "initial");
  }
  // A developer who has chosen their models; a demo about configuration passes its own.
  const config = join(drafts, "config.json");
  writeFileSync(config, JSON.stringify(options.config ?? DEMO_CONFIG));
  const jev = new ScriptedJev();
  const asks: Demo["asks"] = [];

  return {
    root,
    jev,
    packageDirectory,
    asks,
    async run(...argv) {
      let stdout = "";
      let stderr = "";
      const takesConfig = !["specification", "changes", "conflict", "traces", "check-host"].includes(argv[0]!) && !argv.includes("--config");
      const code = await runCli(takesConfig ? [...argv, "--config", config] : argv, {
        cwd: root,
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
        hostProbes: { env: {}, exec: () => "git version demo" },
        jev: { env: { JFLOW_JEV_API_KEY: DEMO_KEY }, transport: jev.transport, sleep: async () => undefined },
        checkRunner: demoCheckRunner,
        packageDirectory,
      });
      const json: Json = stdout.trim() === "" ? undefined : JSON.parse(stdout);
      for (const ask of asksIn(json)) asks.push({ command: argv.slice(0, 2).join(" "), ask });
      return { code, json, stderr };
    },
    draft(name, value) {
      const path = join(drafts, name);
      writeFileSync(path, JSON.stringify(value, null, 2));
      return path;
    },
    edit(path, content) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    git,
    record(kind) {
      const read = readRecord(root, kind);
      if (read.kind !== "present") throw new Error(`the ${kind} record is ${read.kind}`);
      return read.record;
    },
    maybe(kind) {
      const read = readRecord(root, kind);
      return read.kind === "present" ? read.record : undefined;
    },
    snapshot: () => listFiles(root),
    packageFiles: () => listFiles(packageDirectory),
    cleanup() {
      if (fresh) rmSync(root, { recursive: true, force: true });
      rmSync(drafts, { recursive: true, force: true });
      rmSync(packageDirectory, { recursive: true, force: true });
    },
  };
}

/** The drafts a demonstration project starts from: a specification with one decision, and a plan. */
export const SPECIFICATION_DRAFT = {
  title: "CSV importer",
  problem: "Customer exports arrive as CSV files and cannot be imported.",
  scenarios: ["import a CSV file", "report rows that could not be imported"],
  acceptanceCriteria: ["a valid CSV file imports every row", "invalid rows are reported with their line numbers"],
  constraints: ["UTF-8 input only"],
  exclusions: ["Excel files"],
  decisions: [{ id: "D1", statement: "Invalid rows are skipped and reported, not fatal.", basis: "the developer's brief" }],
};

export function ticketDraft(id: string, dependsOn: readonly string[] = []) {
  return { id, title: `Ticket ${id}`, acceptanceCriteria: [`npm test -- ${id.toLowerCase()} passes`], dependsOn };
}

/** A ticket's one check command; the demo runner fails it when it carries `# failing`. */
function checkCommand(ticketId: string, passing: boolean): string {
  return `npm test -- ${ticketId.toLowerCase()}${passing ? "" : " # failing"}`;
}

/**
 * The demos' check runner (issue #32): a ticket's `npm test` passes unless
 * marked `# failing`, `git diff` prints a diff, and anything else is unknown.
 */
export const demoCheckRunner: CheckRunner = (command) => {
  if (command.startsWith("git diff")) {
    return { output: "diff --git a/src/t1.ts b/src/t1.ts\n@@ -0,0 +1 @@\n", exitCode: 0, timedOut: false };
  }
  if (command.startsWith("npm test")) {
    const failing = command.endsWith("# failing");
    return { output: failing ? "1 failed, 2 passed\n" : "3 passed\n", exitCode: failing ? 1 : 0, timedOut: false };
  }
  return { output: `sh: ${command}: not found\n`, exitCode: 127, timedOut: false };
};

/** An evidence file for a ticket: its one check for jflow to run, passing or failing. */
export function evidence(ticketId: string, passing = true) {
  return { ticketId, evidence: [], checks: [checkCommand(ticketId, passing)] };
}

/**
 * Takes a project from idea to an accepted plan: specification written,
 * its decision confirmed and accepted in the developer's words, the plan
 * written (classify finds every criterion testable) and accepted.
 */
export async function acceptedPlan(demo: Demo, tickets: readonly ReturnType<typeof ticketDraft>[]): Promise<void> {
  demo.jev.always("classify", "testable", "clear-match");
  const steps: DemoRun[] = [
    await demo.run("specification", "write", demo.draft("spec.json", SPECIFICATION_DRAFT)),
    await demo.run("specification", "confirm", "D1", "--basis", "yes, skip and report"),
    await demo.run("specification", "accept", "--note", "accepted"),
    await demo.run("plan", "write", demo.draft("plan.json", { title: "Importer plan", summary: "Import CSV files.", tickets })),
    await demo.run("plan", "accept", "--note", "looks good"),
  ];
  const failed = steps.find((step) => step.code !== 0);
  if (failed !== undefined) throw new Error(`setting up the plan failed: ${JSON.stringify(failed.json)}`);
}

/** Authorizes one ticket in the developer's words and starts it. */
export async function startAuthorizedTicket(demo: Demo, ticketId: string): Promise<void> {
  const authorized = await demo.run("plan", "authorize", "--scope", "ticket", "--ticket", ticketId, "--note", `do ${ticketId}`);
  const started = await demo.run("implement", "start");
  if (authorized.code !== 0 || started.code !== 0) throw new Error(`starting ${ticketId} failed: ${JSON.stringify(started.json)}`);
}

/**
 * Carries the ticket in progress through its gates: the agent's edit, a
 * passing check through validate, an independent review with no findings,
 * and completion with its local commit.
 */
export async function completeTicket(demo: Demo, ticketId: string, reviewer = "reviewer-1"): Promise<void> {
  demo.edit(`src/${ticketId.toLowerCase()}.ts`, `export const ${ticketId.toLowerCase()} = true;\n`);
  demo.jev.answer("validate", "met", "evidence-satisfies");
  const steps: DemoRun[] = [
    await demo.run("implement", "check", demo.draft(`${ticketId}-evidence.json`, evidence(ticketId))),
    await demo.run("review", "start"),
    await demo.run("review", "record", demo.draft(`${ticketId}-review.json`, { ticketId, reviewer: { agent: reviewer }, findings: [] })),
    await demo.run("implement", "complete"),
  ];
  const failed = steps.find((step) => step.code !== 0);
  if (failed !== undefined) throw new Error(`completing ${ticketId} failed: ${JSON.stringify(failed.json)}`);
}
