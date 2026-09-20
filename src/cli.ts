import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { dispatch, type DispatchOutcome, type HumanAskEvent } from "./actions/dispatch.js";
import type { ResolutionContext } from "./actions/resolve.js";
import { resolveConfiguration } from "./config/configuration.js";
import { checkHostCapabilities, processProbeOptions, type HostProbeOptions } from "./host/capabilities.js";
import { loadShippedWorkflowPackage } from "./workflow/package.js";
import { WorkflowPackageError, type WorkflowPackage } from "./workflow/types.js";

/**
 * The jflow helper's command line (D51, issue #4). The skill's instruction
 * files shell out to it; every command prints one JSON object on stdout so
 * the primary agent reads results, never parses prose. Exit codes: 0 the
 * command ran (including an eligible action with no executor yet), 1 the
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
  jflow help

Every command prints one JSON object. <request> is an action name or a
sentence; an ambiguous request returns a question rather than a guess.
`;

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string>>;
}

const KNOWN_OPTIONS = ["root", "config"];

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
    case "not-implemented":
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
