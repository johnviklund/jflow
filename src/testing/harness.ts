import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { dispatch, type DispatchOutcome, type HumanAskEvent } from "../actions/dispatch.js";
import { createWorkflowState, type ResolutionContext, type WorkflowState } from "../actions/resolve.js";
import { resolveConfiguration } from "../config/configuration.js";
import { writeRecord, type SpecificationRecord } from "../project/records.js";
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
  readonly state?: Partial<Omit<WorkflowState, "gitRepositoryPresent">>;
  /** Whether the project directory should look like a Git repository. */
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
  /** All files under the root, keyed by relative path, for before/after assertions. */
  snapshot(): Readonly<Record<string, string>>;
  path(relativePath: string): string;
  writeFile(relativePath: string, content: string): void;
  cleanup(): void;
}

/** A placeholder specification, present only so the seeded gate has a record to live in. */
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

/**
 * Writes the records a `WorkflowState` is derived from: the specification's
 * status carries the specification gate, the progress record the rest. A
 * fresh authorization is seeded at ticket scope; Git presence is never written.
 */
function seedRecords(root: string, state: WorkflowState): void {
  const { gitRepositoryPresent: _observed, specificationAccepted, assignedTicketId, ...flags } =
    state;
  writeRecord(
    root,
    "specification",
    specificationAccepted
      ? { ...SEED_SPECIFICATION, status: "accepted", acceptedAt: "2026-01-01T00:00:00Z" }
      : SEED_SPECIFICATION,
  );
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
