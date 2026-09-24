import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readWorkingTree } from "../project/worktree.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";

/**
 * Issue #7's acceptance criteria at the workflow-action-contract seam: a
 * project directory in a known state, a request, and the observable result.
 */

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("Git requirement by action", () => {
  it("runs brainstorm and plan with no Git repository present", () => {
    expect(harness().runAction("brainstorm").kind).toBe("ready");
    expect(harness({ state: { specificationAccepted: true } }).runAction("plan").kind).toBe("ready");
  });

  it.each([
    ["implement", { planAccepted: true, executionAuthorized: true, assignedTicketId: "T1" }],
    ["review", { ticketChangesPresent: true }],
  ] as const)("refuses %s without a repository, with an actionable reason", (action, state) => {
    const h = harness({ state });

    const outcome = h.runAction(action);

    expect(outcome.kind).toBe("blocked");
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.reasons.join(" ")).toContain("a local Git repository is required");
    expect(h.snapshot()).not.toHaveProperty(".git");
  });
});

describe("actions that never edit code", () => {
  it.each([
    ["troubleshoot", {}],
    ["review", { ticketChangesPresent: true, ticketAdmittedToReview: true, assignedTicketId: "T1" }],
  ] as const)("%s leaves the working tree exactly as it found it", (action, state) => {
    const h = harness({ state, gitRepository: true });
    h.writeFile("src/app.ts", "export const broken = true;\n");
    const files = h.snapshot();
    const tree = readWorkingTree(h.root);

    const outcome = h.runAction(action);

    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.resolution.action.canEditCode).toBe(false);
    expect(h.snapshot()).toEqual(files);
    expect(readWorkingTree(h.root)).toEqual(tree);
  });
});

describe("the helper's access to Git", () => {
  const source = join(dirname(fileURLToPath(import.meta.url)), "..");

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "testing" ? [] : sourceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("spawns processes only from the read-only Git module and the host probe", () => {
    const spawning = sourceFiles(source)
      .filter((file) => /from "node:child_process"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(source, file).split("\\").join("/"))
      .sort();

    // worktree.ts admits read-only Git subcommands only; the host probe runs
    // `git --version`. Anything new that spawns a process must justify itself here.
    expect(spawning).toEqual(["host/capabilities.ts", "project/worktree.ts"]);
  });
});
