import {
  readRecord,
  validateRecord,
  writeRecord,
  type ConflictEntry,
  type ConflictsRecord,
  type ConsequentialArea,
} from "../project/records.js";
import type { HumanAskEvent } from "./dispatch.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";

/**
 * Conflicts met during the work (D7, issue #17). A hard rule, so Jev is
 * never asked: a conflict that touches requirements, scope, workflow rules
 * or permissions goes to the developer with a recommendation and waits; an
 * ordinary technical disagreement is settled by investigation and recorded,
 * and goes to the developer only when the investigation is inconclusive.
 * Only the conflicts record is written.
 */

export interface ConflictDraft {
  readonly summary: string;
  /** What the conflict would change that only the developer may; empty for a technical disagreement. */
  readonly touches: readonly ConsequentialArea[];
  /** What was investigated; required for a technical disagreement. */
  readonly investigation?: {
    readonly finding: string;
    readonly evidence: readonly string[];
    /** Whether the evidence settles the disagreement. */
    readonly conclusive: boolean;
  };
}

export type ConflictResult =
  | {
      readonly ok: true;
      readonly outcome: {
        readonly conflict: ConflictEntry;
        /** Present when the developer must decide; the skill asks and waits. */
        readonly askHuman?: HumanAskEvent;
      };
    }
  | Refusal;

type ConflictsRead = { readonly ok: true; readonly record: ConflictsRecord } | Refusal;

function readConflicts(root: string): ConflictsRead {
  const read = readRecord(root, "conflicts");
  if (read.kind === "malformed") return unreadable("conflicts", read);
  return { ok: true, record: read.kind === "present" ? read.record : { conflicts: [] } };
}

function save(root: string, record: ConflictsRecord): Refusal | undefined {
  const validated = validateRecord("conflicts", record);
  if (!validated.ok) return refuse("the conflict cannot be recorded", validated.issues);
  writeRecord(root, "conflicts", validated.record);
  return undefined;
}

function nextId(record: ConflictsRecord): string {
  const numbers = record.conflicts.map((entry) => Number(/^C(\d+)$/.exec(entry.id)?.[1] ?? 0));
  return `C${Math.max(0, ...numbers) + 1}`;
}

export function raiseConflict(root: string, draft: ConflictDraft, options: { readonly now: string }): ConflictResult {
  const summary = draft.summary.trim();
  if (summary === "") return refuse("a conflict needs a summary of what disagrees with what");
  const investigation = draft.investigation;
  if (draft.touches.length === 0 && investigation === undefined) {
    return refuse(
      "a technical disagreement is settled by investigation: record what you investigated, what it found and whether it is conclusive",
    );
  }
  const current = readConflicts(root);
  if (!current.ok) return current;

  const id = nextId(current.record);
  const investigated =
    investigation === undefined ? {} : { investigation: { finding: investigation.finding, evidence: investigation.evidence } };
  let conflict: ConflictEntry;
  let askHuman: HumanAskEvent | undefined;
  if (draft.touches.length > 0) {
    conflict = {
      id,
      summary,
      kind: "consequential",
      touches: draft.touches,
      recordedAt: options.now,
      status: "awaiting-developer",
      ...investigated,
    };
    askHuman = {
      kind: "human-ask",
      reasons: [`${summary} (conflict ${id} touches ${draft.touches.join(", ")}; the decision is yours)`],
    };
  } else if (investigation!.conclusive) {
    conflict = {
      id,
      summary,
      kind: "technical",
      recordedAt: options.now,
      status: "resolved",
      ...investigated,
      resolution: {
        by: "investigation",
        note: investigation!.finding,
        evidence: investigation!.evidence,
        resolvedAt: options.now,
      },
    };
  } else {
    conflict = { id, summary, kind: "technical", recordedAt: options.now, status: "awaiting-developer", ...investigated };
    askHuman = {
      kind: "human-ask",
      reasons: [`${summary} (conflict ${id}: investigation was inconclusive: ${investigation!.finding})`],
    };
  }

  const refused = save(root, { conflicts: [...current.record.conflicts, conflict] });
  if (refused) return refused;
  return { ok: true, outcome: askHuman === undefined ? { conflict } : { conflict, askHuman } };
}

/** Records the developer's decision on a conflict that waits for them. */
export function decideConflict(
  root: string,
  id: string,
  decision: { readonly note: string; readonly now: string },
): ConflictResult {
  if (decision.note.trim() === "") return refuse("record the developer's decision in their words");
  const current = readConflicts(root);
  if (!current.ok) return current;
  const target = current.record.conflicts.find((entry) => entry.id === id);
  if (target === undefined) return refuse(`no conflict "${id}"`);
  if (target.status !== "awaiting-developer") return refuse(`conflict "${id}" is already resolved`);

  const conflict: ConflictEntry = {
    ...target,
    status: "resolved",
    resolution: { by: "developer", note: decision.note, resolvedAt: decision.now },
  };
  const refused = save(root, {
    conflicts: current.record.conflicts.map((entry) => (entry.id === id ? conflict : entry)),
  });
  if (refused) return refused;
  return { ok: true, outcome: { conflict } };
}
