import {
  CRITERION_VERDICTS,
  EMPTY_PROGRESS,
  readRecord,
  validateRecord,
  writeRecord,
  type CriterionJudgment,
  type CriterionVerdict,
  type TicketRecord,
  type TicketValidation,
} from "../project/records.js";
import {
  askDecision,
  recordChoice,
  type ChoiceMaker,
  type DecisionDependencies,
  type DecisionEnvelope,
  type DecisionInput,
} from "./decisions.js";
import { askEscalation, humanAskAt, type EscalationAsk } from "./escalation.js";
import type { EvidenceExcerpt } from "./evidence.js";
import { isOneOf } from "../validation.js";

/**
 * The binding `validate` gate (issue #26, D41, D47): each of a ticket's
 * accepted acceptance criteria is judged against the recorded verification
 * evidence, one `validate` question per criterion, and the verdicts decide
 * the ticket's next state.
 *
 * - Any `not-met` returns the ticket to fix.
 * - Otherwise any `insufficient-evidence` asks for the ticket's checks not
 *   yet run; when none remain, `escalate` is asked at `missing-check`. A
 *   confident `proceed` returns the ticket to fix, to add the check the
 *   criterion lacks (D41: every ticket is testable); an ask waits on the
 *   developer. Escalate never turns a criterion into `met`.
 * - Only every criterion `met` admits the ticket to review.
 *
 * The packet carries one accepted criterion (read from the tickets record,
 * never from the caller) and the recorded evidence; evidence is only check
 * output or the implementer's claim, so no diff or repository content can go
 * out, and check output that is a diff is refused. A below-threshold answer
 * counts as `insufficient-evidence`, never as `met`. Evidence that is only
 * the implementer's claim is settled by rule without asking Jev.
 *
 * Only the progress record's `validations` entry is written. The fix counter
 * and the ticket's status belong to `implement` (#8); validation is the gate
 * into review, never a replacement for it (D9, D32).
 */

export const EVIDENCE_KINDS = ["check", "claim"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface VerificationEvidence {
  readonly kind: EvidenceKind;
  /** The command that produced a check's output, or who made the claim. */
  readonly source: string;
  readonly text: string;
  readonly exitCode?: number;
}

export interface ValidationInput {
  readonly ticketId: string;
  readonly evidence: readonly VerificationEvidence[];
  /** The ticket's checks the implementer can run; those absent from the evidence are still to run. */
  readonly checks: readonly string[];
}

export type TicketValidationResult =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "needs-configuration" | "failed"; readonly askHuman: EscalationAsk }
  | { readonly kind: "validated"; readonly validation: TicketValidation; readonly askHuman?: EscalationAsk };

type Refused = Extract<TicketValidationResult, { kind: "refused" }>;

function refused(reason: string): Refused {
  return { kind: "refused", reason };
}

/** Unified-diff markers; a diff is never verification evidence (D22, issue #26). */
const DIFF_MARKERS = /^(diff --git |@@ -\d+(,\d+)? \+\d+(,\d+)? @@|--- a\/|\+\+\+ b\/)/m;

/** The ticket from an accepted plan that validation may judge. */
function readTicket(root: string, ticketId: string): { readonly kind: "ticket"; readonly ticket: TicketRecord } | Refused {
  const plan = readRecord(root, "plan");
  if (plan.kind !== "present" || plan.record.status !== "accepted") {
    return refused("validation judges criteria accepted with the plan, and the plan is not accepted");
  }
  const tickets = readRecord(root, "tickets");
  if (tickets.kind !== "present") return refused("the tickets record cannot be read");
  const ticket = tickets.record.tickets.find((entry) => entry.id === ticketId);
  if (ticket === undefined) return refused(`no ticket "${ticketId}" in the accepted plan`);
  if (ticket.status !== "ready" && ticket.status !== "in-progress") {
    return refused(`ticket ${ticketId} is ${ticket.status}; only a ticket being worked on is validated`);
  }
  return { kind: "ticket", ticket };
}

/** Refuses drafted evidence that is not check output or the implementer's claim. */
export function refuseInvalidEvidence(input: ValidationInput): Refused | undefined {
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    return refused("validation needs recorded verification evidence: run the ticket's checks and record their output");
  }
  for (const [index, entry] of input.evidence.entries()) {
    if (!isOneOf(EVIDENCE_KINDS, entry?.kind)) {
      return refused(
        `evidence[${index}] is "${String(entry?.kind)}"; evidence is one of ${EVIDENCE_KINDS.join(", ")}, never a diff or repository content`,
      );
    }
    if (typeof entry.source !== "string" || entry.source.trim() === "" || typeof entry.text !== "string") {
      return refused(`evidence[${index}] needs a source and its text`);
    }
    if (DIFF_MARKERS.test(entry.text)) {
      return refused(`evidence[${index}] is a diff; record the check's output, never the diff or repository content`);
    }
  }
  if (input.checks !== undefined && !Array.isArray(input.checks)) return refused("checks must be a list of commands");
  return undefined;
}

/** One piece of evidence as a packet excerpt; a check's exit code leads its output. */
export function evidenceExcerpt(entry: VerificationEvidence): EvidenceExcerpt {
  return {
    source: `${entry.kind}: ${entry.source}`,
    text: entry.exitCode === undefined ? entry.text : `exit ${entry.exitCode}\n${entry.text}`,
  };
}

function criterionInput(ticket: TicketRecord, index: number, evidence: readonly VerificationEvidence[]): DecisionInput {
  return {
    taskSummary: `Ticket ${ticket.id} (${ticket.title}). Criterion ${index + 1}: ${ticket.acceptanceCriteria[index]}`,
    candidates: [],
    excerpts: evidence.map(evidenceExcerpt),
  };
}

/** A criterion's verdict from its envelope: a binding answer acts; anything else is insufficient evidence. */
function judgmentFrom(criterion: string, envelope: DecisionEnvelope): CriterionJudgment {
  const { answer } = envelope;
  const verdict = envelope.route === "act" && isOneOf(CRITERION_VERDICTS, answer.choice) ? answer.choice : undefined;
  const acted = verdict !== undefined;
  return {
    criterion,
    verdict: verdict ?? "insufficient-evidence",
    by: "jev",
    reasonCode: answer.reasonCode,
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    envelope: envelope.id,
    ...(acted ? {} : { note: `Jev answered ${answer.choice}, but ${envelope.routeReason}; treated as insufficient evidence` }),
  };
}

interface Settled {
  readonly validation: TicketValidation;
  readonly askHuman?: EscalationAsk;
}

/** Decides the ticket's next state from its verdicts, asking escalate when evidence is short and no check remains. */
async function settle(
  root: string,
  ticket: TicketRecord,
  criteria: readonly CriterionJudgment[],
  missingChecks: readonly string[],
  dependencies: DecisionDependencies,
): Promise<Settled> {
  const validatedAt = dependencies.now();
  const base = { criteria, missingChecks, validatedAt };
  if (criteria.some((entry) => entry.verdict === "not-met")) return { validation: { ...base, disposition: "returned-to-fix" } };

  const insufficient = criteria.filter((entry) => entry.verdict === "insufficient-evidence");
  if (insufficient.length === 0) return { validation: { ...base, disposition: "admitted-to-review" } };
  if (missingChecks.length > 0) return { validation: { ...base, disposition: "needs-check" } };

  const listed = insufficient.map((entry) => `"${entry.criterion}"`).join(", ");
  const escalation = await askEscalation(
    root,
    {
      kind: "missing-check",
      summary: `Ticket ${ticket.id} (${ticket.title}): the recorded evidence does not settle ${listed}, and none of the ticket's checks remain to run.`,
      excerpts: insufficient.map((entry, index) => ({
        source: `criteria[${index}]`,
        text: `${entry.criterion}: ${entry.verdict}${entry.reasonCode === undefined ? "" : ` (${entry.reasonCode})`}${entry.note === undefined ? "" : `; ${entry.note}`}`,
      })),
    },
    dependencies,
  );
  if (escalation.kind === "refused") {
    return {
      validation: { ...base, disposition: "awaiting-developer" },
      askHuman: humanAskAt("missing-check", `Ticket ${ticket.id} cannot be settled`, escalation.reason),
    };
  }
  const recorded = escalation.kind === "answered" ? { escalation: escalation.envelope } : {};
  if (escalation.askHuman === undefined) {
    // Proceed: the agent adds the missing check rather than asking.
    return { validation: { ...base, ...recorded, disposition: "returned-to-fix" } };
  }
  return { validation: { ...base, ...recorded, disposition: "awaiting-developer" }, askHuman: escalation.askHuman };
}

/** Records a ticket's validation in the progress record, the only record validation writes. */
export function saveValidation(root: string, ticketId: string, validation: TicketValidation): Refused | undefined {
  const read = readRecord(root, "progress");
  if (read.kind === "malformed") return refused(`the progress record at ${read.path} cannot be read`);
  const current = read.kind === "present" ? read.record : EMPTY_PROGRESS;
  const validated = validateRecord("progress", {
    ...current,
    validations: { ...current.validations, [ticketId]: validation },
  });
  if (!validated.ok) return refused(`the validation cannot be recorded: ${validated.issues.map((issue) => issue.path).join(", ")}`);
  writeRecord(root, "progress", validated.record);
  return undefined;
}

function settledResult(root: string, ticketId: string, settled: Settled): TicketValidationResult {
  return saveValidation(root, ticketId, settled.validation) ?? { kind: "validated", ...settled };
}

export async function validateTicket(
  root: string,
  input: ValidationInput,
  dependencies: DecisionDependencies,
): Promise<TicketValidationResult> {
  const read = readTicket(root, input.ticketId);
  if (read.kind === "refused") return read;
  const invalid = refuseInvalidEvidence(input);
  if (invalid) return invalid;
  const judged = await judgeTicket(root, read.ticket, input, dependencies);
  return judged.kind === "validated" ? (saveValidation(root, read.ticket.id, judged.validation) ?? judged) : judged;
}

/**
 * Judges `ticket`'s criteria, as given, against recorded evidence and
 * settles its next state, without recording it. `realign` re-validates a
 * completed ticket against its changed criteria through this (issue #31);
 * the evidence is what was recorded for it, and none at all is judged as
 * the implementer's claim alone.
 */
export async function judgeTicket(
  root: string,
  ticket: TicketRecord,
  input: Pick<ValidationInput, "evidence" | "checks">,
  dependencies: DecisionDependencies,
): Promise<TicketValidationResult> {
  const ran = new Set(input.evidence.filter((entry) => entry.kind === "check").map((entry) => entry.source.trim()));
  const missingChecks = (input.checks ?? []).map((check) => check.trim()).filter((check) => check !== "" && !ran.has(check));

  const criteria: CriterionJudgment[] = [];
  if (ran.size === 0) {
    for (const criterion of ticket.acceptanceCriteria) {
      criteria.push({
        criterion,
        verdict: "insufficient-evidence",
        by: "rule",
        note: "the only evidence is the implementer's claim",
      });
    }
  } else {
    for (const [index, criterion] of ticket.acceptanceCriteria.entries()) {
      const result = await askDecision(root, "validate", criterionInput(ticket, index, input.evidence), dependencies);
      if (result.kind === "refused") return result;
      if (result.kind === "needs-configuration" || result.kind === "failed") {
        const why = result.kind === "failed" ? `Jev could not be asked: ${result.failure.error}` : result.askHuman;
        // validate is binding and judges the agent's own work (D38, D47): without Jev its verdicts are the developer's.
        const next =
          result.kind === "failed" && result.fallback === "approved"
            ? "Continuing without Jev is approved, but validate is binding, so each criterion's verdict is yours (ticket override --by developer)."
            : "Continuing without Jev needs your approval.";
        return {
          kind: result.kind,
          askHuman: humanAskAt("continue-without-jev", `Ticket ${ticket.id} cannot be validated`, `${why} ${next}`),
        };
      }
      criteria.push(judgmentFrom(criterion, result.envelope));
    }
  }

  return { kind: "validated", ...(await settle(root, ticket, criteria, missingChecks, dependencies)) };
}

export interface CriterionOverride {
  readonly ticketId: string;
  /** Zero-based index into the ticket's accepted criteria. */
  readonly criterion: number;
  readonly verdict: CriterionVerdict;
  readonly by: Exclude<ChoiceMaker, "workflow">;
  readonly reason: string;
  readonly evidence?: readonly string[];
}

/**
 * Sets one criterion's Jev verdict aside and settles the ticket again. The
 * choice is recorded on the criterion's envelope, which demands an
 * evidence-based reason from an agent and the developer's words on a
 * below-threshold answer (D6); a rule's verdict has no envelope and cannot
 * be set aside here.
 */
export async function overrideCriterion(
  root: string,
  override: CriterionOverride,
  dependencies: DecisionDependencies,
): Promise<TicketValidationResult> {
  const read = readTicket(root, override.ticketId);
  if (read.kind === "refused") return read;
  const progress = readRecord(root, "progress");
  const current = progress.kind === "present" ? progress.record.validations?.[override.ticketId] : undefined;
  if (current === undefined) return refused(`ticket ${override.ticketId} has not been validated`);
  const judgment = current.criteria[override.criterion];
  if (judgment === undefined) return refused(`ticket ${override.ticketId} has no criterion ${override.criterion}`);
  if (judgment.envelope === undefined) {
    return refused(`criterion ${override.criterion} was settled by rule (${judgment.note}); record the missing check instead`);
  }
  if (!isOneOf(CRITERION_VERDICTS, override.verdict)) return refused(`the verdict is one of ${CRITERION_VERDICTS.join(", ")}`);
  const chosen = recordChoice(
    root,
    judgment.envelope,
    {
      action: override.verdict,
      by: override.by,
      reason: override.reason,
      ...(override.evidence === undefined ? {} : { evidence: override.evidence }),
    },
    CRITERION_VERDICTS,
    { now: dependencies.now() },
  );
  if (!chosen.ok) return refused(chosen.reason);

  const criteria = current.criteria.map((entry, index) =>
    index === override.criterion
      ? { ...entry, verdict: override.verdict, by: override.by, note: override.reason.trim() }
      : entry,
  );
  return settledResult(root, read.ticket.id, await settle(root, read.ticket, criteria, current.missingChecks, dependencies));
}
