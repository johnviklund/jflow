import { spawnSync } from "node:child_process";
import { constants } from "node:os";

import { cutMiddle, redact } from "../jev/evidence.js";
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
  const ran = commands.map((command) => runCheck(command, { ...options, maxChars: perCheck }));
  return { ok: true, input: { ...draft, evidence: [...ran, ...supplied], checks: commands } };
}

/** Runs one check and records it as check evidence: output redacted and cut to `maxChars`, a timeout as failed. */
export function runCheck(command: string, options: CheckOptions): VerificationEvidence & { readonly exitCode: number } {
  const run = options.runner(command, { cwd: options.cwd, timeoutMs: options.timeoutMs });
  const stopped = run.timedOut ? `\n[jflow: stopped after ${options.timeoutMs} ms; the check did not finish]` : "";
  const text = cutMiddle(redact(`${run.output}${stopped}`, options.knownSecrets), options.maxChars);
  return { kind: "check", source: command, text, exitCode: run.timedOut || run.exitCode === null ? TIMEOUT_EXIT : run.exitCode };
}

/**
 * Runs `command` as a job in its own process group and, on the timeout's
 * SIGTERM, kills that whole group, so nothing the check started (a test
 * runner's workers, a server) outlives it. Stderr is merged into stdout.
 */
function shellScript(command: string): string {
  return ["exec 2>&1", "set -m", `( ${command}`, ") &", "job=$!", `trap 'kill -KILL -$job 2>/dev/null; exit ${TIMEOUT_EXIT}' TERM`, "wait $job"].join("\n");
}

/**
 * The real runner: `sh` in the project, the Jev key removed from the
 * environment, and the check with everything it started stopped at its limit.
 */
export function processCheckRunner(env: Readonly<Record<string, string | undefined>>): CheckRunner {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[0] !== JEV_API_KEY_ENV_VAR && entry[1] !== undefined),
  );
  return (command, { cwd, timeoutMs }) => {
    const result = spawnSync("sh", ["-c", shellScript(command)], {
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
    const output = result.stdout ?? "";
    if (timedOut) return { output, exitCode: null, timedOut: true };
    if (result.status === null && result.signal !== null) {
      // Killed by a signal, not by jflow's limit: the shell's convention, 128 plus the signal number.
      const number = constants.signals[result.signal as keyof typeof constants.signals] ?? 0;
      return { output: `${output}[jflow: the check was killed by ${result.signal}]\n`, exitCode: 128 + number, timedOut: false };
    }
    return { output, exitCode: result.status, timedOut: false };
  };
}
