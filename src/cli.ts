import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { dispatch, type DispatchOutcome, type HumanAskEvent } from "./actions/dispatch.js";
import {
  acceptPlan,
  authorizeExecution,
  writePlan,
  type Authorization,
  type PlanDraft,
  type PlanResult,
} from "./actions/plan.js";
import type { ResolutionContext } from "./actions/resolve.js";
import {
  acceptSpecification,
  decideSpecification,
  writeSpecification,
  type SpecificationDraft,
  type SpecificationResult,
} from "./actions/specification.js";
import { resolveConfiguration } from "./config/configuration.js";
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
}

export const USAGE = `jflow helper

Usage:
  jflow status      [--root <dir>] [--config <file>]
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
`;

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string>>;
}

const KNOWN_OPTIONS = ["root", "config", "basis", "note", "authorize", "scope", "ticket"];

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

function runRequest(request: string, options: ParsedArgs["options"], io: CliIo): number {
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
  io.stdout(`${JSON.stringify({ request, outcome, humanAsks }, null, 2)}\n`);
  return exitCodeFor(outcome);
}

function reportSpecification(result: SpecificationResult, io: CliIo): number {
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
      return reportSpecification(
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
      return reportSpecification(
        decideSpecification(root, target, status, { basis: args.options["basis"] ?? "" }),
        io,
      );
    }
    case "accept": {
      const note = args.options["note"];
      const now = new Date().toISOString();
      return reportSpecification(
        acceptSpecification(root, note === undefined ? { now } : { now, note }),
        io,
      );
    }
    default:
      io.stderr(`specification needs one of write, confirm, reject, accept\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

function reportPlan(result: PlanResult, io: CliIo): number {
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? EXIT_OK : EXIT_NEEDS_HUMAN;
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
      return reportPlan(writePlan(root, read.draft, { now: new Date().toISOString() }), io);
    }
    case "accept": {
      const parsed = parseAuthorization(args.options["authorize"], args.options["ticket"], note);
      if (!parsed.ok) {
        io.stderr(`${parsed.message}\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return reportPlan(
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
      return reportPlan(authorizeExecution(root, parsed.authorization), io);
    }
    default:
      io.stderr(`plan needs one of write, accept, authorize\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

export function runCli(argv: readonly string[], io: CliIo): number {
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
      return runRequest("status", args.options, io);

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
export function main(): void {
  try {
    process.exitCode = runCli(process.argv.slice(2), {
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
