import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { claimChanges } from "./actions/changes.js";
import { decideConflict, raiseConflict, type ConflictDraft } from "./actions/conflicts.js";
import { dispatch, type DispatchOutcome, type HumanAskEvent } from "./actions/dispatch.js";
import { unreadable } from "./actions/refusal.js";
import { promoteTodo, recordTodo } from "./actions/todo.js";
import { fetchTransport, type JevTransport } from "./jev/client.js";
import {
  adviseNext,
  askDecision,
  CHOICE_MAKERS,
  permittedChoices,
  readEnvelope,
  recordChoice,
  reportDecision,
  type ChoiceMaker,
  type DecisionDependencies,
  type DecisionInput,
} from "./jev/decisions.js";
import { askEscalation, type Boundary } from "./jev/escalation.js";
import { cleanTraces, listTraces } from "./jev/traces.js";
import {
  acceptPlan,
  authorizeExecution,
  writePlan,
  type Authorization,
  type PlanDraft,
} from "./actions/plan.js";
import type { ResolutionContext } from "./actions/resolve.js";
import {
  acceptSpecification,
  decideSpecification,
  writeSpecification,
  type SpecificationDraft,
} from "./actions/specification.js";
import { resolveConfiguration, resolveJevApiKey } from "./config/configuration.js";
import { readRecord } from "./project/records.js";
import { checkHostCapabilities, processProbeOptions, type HostProbeOptions } from "./host/capabilities.js";
import { loadShippedWorkflowPackage } from "./workflow/package.js";
import { WorkflowPackageError, type WorkflowPackage } from "./workflow/types.js";

/**
 * The jflow helper's command line (D51, issue #4). The skill's instruction
 * files shell out to it; every command prints one JSON object on stdout so
 * the primary agent reads results, never parses prose. Exit codes: 0 the
 * command ran (including an eligible action the skill's method carries), 1 the
 * request needs the developer (blocked, ambiguous, unknown, invalid
 * configuration), 2 the project or package cannot be read.
 */

export const EXIT_OK = 0;
export const EXIT_NEEDS_HUMAN = 1;
export const EXIT_UNREADABLE = 2;

export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Host probes; defaults to the real process. Injected by tests. */
  readonly hostProbes?: HostProbeOptions;
  /** Where the Jev key is read from and how requests are sent; defaults to the process and the network. */
  readonly jev?: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly transport: JevTransport;
  };
}

export const USAGE = `jflow helper

Usage:
  jflow status      [--root <dir>] [--config <file>]
  jflow next        [--root <dir>] [--config <file>]
  jflow run <request…> [--root <dir>] [--config <file>]
  jflow validate    [--config <file>]
  jflow check-host  [--root <dir>]
  jflow specification write <draft.json>            [--root <dir>]
  jflow specification confirm <decision> --basis <what the developer said> [--root <dir>]
  jflow specification reject  <decision> --basis <what the developer said> [--root <dir>]
  jflow specification accept  [--note <the developer's words>] [--root <dir>]
  jflow plan write <draft.json>                                   [--root <dir>]
  jflow plan accept [--note <words>] [--authorize plan|ticket --ticket <id>] [--root <dir>]
  jflow plan authorize --scope plan|ticket [--ticket <id>] --note <words> [--root <dir>]
  jflow changes claim [<path>…] --owner developer|ticket --note <words> [--root <dir>]
  jflow todo add <summary…> [--detail <context>] [--root <dir>]
  jflow todo list                                [--root <dir>]
  jflow todo promote <id> --note <the developer's words> [--root <dir>]
  jflow decide ask <decision> <input.json>   [--root <dir>] [--config <file>]
  jflow decide show <envelope>               [--root <dir>]
  jflow decide choose <envelope> --action <a> --by workflow|agent|developer
                    [--reason <why>] [--evidence <what it rests on>] [--root <dir>]
  jflow escalate <boundary.json>             [--root <dir>] [--config <file>]
  jflow conflict raise <draft.json>          [--root <dir>]
  jflow conflict decide <id> --note <the developer's words> [--root <dir>]
  jflow traces list  [--root <dir>]
  jflow traces clean [--root <dir>]
  jflow help

Every command prints one JSON object. <request> is an action name or a
sentence; an ambiguous request returns a question rather than a guess.
A specification draft holds title, problem, scenarios, acceptanceCriteria,
constraints, exclusions and decisions (id, statement, basis); every
decision is recorded as a proposal until the developer confirms it.
A plan draft holds title, summary, source and tickets (id, title,
acceptanceCriteria, dependsOn); a ticket without criteria is refused.
"plan accept" alone accepts without authorizing; add --authorize when the
developer's instruction also authorized execution.
"changes claim" records who owns uncommitted changes jflow found and asked
about: the developer (left out of the ticket) or the assigned ticket. With
no paths it covers every unclaimed change. It never stages or discards.
"todo add" records future work outside the plan and authorizes nothing;
"todo promote" records the developer's decision to bring an item into the
plan, and says whether plan or realign adds its ticket.
"next" also asks Jev's advisory next-action decision and reports it under
"jev" with its envelope; a missing key is reported there, never skipped.
"decide ask" asks a declared Jev decision over an input holding taskSummary,
candidates and excerpts (source, text); the answer's route says whether the
workflow acts on it, you weigh it, or the developer decides. "decide
choose" records the chosen action: it must be permitted by the workflow,
and setting Jev's answer aside needs --reason and --evidence.
"escalate" asks the binding escalate decision at a human-facing boundary
over kind, summary and excerpts. It exits 0 with "ask": false when the
work proceeds, and 1 with "askHuman" when the developer must be asked. The
hard rules (consequential-conflict, continue-without-jev,
specification-acceptance, plan-acceptance) always ask and never reach Jev.
"conflict raise" takes summary, touches (requirements, scope,
workflow-rules, permissions) and, for a technical disagreement,
investigation (finding, evidence, conclusive); a consequential or
inconclusive one waits for the developer and never reaches Jev.
"traces clean" deletes the local Jev traces under .jflow/traces; run it only
when the developer asks. Project records keep their summaries.
`;

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string>>;
}

const KNOWN_OPTIONS = [
  "root",
  "config",
  "basis",
  "note",
  "authorize",
  "scope",
  "ticket",
  "owner",
  "detail",
  "action",
  "by",
  "reason",
  "evidence",
];

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!KNOWN_OPTIONS.includes(name)) {
        throw new Error(`unknown option ${arg}; options are ${KNOWN_OPTIONS.map((o) => `--${o}`).join(", ")}`);
      }
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`option ${arg} needs a value`);
      }
      options[name] = value;
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, options };
}

type ContextResult =
  | { readonly ok: true; readonly context: ResolutionContext }
  | { readonly ok: false; readonly exit: number; readonly output: unknown };

type DraftRead<T> =
  | { readonly ok: true; readonly draft: T }
  | { readonly ok: false; readonly exit: number };

/** Reads a draft JSON file the skill wrote; the record validators judge its shape. */
function readDraft<T>(target: string | undefined, what: string, io: CliIo): DraftRead<T> {
  if (target === undefined) {
    io.stderr(`${what} needs the path of a draft JSON file\n${USAGE}`);
    return { ok: false, exit: EXIT_NEEDS_HUMAN };
  }
  try {
    return { ok: true, draft: JSON.parse(readFileSync(resolvePath(io.cwd, target), "utf8")) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stdout(`${JSON.stringify({ ok: false, reason: `cannot read the draft: ${message}` }, null, 2)}\n`);
    return { ok: false, exit: EXIT_UNREADABLE };
  }
}

function readConfigurationDocument(path: string | undefined, cwd: string): unknown {
  if (path === undefined) return {};
  return JSON.parse(readFileSync(resolvePath(cwd, path), "utf8"));
}

function buildContext(options: ParsedArgs["options"], io: CliIo): ContextResult {
  let workflowPackage: WorkflowPackage;
  try {
    workflowPackage = loadShippedWorkflowPackage();
  } catch (error) {
    if (error instanceof WorkflowPackageError) {
      return { ok: false, exit: EXIT_UNREADABLE, output: { ok: false, package: error.issues } };
    }
    throw error;
  }

  let document: unknown;
  try {
    document = readConfigurationDocument(options["config"], io.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exit: EXIT_UNREADABLE,
      output: { ok: false, configuration: [{ path: "", message: `cannot read configuration: ${message}` }] },
    };
  }

  const configuration = resolveConfiguration(document, workflowPackage);
  if (!configuration.ok) {
    return { ok: false, exit: EXIT_NEEDS_HUMAN, output: { ok: false, configuration: configuration.issues } };
  }
  return { ok: true, context: { workflowPackage, configuration: configuration.configuration } };
}

function exitCodeFor(outcome: DispatchOutcome): number {
  switch (outcome.kind) {
    case "completed":
    case "ready":
      return EXIT_OK;
    case "blocked":
    case "clarify":
    case "unknown-action":
      return EXIT_NEEDS_HUMAN;
    case "malformed-record":
      return EXIT_UNREADABLE;
  }
}

function decisionDependencies(context: ResolutionContext, io: CliIo): DecisionDependencies {
  const jev = io.jev ?? { env: process.env, transport: fetchTransport };
  return {
    context,
    apiKey: resolveJevApiKey({ env: jev.env }),
    transport: jev.transport,
    now: () => new Date().toISOString(),
  };
}

async function runRequest(request: string, options: ParsedArgs["options"], io: CliIo): Promise<number> {
  const built = buildContext(options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const root = resolvePath(io.cwd, options["root"] ?? ".");
  const humanAsks: HumanAskEvent[] = [];
  const outcome = dispatch(root, request, built.context, {
    onHumanAsk: (event) => humanAsks.push(event),
  });
  // `next` also carries Jev's advisory next-action answer (issue #17);
  // the records' own recommendation above is unchanged by it.
  const jev =
    outcome.kind === "completed" && outcome.action === "next"
      ? (await adviseNext(root, decisionDependencies(built.context, io))).jev
      : undefined;
  io.stdout(`${JSON.stringify(jev === undefined ? { request, outcome, humanAsks } : { request, outcome, humanAsks, jev }, null, 2)}\n`);
  return exitCodeFor(outcome);
}

/** Prints a helper result; a refusal needs the developer. */
function report<T extends { readonly ok: boolean }>(result: T, io: CliIo): number {
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

function runSpecification(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;

  switch (subcommand) {
    case "write": {
      const read = readDraft<SpecificationDraft>(target, "specification write", io);
      if (!read.ok) return read.exit;
      return report(
        writeSpecification(root, read.draft, { now: new Date().toISOString() }),
        io,
      );
    }
    case "confirm":
    case "reject": {
      if (target === undefined) {
        io.stderr(`specification ${subcommand} needs a decision id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const status = subcommand === "confirm" ? "confirmed" : "rejected";
      return report(
        decideSpecification(root, target, status, { basis: args.options["basis"] ?? "" }),
        io,
      );
    }
    case "accept": {
      const note = args.options["note"];
      const now = new Date().toISOString();
      return report(
        acceptSpecification(root, note === undefined ? { now } : { now, note }),
        io,
      );
    }
    default:
      io.stderr(`specification needs one of write, confirm, reject, accept\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

type AuthorizationParse =
  | { readonly ok: true; readonly authorization: Authorization | undefined }
  | { readonly ok: false; readonly message: string };

/** An authorization needs a scope and the developer's words; a ticket id is optional here. */
function parseAuthorization(
  scope: string | undefined,
  ticket: string | undefined,
  note: string | undefined,
): AuthorizationParse {
  if (scope === undefined) return { ok: true, authorization: undefined };
  if (scope !== "plan" && scope !== "ticket") {
    return { ok: false, message: `authorization scope must be plan or ticket, not "${scope}"` };
  }
  if (note === undefined || note.trim() === "") {
    return { ok: false, message: "authorization is recorded in the developer's words; pass --note" };
  }
  return {
    ok: true,
    authorization: { scope, note, ...(ticket === undefined ? {} : { ticketId: ticket }) },
  };
}

function runPlan(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const note = args.options["note"];

  switch (subcommand) {
    case "write": {
      const read = readDraft<PlanDraft>(target, "plan write", io);
      if (!read.ok) return read.exit;
      return report(writePlan(root, read.draft, { now: new Date().toISOString() }), io);
    }
    case "accept": {
      const parsed = parseAuthorization(args.options["authorize"], args.options["ticket"], note);
      if (!parsed.ok) {
        io.stderr(`${parsed.message}\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(
        acceptPlan(root, {
          now: new Date().toISOString(),
          ...(note === undefined ? {} : { note }),
          ...(parsed.authorization === undefined ? {} : { authorize: parsed.authorization }),
        }),
        io,
      );
    }
    case "authorize": {
      const parsed = parseAuthorization(args.options["scope"], args.options["ticket"], note);
      if (!parsed.ok || parsed.authorization === undefined) {
        io.stderr(`${parsed.ok ? "plan authorize needs --scope plan|ticket" : parsed.message}\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(authorizeExecution(root, parsed.authorization), io);
    }
    default:
      io.stderr(`plan needs one of write, accept, authorize\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

function runChanges(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, ...paths] = args.positional;
  if (subcommand !== "claim") {
    io.stderr(`changes needs claim\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const owner = args.options["owner"];
  if (owner !== "developer" && owner !== "ticket") {
    io.stderr(`changes claim needs --owner developer|ticket\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const result = claimChanges(root, {
    owner,
    note: args.options["note"] ?? "",
    ...(paths.length === 0 ? {} : { paths }),
  });
  return report(result, io);
}

function runTodo(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, ...rest] = args.positional;

  switch (subcommand) {
    case "add": {
      const summary = rest.join(" ").trim();
      if (summary === "") {
        io.stderr(`todo add needs a summary of the item\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const detail = args.options["detail"];
      return report(
        recordTodo(root, detail === undefined ? { summary } : { summary, detail }, {
          now: new Date().toISOString(),
        }),
        io,
      );
    }
    case "list": {
      const read = readRecord(root, "todos");
      if (read.kind === "malformed") {
        io.stdout(`${JSON.stringify(unreadable("todos", read), null, 2)}\n`);
        return EXIT_UNREADABLE;
      }
      const todos = read.kind === "present" ? read.record : { items: [] };
      return report({ ok: true, todos }, io);
    }
    case "promote": {
      const [id] = rest;
      if (id === undefined) {
        io.stderr(`todo promote needs a todo id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(promoteTodo(root, id, { note: args.options["note"] ?? "", now: new Date().toISOString() }), io);
    }
    default:
      io.stderr(`todo needs one of add, list, promote\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

async function runDecide(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target, inputPath] = args.positional;

  switch (subcommand) {
    case "ask": {
      if (target === undefined) {
        io.stderr(`decide ask needs a decision name\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const read = readDraft<DecisionInput>(inputPath, "decide ask", io);
      if (!read.ok) return read.exit;
      const result = await askDecision(root, target, read.draft, decisionDependencies(built.context, io));
      const decision = reportDecision(result);
      io.stdout(`${JSON.stringify({ ok: result.kind === "answered", decision }, null, 2)}\n`);
      return result.kind === "answered" ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    case "show": {
      if (target === undefined) {
        io.stderr(`decide show needs an envelope id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(readEnvelope(root, target), io);
    }
    case "choose": {
      const action = args.options["action"];
      const by = args.options["by"] as ChoiceMaker | undefined;
      if (target === undefined || action === undefined || by === undefined || !CHOICE_MAKERS.includes(by as ChoiceMaker)) {
        io.stderr(`decide choose needs an envelope id, --action and --by workflow|agent|developer\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const envelope = readEnvelope(root, target);
      if (!envelope.ok) return report(envelope, io);
      const reason = args.options["reason"];
      const evidence = args.options["evidence"];
      return report(
        recordChoice(
          root,
          target,
          {
            action,
            by,
            ...(reason === undefined ? {} : { reason }),
            ...(evidence === undefined ? {} : { evidence: [evidence] }),
          },
          permittedChoices(root, envelope.envelope.decision, built.context),
          { now: new Date().toISOString() },
        ),
        io,
      );
    }
    default:
      io.stderr(`decide needs one of ask, show, choose\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

async function runEscalate(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const read = readDraft<Boundary>(args.positional[0], "escalate", io);
  if (!read.ok) return read.exit;
  const result = await askEscalation(root, read.draft, decisionDependencies(built.context, io));
  io.stdout(`${JSON.stringify({ ok: result.kind !== "refused", ...result }, null, 2)}\n`);
  return result.kind !== "refused" && !result.ask ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

function runConflict(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const now = new Date().toISOString();

  switch (subcommand) {
    case "raise": {
      const read = readDraft<ConflictDraft>(target, "conflict raise", io);
      if (!read.ok) return read.exit;
      const draft = read.draft;
      const result = raiseConflict(root, { ...draft, touches: draft.touches ?? [] }, { now });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.outcome.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    case "decide": {
      if (target === undefined) {
        io.stderr(`conflict decide needs a conflict id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(decideConflict(root, target, { note: args.options["note"] ?? "", now }), io);
    }
    default:
      io.stderr(`conflict needs one of raise, decide\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

function runTraces(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  switch (args.positional[0]) {
    case "list":
      return report({ ok: true, traces: listTraces(root) }, io);
    case "clean":
      return report({ ok: true, ...cleanTraces(root) }, io);
    default:
      io.stderr(`traces needs one of list, clean\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }

  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      io.stdout(USAGE);
      return EXIT_OK;

    case "status":
    case "next":
      return runRequest(args.command, args.options, io);

    case "run": {
      const request = args.positional.join(" ").trim();
      if (request === "") {
        io.stderr(`run needs a request: an action name or a sentence\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return runRequest(request, args.options, io);
    }

    case "validate": {
      const built = buildContext(args.options, io);
      const output = built.ok
        ? {
            ok: true,
            package: { id: built.context.workflowPackage.id, schemaVersion: built.context.workflowPackage.schemaVersion },
            configuration: built.context.configuration,
          }
        : built.output;
      io.stdout(`${JSON.stringify(output, null, 2)}\n`);
      return built.ok ? EXIT_OK : built.exit;
    }

    case "specification":
      return runSpecification(args, io);

    case "plan":
      return runPlan(args, io);

    case "changes":
      return runChanges(args, io);

    case "todo":
      return runTodo(args, io);

    case "decide":
      return runDecide(args, io);

    case "escalate":
      return runEscalate(args, io);

    case "conflict":
      return runConflict(args, io);

    case "traces":
      return runTraces(args, io);

    case "check-host": {
      const root = resolvePath(io.cwd, args.options["root"] ?? ".");
      const report = checkHostCapabilities(root, io.hostProbes ?? processProbeOptions());
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return EXIT_OK;
    }

    default:
      io.stderr(`unknown command "${args.command}"\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

/**
 * Entry point for the built helper (`dist/cli.js`); tests call `runCli`
 * directly. Anything the commands did not handle (an I/O failure reading the
 * project, say) is reported as unreadable rather than as a stack trace.
 */
export async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      cwd: process.cwd(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    process.exitCode = EXIT_UNREADABLE;
  }
}
