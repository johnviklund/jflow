import {
  readRecord,
  validateRecord,
  writeRecord,
  type DiagnosesRecord,
  type DiagnosisEntry,
  type TreeEntry,
} from "../project/records.js";
import { snapshotWorkingTree } from "../project/worktree.js";
import { hasText } from "../validation.js";
import { readWorkingTicket } from "./implement.js";
import { refuse, unreadable, type Refusal } from "./refusal.js";

/**
 * The helper's part of `troubleshoot` (issue #11, D8, D51): a failed check
 * is diagnosed, never fixed, here. `startDiagnosis` records the failure and
 * snapshots the working tree; `recordDiagnosis` records the finding, its
 * evidence and a recommended fix, and only once the working tree is
 * confirmed as it was; `applyDiagnosis` records that an authorized
 * `implement` made the fix. Only the diagnoses record is written, and
 * `review` hands the ticket's diagnoses to the reviewer as evidence.
 */

/** How much of a failed check's output is kept: its end, where failures are reported (D23). */
export const EXCERPT_LIMIT = 2000;

export interface FailedCheck {
  readonly source: string;
  readonly text: string;
  readonly exitCode?: number;
}

export interface DiagnosisStart {
  /** Defaults to the ticket in progress, if any. */
  readonly ticketId?: string;
  readonly check: FailedCheck;
}

export interface DiagnosisFinding {
  readonly id: string;
  readonly finding: string;
  readonly evidence: readonly string[];
  readonly recommendation: string;
}

export type DiagnosisResult = { readonly ok: true; readonly outcome: { readonly diagnosis: DiagnosisEntry } } | Refusal;

type Diagnoses = { readonly ok: true; readonly record: DiagnosesRecord } | Refusal;

function readDiagnoses(root: string): Diagnoses {
  const read = readRecord(root, "diagnoses");
  if (read.kind === "malformed") return unreadable("diagnoses", read);
  return { ok: true, record: read.kind === "present" ? read.record : { diagnoses: [] } };
}

function saveDiagnosis(root: string, record: DiagnosesRecord, entry: DiagnosisEntry): DiagnosisResult {
  const next = validateRecord("diagnoses", {
    diagnoses: record.diagnoses.some((existing) => existing.id === entry.id)
      ? record.diagnoses.map((existing) => (existing.id === entry.id ? entry : existing))
      : [...record.diagnoses, entry],
  });
  if (!next.ok) return refuse("the diagnosis cannot be recorded", next.issues);
  writeRecord(root, "diagnoses", next.record);
  return { ok: true, outcome: { diagnosis: entry } };
}

/** `DIAG-n`, so a diagnosis is never mistaken for a specification decision (`D<n>`). */
function nextId(record: DiagnosesRecord): string {
  const numbers = record.diagnoses.map((entry) => Number(/^DIAG-(\d+)$/.exec(entry.id)?.[1] ?? 0));
  return `DIAG-${Math.max(0, ...numbers) + 1}`;
}

function assignedTicket(root: string): { readonly ok: true; readonly ticketId?: string } | Refusal {
  const progress = readRecord(root, "progress");
  if (progress.kind === "malformed") return unreadable("progress", progress);
  const ticketId = progress.kind === "present" ? progress.record.assignedTicketId : undefined;
  return ticketId === undefined ? { ok: true } : { ok: true, ticketId };
}

function findDiagnosis(record: DiagnosesRecord, id: unknown): DiagnosisEntry | Refusal {
  const entry = record.diagnoses.find((existing) => existing.id === id);
  if (entry !== undefined) return entry;
  return refuse(`no diagnosis "${String(id)}"; recorded diagnoses are ${record.diagnoses.map((e) => e.id).join(", ") || "none"}`);
}

const isRefusal = (value: DiagnosisEntry | Refusal): value is Refusal => "ok" in value;

/**
 * Records a failed check for diagnosis, against the ticket in progress
 * unless another is named, with a snapshot of the working tree to check
 * the diagnosis against. A check that passed is not a failure.
 */
export function startDiagnosis(root: string, input: DiagnosisStart, options: { readonly now: string }): DiagnosisResult {
  const check = input?.check;
  if (!hasText(check?.source)) return refuse("name the failed check: the exact command that ran");
  if (check.exitCode === 0) return refuse(`${check.source} exited 0; troubleshoot diagnoses a failed check`);
  const current = readDiagnoses(root);
  if (!current.ok) return current;
  const assigned = assignedTicket(root);
  if (!assigned.ok) return assigned;
  const ticketId = input.ticketId ?? assigned.ticketId;
  if (input.ticketId !== undefined) {
    const tickets = readRecord(root, "tickets");
    if (tickets.kind === "malformed") return unreadable("tickets", tickets);
    if (tickets.kind === "absent" || !tickets.record.tickets.some((ticket) => ticket.id === input.ticketId)) {
      return refuse(`no ticket "${input.ticketId}" in the plan to diagnose`);
    }
  }

  const snapshot = snapshotWorkingTree(root);
  if (snapshot.kind === "unreadable") {
    return refuse(`the Git repository cannot be read (${snapshot.message}); the working tree could not be recorded`);
  }
  const text = typeof check.text === "string" ? check.text : "";
  const entry: DiagnosisEntry = {
    id: nextId(current.record),
    ...(ticketId === undefined ? {} : { ticketId }),
    check: {
      source: check.source.trim(),
      ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
      excerpt: text.slice(-EXCERPT_LIMIT),
    },
    status: "diagnosing",
    startedAt: options.now,
    ...(snapshot.kind === "present"
      ? { baseline: { ...(snapshot.head === undefined ? {} : { head: snapshot.head }), files: snapshot.files } }
      : {}),
  };
  return saveDiagnosis(root, current.record, entry);
}

/** The paths whose content differs between two snapshots, and whether HEAD moved. */
function differences(
  before: NonNullable<DiagnosisEntry["baseline"]>,
  after: { readonly head?: string; readonly files: readonly TreeEntry[] },
): string[] {
  const key = (file: TreeEntry) => `${file.path}\0${file.sha256 ?? ""}`;
  const was = new Set(before.files.map(key));
  const is = new Set(after.files.map(key));
  const changed = new Set([
    ...before.files.filter((file) => !is.has(key(file))).map((file) => file.path),
    ...after.files.filter((file) => !was.has(key(file))).map((file) => file.path),
  ]);
  const moved = before.head !== after.head ? ["HEAD"] : [];
  return [...moved, ...[...changed].sort()];
}

/**
 * Records the diagnosis: what failed and why, the evidence, and the
 * recommended fix. Refused while the working tree differs from when
 * troubleshooting began, naming what changed; troubleshoot edits nothing.
 */
export function recordDiagnosis(root: string, input: DiagnosisFinding, options: { readonly now: string }): DiagnosisResult {
  if (!hasText(input?.finding)) return refuse("a diagnosis needs its finding: what fails and why");
  if (!hasText(input.recommendation)) return refuse("a diagnosis needs a recommended fix");
  const current = readDiagnoses(root);
  if (!current.ok) return current;
  const entry = findDiagnosis(current.record, input.id);
  if (isRefusal(entry)) return entry;
  if (entry.status !== "diagnosing") return refuse(`diagnosis ${entry.id} is already ${entry.status}`);

  let treeCheck: "unchanged" | "unverified" = "unverified";
  if (entry.baseline !== undefined) {
    const snapshot = snapshotWorkingTree(root);
    if (snapshot.kind !== "present") return refuse("the working tree cannot be read to confirm troubleshoot left it unchanged");
    const changed = differences(entry.baseline, snapshot);
    if (changed.length > 0) {
      return refuse(
        `the working tree changed while troubleshooting (${changed.join(", ")}); troubleshoot never edits code, so the diagnosis is not recorded`,
      );
    }
    treeCheck = "unchanged";
  }
  return saveDiagnosis(root, current.record, {
    ...entry,
    status: "diagnosed",
    diagnosis: {
      finding: input.finding.trim(),
      evidence: (Array.isArray(input.evidence) ? input.evidence : []).filter(hasText),
      recommendation: input.recommendation.trim(),
      recordedAt: options.now,
      treeCheck,
    },
  });
}

/**
 * Records that `implement` applied the recommended fix, once made, for the
 * ticket in progress, under recorded execution authorization. A diagnosis
 * made for another ticket is not this ticket's to apply.
 */
export function applyDiagnosis(
  root: string,
  input: { readonly id: string; readonly note?: string },
  options: { readonly now: string },
): DiagnosisResult {
  const current = readDiagnoses(root);
  if (!current.ok) return current;
  const entry = findDiagnosis(current.record, input?.id);
  if (isRefusal(entry)) return entry;
  if (entry.status !== "diagnosed") return refuse(`diagnosis ${entry.id} is ${entry.status}; only a recorded diagnosis is applied`);
  const assigned = assignedTicket(root);
  if (!assigned.ok) return assigned;
  if (entry.ticketId !== undefined && entry.ticketId !== assigned.ticketId) {
    return refuse(`diagnosis ${entry.id} is for ticket ${entry.ticketId}; a fix is applied by that ticket's implement`);
  }
  const working = readWorkingTicket(root, assigned.ticketId);
  if (!working.ok) return working;
  const note = input.note?.trim();
  // A diagnosis made with no ticket assigned becomes the applying ticket's, so its review sees it.
  return saveDiagnosis(root, current.record, {
    ...entry,
    ticketId: working.ticket.id,
    status: "applied",
    application: { ticketId: working.ticket.id, appliedAt: options.now, ...(hasText(note) ? { note } : {}) },
  });
}

/** The diagnoses recorded for a ticket, for its reviewer as evidence. */
export function readTicketDiagnoses(
  root: string,
  ticketId: string,
): { readonly ok: true; readonly diagnoses: readonly DiagnosisEntry[] } | Refusal {
  const current = readDiagnoses(root);
  if (!current.ok) return current;
  return {
    ok: true,
    diagnoses: current.record.diagnoses.filter((entry) => entry.ticketId === ticketId && entry.status !== "diagnosing"),
  };
}
