import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { resolveConfiguration } from "../config/configuration.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import {
  createWorkflowState,
  resolveAction,
  type ActionResolution,
  type ResolutionContext,
  type WorkflowState,
} from "../actions/resolve.js";
import { runStatus, type StatusReport } from "../actions/status.js";
import { readProjectState, writeProjectState, type ProjectStateResult } from "../project/state.js";

/**
 * The workflow-action-contract test seam (SPEC.md, Testing Decisions): a
 * project directory in a known workflow state, one triggering request, and the
 * observable outcome as file state plus the human-ask events raised along the
 * way. Nothing here inspects agent prompt text. Test scaffolding only; not
 * part of the library surface.
 */

export interface HarnessOptions {
  /** Recorded state to start from; omitted means an uninitialized project. */
  readonly state?: Partial<Omit<WorkflowState, "gitRepositoryPresent">>;
  /** Whether the project directory should look like a Git repository. */
  readonly gitRepository?: boolean;
}

/** An event where the workflow stopped to ask the human (SPEC.md D28, D40). */
export interface HumanAskEvent {
  readonly kind: "human-ask";
  readonly action: string;
  readonly reasons: readonly string[];
}

export type ActionOutcome =
  | { readonly kind: "completed"; readonly action: "status"; readonly report: StatusReport }
  | { readonly kind: "blocked"; readonly resolution: Extract<ActionResolution, { status: "blocked" }> }
  | { readonly kind: "unknown-action"; readonly message: string }
  | {
      /** Eligible, but no executor exists yet for this action. */
      readonly kind: "not-implemented";
      readonly resolution: Extract<ActionResolution, { status: "eligible" }>;
    }
  | {
      /** The state record is unreadable, so nothing but `status` may run. */
      readonly kind: "malformed-record";
      readonly path: string;
      readonly message: string;
    };

export interface ProjectHarness {
  readonly root: string;
  /** Human-ask events recorded so far, in order. */
  readonly events: readonly HumanAskEvent[];
  runAction(action: string): ActionOutcome;
  readState(): ProjectStateResult;
  /** All files under the root, keyed by relative path, for before/after assertions. */
  snapshot(): Readonly<Record<string, string>>;
  path(relativePath: string): string;
  writeFile(relativePath: string, content: string): void;
  cleanup(): void;
}

function listFiles(root: string, directory = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, listFiles(root, full));
    else files[relative(root, full)] = readFileSync(full, "utf8");
  }
  return files;
}

export function createProjectHarness(options: HarnessOptions = {}): ProjectHarness {
  const workflowPackage = loadShippedWorkflowPackage();
  const configResult = resolveConfiguration({}, workflowPackage);
  if (!configResult.ok) {
    throw new Error("the shipped workflow package must accept an empty configuration");
  }
  const context: ResolutionContext = { workflowPackage, configuration: configResult.configuration };

  const root = mkdtempSync(join(tmpdir(), "jflow-project-"));
  if (options.gitRepository) mkdirSync(join(root, ".git"));
  if (options.state) writeProjectState(root, createWorkflowState(options.state));

  const events: HumanAskEvent[] = [];

  return {
    root,
    events,
    runAction(action) {
      // `status` is the one action that may run against an unreadable record,
      // because reporting the problem is its job.
      if (action === "status") {
        return { kind: "completed", action, report: runStatus(root, context) };
      }

      const read = readProjectState(root);
      if (read.kind === "malformed") {
        return { kind: "malformed-record", path: read.path, message: read.message };
      }

      const resolution = resolveAction({ action }, read.state, context);
      if (resolution.status === "unknown-action") {
        return { kind: "unknown-action", message: resolution.message };
      }
      if (resolution.status === "blocked") {
        if (resolution.requiresHumanAsk) {
          events.push({
            kind: "human-ask",
            action,
            reasons: resolution.unmet.filter((u) => u.needsHuman).map((u) => u.reason),
          });
        }
        return { kind: "blocked", resolution };
      }
      return { kind: "not-implemented", resolution };
    },
    readState: () => readProjectState(root),
    snapshot: () => listFiles(root),
    path: (relativePath) => join(root, relativePath),
    writeFile(relativePath, content) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
