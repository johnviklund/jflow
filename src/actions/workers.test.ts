import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguration } from "../config/configuration.js";
import { USAGE } from "../cli.js";
import { readRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { resolveAction, createWorkflowState, type ResolutionContext } from "./resolve.js";
import { assignWorker, finishWorker } from "./workers.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T17:00:00.000Z";

function contextWith(configuration: Record<string, unknown>): ResolutionContext {
  const resolved = resolveConfiguration(configuration, pkg);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
  return { workflowPackage: pkg, configuration: resolved.configuration };
}

const CONFIGURED = contextWith({
  primaryModel: "main-model",
  stageModels: {
    implement: { model: "builder-model", fallbackModel: "builder-fallback" },
    review: { model: "reviewer-model" },
  },
});

function project(): ProjectHarness {
  const h = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true } });
  harnesses.push(h);
  return h;
}

const assignmentsOf = (h: ProjectHarness) => {
  const read = readRecord(h.root, "workers");
  return read.kind === "present" ? read.record.assignments : [];
};

const IMPLEMENTER = { stage: "implement", role: "implementer", agent: "worker-1", model: "builder-model", ticketId: "T1" };

describe("the stage's configured worker model", () => {
  it("is used, and the model the worker actually ran on is recorded", () => {
    const h = project();

    const result = assignWorker(h.root, IMPLEMENTER, CONFIGURED, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: { assignment: { id: "W-1", stage: "implement", role: "implementer", model: "builder-model", status: "active", startedAt: now } },
    });
    expect(assignmentsOf(h)).toHaveLength(1);
  });

  it("refuses a worker on any other model: a silent substitution", () => {
    const h = project();

    expect(assignWorker(h.root, { ...IMPLEMENTER, model: "some-other-model" }, CONFIGURED, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("builder-model"),
    });
    expect(assignmentsOf(h)).toEqual([]);
  });

  it("asks which model to use when the stage has none configured, starting nothing", () => {
    const h = project();

    const result = assignWorker(h.root, { ...IMPLEMENTER, stage: "plan", role: "planner" }, CONFIGURED, { now });

    expect(result).toMatchObject({ ok: true, outcome: { askHuman: { reasons: [expect.stringContaining("plan")] } } });
    expect(result).not.toHaveProperty("outcome.assignment");
    expect(assignmentsOf(h)).toEqual([]);
  });
});

describe("an unavailable worker model", () => {
  const UNAVAILABLE = { model: "builder-model", reason: "the host reported the model unavailable" };

  it("runs only the explicitly configured fallback, recording the substitution", () => {
    const h = project();

    const result = assignWorker(h.root, { ...IMPLEMENTER, model: "builder-fallback", unavailable: UNAVAILABLE }, CONFIGURED, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: { assignment: { model: "builder-fallback", substitution: { unavailableModel: "builder-model", reason: UNAVAILABLE.reason } } },
    });
  });

  it("refuses any model but the configured fallback", () => {
    const h = project();

    expect(
      assignWorker(h.root, { ...IMPLEMENTER, model: "whatever-works", unavailable: UNAVAILABLE }, CONFIGURED, { now }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("builder-fallback") });
  });

  it("asks and starts nothing when no fallback is configured", () => {
    const h = project();

    const result = assignWorker(
      h.root,
      { stage: "review", role: "reviewer", agent: "reviewer-1", model: "reviewer-model", unavailable: { model: "reviewer-model", reason: "down" } },
      CONFIGURED,
      { now },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { askHuman: { reasons: [expect.stringMatching(/no fallback.*stageModels\.review/)] } },
    });
    expect(assignmentsOf(h)).toEqual([]);
  });

  it("asks when the fallback is unavailable too", () => {
    const h = project();

    const result = assignWorker(
      h.root,
      { ...IMPLEMENTER, model: "builder-fallback", unavailable: { model: "builder-fallback", reason: "also down" } },
      CONFIGURED,
      { now },
    );

    expect(result).toMatchObject({ ok: true, outcome: { askHuman: { reasons: [expect.stringContaining("fallback")] } } });
    expect(assignmentsOf(h)).toEqual([]);
  });
});

describe("assignments stay within the stage's roles and delegation limits", () => {
  it("refuses a role the stage does not declare", () => {
    const h = project();

    expect(assignWorker(h.root, { ...IMPLEMENTER, role: "reviewer" }, CONFIGURED, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("implementer"),
    });
  });

  it("counts the limit within one ticket, the unit of work", () => {
    const h = project();

    assignWorker(h.root, { stage: "review", role: "reviewer", agent: "reviewer-1", model: "reviewer-model", ticketId: "T1" }, CONFIGURED, { now });

    expect(
      assignWorker(h.root, { stage: "review", role: "reviewer", agent: "reviewer-2", model: "reviewer-model", ticketId: "T2" }, CONFIGURED, { now }),
    ).toMatchObject({ ok: true });
  });

  it("refuses more concurrent workers than the stage allows, and frees a place when one finishes", () => {
    const h = project();
    const tight = contextWith({
      stageModels: { implement: { model: "builder-model" } },
      settings: { "delegation.maxParallelWorkers": 2 },
    });

    assignWorker(h.root, IMPLEMENTER, tight, { now });
    assignWorker(h.root, { ...IMPLEMENTER, agent: "worker-2" }, tight, { now });
    expect(assignWorker(h.root, { ...IMPLEMENTER, agent: "worker-3" }, tight, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("2"),
    });

    expect(finishWorker(h.root, "W-1", { now })).toMatchObject({ ok: true, outcome: { assignment: { status: "finished", finishedAt: now } } });
    expect(assignWorker(h.root, { ...IMPLEMENTER, agent: "worker-3" }, tight, { now })).toMatchObject({ ok: true });
  });

  it("allows one worker at a time in a stage that forbids parallel work", () => {
    const h = project();

    assignWorker(h.root, { stage: "review", role: "reviewer", agent: "reviewer-1", model: "reviewer-model" }, CONFIGURED, { now });

    expect(
      assignWorker(h.root, { stage: "review", role: "reviewer", agent: "reviewer-2", model: "reviewer-model" }, CONFIGURED, { now }),
    ).toMatchObject({ ok: false });
  });

  it("refuses an always-available action or an unknown stage", () => {
    const h = project();

    expect(assignWorker(h.root, { ...IMPLEMENTER, stage: "status", role: "reporter" }, CONFIGURED, { now })).toMatchObject({ ok: false });
    expect(assignWorker(h.root, { ...IMPLEMENTER, stage: "deploy" }, CONFIGURED, { now })).toMatchObject({ ok: false });
  });
});

describe("the main conversational model", () => {
  it("is never assigned a stage model: the primary agent cannot be recorded as a worker", () => {
    const h = project();

    expect(assignWorker(h.root, { ...IMPLEMENTER, agent: "primary" }, CONFIGURED, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("primary"),
    });
  });

  it("is never switched between stages: resolution hands out worker models only", () => {
    const state = createWorkflowState({
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
      ticketChangesPresent: true,
      ticketAdmittedToReview: true,
      gitRepositoryPresent: true,
    });
    for (const action of pkg.actions) {
      const resolution = resolveAction({ action: action.name }, state, CONFIGURED);
      expect(JSON.stringify(resolution)).not.toContain("main-model");
    }
  });
});

describe("model-neutral language", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const MODEL_NAMES = /\b(claude|gpt|gemini|llama|mistral|opus|sonnet|haiku|fable|astra|sol)\b/i;

  function files(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const full = join(directory, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  }

  it("names no specific model in the skill, the workflow package, the README or the helper's usage", () => {
    const texts = [...files(join(root, "skill")), ...files(join(root, "workflow")), join(root, "README.md")]
      .filter((file) => /\.(md|json)$/.test(file))
      .map((file) => ({ file, text: readFileSync(file, "utf8") }));

    for (const { file, text } of [...texts, { file: "USAGE", text: USAGE }]) {
      expect(text.match(MODEL_NAMES)?.[0], file).toBeUndefined();
    }
  });
});
