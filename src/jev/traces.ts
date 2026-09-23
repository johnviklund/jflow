import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local Jev traces (issue #16, D23): the exact request and response of each
 * call, kept under `.jflow/traces/` in the project and never in version
 * control. The directory carries its own `.gitignore`, so the developer's
 * ignore files are never touched. Traces are kept until the developer runs
 * an explicit cleanup; nothing here deletes, exports or uploads one on its
 * own. Project records hold trace references only, so progress survives
 * cleanup.
 */

export const TRACE_DIRECTORY = ".jflow/traces";

function traceRoot(root: string): string {
  return join(root, TRACE_DIRECTORY);
}

function ensureTraceDirectory(root: string): void {
  mkdirSync(traceRoot(root), { recursive: true });
  // Ignores the whole local directory, this file included. `.jflow/` is
  // jflow's own, so the file is restored if anything else was put there.
  const ignore = join(root, ".jflow", ".gitignore");
  if (!existsSync(ignore) || readFileSync(ignore, "utf8") !== IGNORE_ALL) writeFileSync(ignore, IGNORE_ALL);
}

const IGNORE_ALL = "*\n";

/**
 * Starts a trace before anything is sent, so a sent exchange always has
 * one, and returns its reference: a path relative to the project root.
 */
export function startTrace(root: string, name: string, trace: object): string {
  ensureTraceDirectory(root);
  const reference = `${TRACE_DIRECTORY}/${name}.json`;
  writeFileSync(join(root, reference), `${JSON.stringify(trace, null, 2)}\n`, { flag: "wx" });
  return reference;
}

/** Completes a started trace with what came back. */
export function completeTrace(root: string, reference: string, trace: object): void {
  writeFileSync(join(root, reference), `${JSON.stringify(trace, null, 2)}\n`);
}

/** Trace references currently on disk, oldest name first. */
export function listTraces(root: string): string[] {
  if (!existsSync(traceRoot(root))) return [];
  return readdirSync(traceRoot(root))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => `${TRACE_DIRECTORY}/${file}`);
}

/**
 * Deletes every local trace. Only the developer invokes this; project
 * records, which keep summaries and references, are left as they are.
 */
export function cleanTraces(root: string): { readonly removed: readonly string[] } {
  const removed = listTraces(root);
  for (const reference of removed) rmSync(join(root, reference));
  return { removed };
}
