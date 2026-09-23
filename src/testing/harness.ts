import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { dispatch, type DispatchOutcome, type HumanAskEvent } from "../actions/dispatch.js";
import {
  createWorkflowState,
  type ObservedStateField,
  type ResolutionContext,
  type WorkflowState,
} from "../actions/resolve.js";
import { resolveConfiguration } from "../config/configuration.js";
import { writeRecord, type PlanRecord, type SpecificationRecord } from "../project/records.js";
import { readProjectState, type ProjectStateResult } from "../project/state.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";

/**
 * The workflow-action-contract test seam (SPEC.md, Testing Decisions): a
 * project directory in a known workflow state, one triggering request, and the
 * observable outcome as file state plus the human-ask events raised along the
 * way. Nothing here inspects agent prompt text. Test scaffolding only; not
 * part of the library surface.
 */

export interface HarnessOptions {
  /** Recorded state to start from; omitted means an uninitialized project. */
  readonly state?: Partial<Omit<WorkflowState, ObservedStateField>>;
  /**
   * Whether the project directory is a Git repository. The harness runs
   * `git init` itself, as the developer would; jflow never does.
   */
  readonly gitRepository?: boolean;
}

export type { HumanAskEvent };

export type ActionOutcome = DispatchOutcome;

export interface ProjectHarness {
  readonly root: string;
  /** Human-ask events recorded so far, in order. */
  readonly events: readonly HumanAskEvent[];
  /** Runs a request as the developer would phrase it: an action name or a sentence. */
  request(text: string): ActionOutcome;
  /** Runs an action by name. */
  runAction(action: string): ActionOutcome;
  readState(): ProjectStateResult;
  /** All working-tree files under the root (not `.git`), keyed by relative path. */
  snapshot(): Readonly<Record<string, string>>;
  path(relativePath: string): string;
  writeFile(relativePath: string, content: string): void;
  cleanup(): void;
}

/** Placeholder records, present only so a seeded open gate has a record to live in. */
const SEED_SPECIFICATION: SpecificationRecord = {
  title: "Seeded specification",
  problem: "Seeded by the test harness.",
  scenarios: ["seeded"],
  acceptanceCriteria: ["seeded"],
  constraints: [],
  exclusions: [],
  decisions: [],
  status: "awaiting-acceptance",
  writtenAt: "2026-01-01T00:00:00Z",
};

const SEED_PLAN: PlanRecord = {
  title: "Seeded plan",
  summary: "Seeded by the test harness.",
  status: "awaiting-acceptance",
  writtenAt: "2026-01-01T00:00:00Z",
};

/**
 * Writes the records a `WorkflowState` is derived from: the specification
 * and plan statuses carry their gates, the progress record the rest. A
 * fresh authorization is seeded at ticket scope; observed working-tree state
 * is never written.
 */
function seedRecords(root: string, state: WorkflowState): void {
  const {
    gitRepositoryPresent: _present,
    gitRepositoryUnreadable: _unreadable,
    unclaimedChanges: _unclaimed,
    specificationAccepted,
    planAccepted,
    assignedTicketId,
    ...flags
  } = state;
  // Only an accepted gate needs its record; an absent record is the closed gate.
  if (specificationAccepted) {
    writeRecord(root, "specification", {
      ...SEED_SPECIFICATION,
      status: "accepted",
      acceptedAt: "2026-01-01T00:00:00Z",
    });
  }
  if (planAccepted) {
    writeRecord(root, "plan", { ...SEED_PLAN, status: "accepted", acceptedAt: "2026-01-01T00:00:00Z" });
  }
  writeRecord(root, "progress", {
    ...flags,
    ...(flags.executionAuthorized ? { authorizationScope: "ticket" } : {}),
    ...(assignedTicketId === undefined ? {} : { assignedTicketId }),
  });
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

export function createProjectHarness(options: HarnessOptions = {}): ProjectHarness {
  const workflowPackage = loadShippedWorkflowPackage();
  const configResult = resolveConfiguration({}, workflowPackage);
  if (!configResult.ok) {
    throw new Error("the shipped workflow package must accept an empty configuration");
  }
  const context: ResolutionContext = { workflowPackage, configuration: configResult.configuration };

  const root = mkdtempSync(join(tmpdir(), "jflow-project-"));
  if (options.gitRepository) execFileSync("git", ["init", "--quiet"], { cwd: root });
  if (options.state) seedRecords(root, createWorkflowState(options.state));

  const events: HumanAskEvent[] = [];
  const request = (text: string) =>
    dispatch(root, text, context, { onHumanAsk: (event) => events.push(event) });

  return {
    root,
    events,
    request,
    runAction: request,
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
