import { afterEach, describe, expect, it } from "vitest";

import { readRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { promoteTodo, recordTodo } from "./todo.js";

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-23T10:00:00Z";

/** Mid-implementation: T1 authorized and assigned, with changes under way. */
function midImplementation(): ProjectHarness {
  return harness({
    state: {
      specificationAccepted: true,
      planAccepted: true,
      executionAuthorized: true,
      assignedTicketId: "T1",
      ticketChangesPresent: true,
    },
    gitRepository: true,
  });
}

describe("todo mid-action", () => {
  it("records the item without touching the plan, tickets or progress, so the action resumes as it was", () => {
    const h = midImplementation();
    h.writeFile("src/app.ts", "work in progress\n");
    const state = h.readState();
    const review = h.runAction("review");
    const files = h.snapshot();

    const result = recordTodo(h.root, { summary: "CSV export drops the header row" }, { now });

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        item: {
          id: "TODO-1",
          summary: "CSV export drops the header row",
          discoveredDuring: "T1",
          status: "open",
        },
      },
    });
    expect(h.readState()).toEqual(state);
    expect(h.runAction("review")).toEqual(review);
    const after = h.snapshot();
    const paths = new Set([...Object.keys(files), ...Object.keys(after)]);
    expect([...paths].filter((path) => after[path] !== files[path])).toEqual(["jflow/todos.json"]);
    expect(h.events).toEqual([]);
  });

  it("is reached from a conversational request and never asks to be authorized", () => {
    const h = midImplementation();

    const outcome = h.request("note for later: the export button is misaligned");

    expect(outcome).toMatchObject({ kind: "ready", action: "todo" });
    expect(h.events).toEqual([]);
  });

  it("numbers items in order and keeps the context given", () => {
    const h = harness();

    recordTodo(h.root, { summary: "first" }, { now });
    const second = recordTodo(h.root, { summary: "second", detail: "seen in the importer" }, { now });

    expect(second).toMatchObject({
      ok: true,
      outcome: { item: { id: "TODO-2", detail: "seen in the importer" } },
    });
    const todos = readRecord(h.root, "todos");
    expect(todos.kind === "present" && todos.record.items.map((item) => item.id)).toEqual(["TODO-1", "TODO-2"]);
  });

  it("refuses an item with no summary", () => {
    const h = harness();

    expect(recordTodo(h.root, { summary: " " }, { now })).toMatchObject({ ok: false });
    expect(readRecord(h.root, "todos").kind).toBe("absent");
  });
});

describe("promoteTodo", () => {
  it("records the developer's decision and leaves adding the ticket to realign on an accepted plan", () => {
    const h = midImplementation();
    recordTodo(h.root, { summary: "rename the flag" }, { now });
    const tickets = readRecord(h.root, "tickets");
    const progress = readRecord(h.root, "progress");

    const result = promoteTodo(h.root, "TODO-1", { note: "yes, bring the rename into this plan", now });

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        item: {
          status: "promoted",
          promotion: { decidedAt: now, note: "yes, bring the rename into this plan" },
        },
        addTicketWith: "realign",
      },
    });
    expect(readRecord(h.root, "tickets")).toEqual(tickets);
    expect(readRecord(h.root, "progress")).toEqual(progress);
  });

  it("leaves adding the ticket to plan while the breakdown awaits acceptance", () => {
    const h = harness({ state: { specificationAccepted: true } });
    h.writeFile(
      "jflow/plan.json",
      JSON.stringify({ title: "t", summary: "s", status: "awaiting-acceptance", writtenAt: now }),
    );
    recordTodo(h.root, { summary: "rename the flag" }, { now });

    expect(promoteTodo(h.root, "TODO-1", { note: "include it", now })).toMatchObject({
      ok: true,
      outcome: { addTicketWith: "plan" },
    });
  });

  it("refuses without the developer's words, an unknown item, a second promotion, or no plan", () => {
    const h = midImplementation();
    const noPlan = harness();
    recordTodo(h.root, { summary: "rename the flag" }, { now });
    recordTodo(noPlan.root, { summary: "rename the flag" }, { now });

    expect(promoteTodo(h.root, "TODO-1", { note: "", now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("developer's words"),
    });
    expect(promoteTodo(h.root, "TODO-9", { note: "go", now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("TODO-9"),
    });
    expect(promoteTodo(h.root, "TODO-1", { note: "go", now })).toMatchObject({ ok: true });
    expect(promoteTodo(h.root, "TODO-1", { note: "go", now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already promoted"),
    });
    expect(promoteTodo(noPlan.root, "TODO-1", { note: "go", now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no plan"),
    });
  });
});
