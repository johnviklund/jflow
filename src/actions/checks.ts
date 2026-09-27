import { spawnSync } from "node:child_process";

import { redact } from "../jev/evidence.js";
import type { ValidationInput, VerificationEvidence } from "../jev/ticket-validation.js";
import { JEV_API_KEY_ENV_VAR } from "../secrets.js";

/**
 * The helper runs a ticket's checks itself (issue #32): the agent names the
 * commands, and their output and exit codes are recorded as they ran. Check
 * evidence therefore cannot be summarized, shortened or made up by whichever
 * agent did the work. The agent's own account stays a `claim`.
 */

export interface CheckRun {
  /** Standard output and standard error, interleaved as the command wrote them. */
  readonly output: string;
  /** Null when the command did not exit on its own (it ran out of time). */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** Runs one check command in the project; the command line uses `processCheckRunner`, tests a script. */
export type CheckRunner = (command: string, options: { readonly cwd: string; readonly timeoutMs: number }) => CheckRun;

export interface CheckOptions {
  readonly runner: CheckRunner;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** The most output kept for all checks together; longer output is cut in the middle. */
  readonly maxChars: number;
  /** Secret values to blank out besides the credential patterns, such as the Jev key. */
  readonly knownSecrets: readonly string[];
}

export type CheckRunResult = { readonly ok: true; readonly input: ValidationInput } | { readonly ok: false; readonly reason: string };

/** The exit code recorded for a check stopped at its time limit, as `timeout(1)` reports it. */
const TIMEOUT_EXIT = 124;

/** Keeps the start and end of long output, where test names and totals are. */
function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = (removed: number) => `\n[… ${removed} characters cut from the middle by jflow …]\n`;
  const room = max - note(text.length).length;
  const head = Math.ceil(room / 2);
  const tail = Math.floor(room / 2);
  return `${text.slice(0, head)}${note(text.length - head - tail)}${text.slice(text.length - tail)}`;
}

/**
 * Runs every check the draft names and returns the draft with their output
 * as check evidence, followed by the agent's claims. Check output the agent
 * wrote itself is refused, and nothing runs.
 */
export function runTicketChecks(draft: ValidationInput, options: CheckOptions): CheckRunResult {
  const supplied: readonly VerificationEvidence[] = Array.isArray(draft?.evidence) ? draft.evidence : [];
  if (supplied.some((entry) => entry?.kind === "check")) {
    return {
      ok: false,
      reason:
        "the evidence file holds check output; jflow runs the checks itself, so list the commands in checks and put your own account in a claim",
    };
  }
  const commands = Array.isArray(draft?.checks)
    ? draft.checks.filter((check): check is string => typeof check === "string" && check.trim() !== "").map((check) => check.trim())
    : [];
  if (commands.length === 0) {
    return { ok: false, reason: "the evidence file names no checks; list the commands whose results the ticket's criteria depend on" };
  }

  const perCheck = Math.max(200, Math.floor((options.maxChars * 0.8) / commands.length));
  const ran: VerificationEvidence[] = commands.map((command) => {
    const run = options.runner(command, { cwd: options.cwd, timeoutMs: options.timeoutMs });
    const stopped = run.timedOut ? `\n[jflow: stopped after ${options.timeoutMs} ms; the check did not finish]` : "";
    const text = cutMiddle(redact(`${run.output}${stopped}`, options.knownSecrets), perCheck);
    return { kind: "check", source: command, text, exitCode: run.timedOut || run.exitCode === null ? TIMEOUT_EXIT : run.exitCode };
  });
  return { ok: true, input: { ...draft, evidence: [...ran, ...supplied], checks: commands } };
}

/**
 * The real runner: `sh -c` in the project, stderr merged into stdout, the
 * Jev key removed from the environment, and the command killed at its limit.
 */
export function processCheckRunner(env: Readonly<Record<string, string | undefined>>): CheckRunner {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[0] !== JEV_API_KEY_ENV_VAR && entry[1] !== undefined),
  );
  return (command, { cwd, timeoutMs }) => {
    const result = spawnSync("sh", ["-c", `exec 2>&1\n${command}`], {
      cwd,
      env: childEnv,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (result.error !== undefined && !timedOut) {
      return { output: `jflow could not run the check: ${result.error.message}`, exitCode: 127, timedOut: false };
    }
    return { output: result.stdout ?? "", exitCode: timedOut ? null : result.status, timedOut };
  };
}
