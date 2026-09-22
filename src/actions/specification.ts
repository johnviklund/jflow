import {
  RecordValidationError,
  readRecord,
  writeRecord,
  type DecisionStatus,
  type RecordReadResult,
  type SpecificationDecision,
  type SpecificationRecord,
} from "../project/records.js";
import type { ValidationIssue } from "../workflow/types.js";

/**
 * The helper's part of `brainstorm` (issue #5, D27, D51): writing the
 * specification the skill's method produced, recording the developer's
 * decisions on its proposals, and recording acceptance. The investigation
 * and the wording are the skill's; nothing here judges content. What the
 * helper does hold in code is who decides: every decision lands as a
 * proposal, and only a recorded word from the developer confirms or rejects
 * it or accepts the specification.
 */

/** What the method supplies; status, timestamps and acceptance are the helper's. */
export interface SpecificationDraft {
  readonly title: string;
  readonly problem: string;
  readonly scenarios: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly exclusions: readonly string[];
  /** Decisions are stored as proposals whatever status the draft claims. */
  readonly decisions: readonly Omit<SpecificationDecision, "status">[];
}

export type SpecificationResult =
  | { readonly ok: true; readonly record: SpecificationRecord }
  | {
      readonly ok: false;
      /** Why the operation was refused, for the developer. */
      readonly reason: string;
      /** Present when the refusal is a validation failure. */
      readonly issues?: readonly ValidationIssue[];
    };

function refuse(reason: string, issues?: readonly ValidationIssue[]): SpecificationResult {
  return issues === undefined ? { ok: false, reason } : { ok: false, reason, issues };
}

function unreadable(read: Extract<RecordReadResult<"specification">, { kind: "malformed" }>) {
  return refuse(`the specification record at ${read.path} cannot be read`, read.issues);
}

function store(root: string, record: SpecificationRecord): SpecificationResult {
  try {
    writeRecord(root, "specification", record);
  } catch (error) {
    if (error instanceof RecordValidationError) {
      return refuse("the specification is not complete", error.issues);
    }
    throw error;
  }
  return { ok: true, record };
}

/**
 * Writes a specification as awaiting acceptance, every decision a proposal.
 * An accepted specification is never rewritten here: changing agreed scope
 * is `realign`'s job (D42). An unaccepted one is replaced; nothing in the
 * progress record depends on it, since plan acceptance needs an accepted
 * specification first.
 */
export function writeSpecification(
  root: string,
  draft: SpecificationDraft,
  options: { readonly now: string },
): SpecificationResult {
  const existing = readRecord(root, "specification");
  if (existing.kind === "malformed") return unreadable(existing);
  if (existing.kind === "present" && existing.record.status === "accepted") {
    return refuse(
      "the specification has been accepted; changing it is a plan change, so invoke realign rather than brainstorm again",
    );
  }

  const decisions = (Array.isArray(draft.decisions) ? draft.decisions : []).map(
    (decision): SpecificationDecision => ({
      id: decision.id,
      statement: decision.statement,
      status: "proposed",
      ...(decision.basis === undefined ? {} : { basis: decision.basis }),
    }),
  );
  return store(root, {
    title: draft.title,
    problem: draft.problem,
    scenarios: draft.scenarios,
    acceptanceCriteria: draft.acceptanceCriteria,
    constraints: draft.constraints,
    exclusions: draft.exclusions,
    decisions,
    status: "awaiting-acceptance",
    writtenAt: options.now,
  });
}

/**
 * Records the developer's decision on one proposal, in their words, while
 * the specification is still open.
 */
export function decideSpecification(
  root: string,
  decisionId: string,
  status: Exclude<DecisionStatus, "proposed">,
  options: { readonly basis: string },
): SpecificationResult {
  if (options.basis.trim() === "") {
    return refuse(
      `a decision is ${status} only on the developer's word; record what they said as the basis`,
    );
  }
  const read = readRecord(root, "specification");
  if (read.kind === "absent") return refuse("no specification has been written; run brainstorm first");
  if (read.kind === "malformed") return unreadable(read);
  const { record } = read;

  if (record.status === "accepted") {
    return refuse(
      `the specification is accepted; decision "${decisionId}" is settled and changes only through realign`,
    );
  }
  const index = record.decisions.findIndex((decision) => decision.id === decisionId);
  if (index === -1) {
    return refuse(
      `no decision "${decisionId}" in the specification; decisions are ${record.decisions.map((d) => d.id).join(", ") || "none"}`,
    );
  }

  const decisions = record.decisions.map((decision, at) =>
    at === index ? { ...decision, status, basis: options.basis } : decision,
  );
  return store(root, { ...record, decisions });
}

/**
 * Records the developer's explicit acceptance (D27). Refused while any
 * decision is still a proposal: what is accepted must be settled.
 */
export function acceptSpecification(
  root: string,
  options: { readonly now: string; readonly note?: string },
): SpecificationResult {
  const read = readRecord(root, "specification");
  if (read.kind === "absent") return refuse("no specification has been written; run brainstorm first");
  if (read.kind === "malformed") return unreadable(read);
  const { record } = read;

  if (record.status === "accepted") {
    return refuse(`the specification was already accepted at ${record.acceptedAt}`);
  }
  const pending = record.decisions.filter((decision) => decision.status === "proposed");
  if (pending.length > 0) {
    return refuse(
      `the specification still carries proposals awaiting the developer's decision: ${pending
        .map((decision) => `${decision.id} (${decision.statement})`)
        .join("; ")}; confirm or reject each before accepting`,
    );
  }

  return store(root, {
    ...record,
    status: "accepted",
    acceptedAt: options.now,
    ...(options.note === undefined ? {} : { acceptanceNote: options.note }),
  });
}
