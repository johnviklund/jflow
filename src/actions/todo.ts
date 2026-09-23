import { readRecord, validateRecord, writeRecord, type TodoItem, type TodosRecord } from "../project/records.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";

/**
 * The helper's part of `todo` (issue #14, D26): capture future work outside
 * the active plan at any point, and record the developer's explicit decision
 * to promote an item. Only the todos record is written: no ticket, no
 * progress, no authorization, so whatever action was under way resumes
 * exactly as it was.
 */

export interface TodoDraft {
  readonly summary: string;
  readonly detail?: string;
}

export type TodoResult =
  | { readonly ok: true; readonly outcome: { readonly item: TodoItem; readonly todos: TodosRecord } }
  | Refusal;

export type PromotionResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly item: TodoItem;
        /**
         * Promotion adds no ticket itself. While the breakdown awaits
         * acceptance, `plan` adds it; once accepted, adding it is an in-flight
         * plan change, which is `realign`'s and the developer's to invoke (D42).
         */
        readonly addTicketWith: "plan" | "realign";
      };
    }
  | Refusal;

type TodosRead = { readonly ok: true; readonly todos: TodosRecord } | Refusal;

function readTodos(root: string): TodosRead {
  const read = readRecord(root, "todos");
  if (read.kind === "malformed") return unreadable("todos", read);
  return { ok: true, todos: read.kind === "present" ? read.record : { items: [] } };
}

function nextId(todos: TodosRecord): string {
  const numbers = todos.items.map((item) => Number(/^TODO-(\d+)$/.exec(item.id)?.[1] ?? 0));
  return `TODO-${Math.max(0, ...numbers) + 1}`;
}

function save(root: string, todos: TodosRecord): { readonly ok: true; readonly todos: TodosRecord } | Refusal {
  const validated = validateRecord("todos", todos);
  if (!validated.ok) return refuse("the todo cannot be recorded", validated.issues);
  writeRecord(root, "todos", validated.record);
  return { ok: true, todos: validated.record };
}

export function recordTodo(root: string, draft: TodoDraft, options: { readonly now: string }): TodoResult {
  const current = readTodos(root);
  if (!current.ok) return current;
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return unreadable("progress", progress);

  const assigned = progress.kind === "present" ? progress.record.assignedTicketId : undefined;
  const item: TodoItem = {
    id: nextId(current.todos),
    summary: draft.summary.trim(),
    ...(draft.detail === undefined ? {} : { detail: draft.detail }),
    ...(assigned === undefined ? {} : { discoveredDuring: assigned }),
    recordedAt: options.now,
    status: "open",
  };
  const saved = save(root, { items: [...current.todos.items, item] });
  if (!saved.ok) return saved;
  return { ok: true, outcome: { item, todos: saved.todos } };
}

export function promoteTodo(
  root: string,
  id: string,
  decision: { readonly note: string; readonly now: string },
): PromotionResult {
  if (decision.note.trim() === "") {
    return refuse("promotion is the developer's explicit decision; record it in the developer's words");
  }
  const current = readTodos(root);
  if (!current.ok) return current;
  const target = current.todos.items.find((item) => item.id === id);
  if (target === undefined) {
    const known = current.todos.items.map((item) => item.id).join(", ") || "none";
    return refuse(`no todo "${id}"; recorded todos are ${known}`);
  }
  if (target.status === "promoted") return refuse(`todo "${id}" is already promoted`);

  const plan = readRecord(root, "plan");
  if (plan.kind === "malformed") return unreadable("plan", plan);
  if (plan.kind === "absent") {
    return refuse("there is no plan to promote into; the todo stays recorded until a plan exists");
  }

  const item: TodoItem = {
    ...target,
    status: "promoted",
    promotion: { decidedAt: decision.now, note: decision.note },
  };
  const saved = save(root, {
    items: current.todos.items.map((entry) => (entry.id === id ? item : entry)),
  });
  if (!saved.ok) return saved;
  return {
    ok: true,
    outcome: { item, addTicketWith: plan.record.status === "accepted" ? "realign" : "plan" },
  };
}
