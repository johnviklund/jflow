import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { claimChanges } from "./actions/changes.js";
import { decideConflict, raiseConflict, type ConflictDraft } from "./actions/conflicts.js";
import { dispatch, type DispatchOutcome, type HumanAskEvent } from "./actions/dispatch.js";
import { completeTicket } from "./actions/completion.js";
import { processCheckRunner, runCheck, runTicketChecks, type CheckOptions, type CheckRunner } from "./actions/checks.js";
import { checkTicket, startTicket, type CheckInput, type CheckResult } from "./actions/implement.js";
import { nextTicket, parkTicket, recordIndependence, type IndependenceInput } from "./actions/progression.js";
import { refuse, unreadable } from "./actions/refusal.js";
import { decideFinding, recordReview, startReview, type FindingInput, type ReviewInput } from "./actions/review.js";
import { decidePlanFinding, recordPlanReview, startPlanReview } from "./actions/plan-review.js";
import { decideLesson, proposeLesson, type LessonDraft } from "./actions/learn.js";
import { activeLessons, checkLesson, supersedeLesson } from "./actions/lesson-use.js";
import { promoteTodo, recordTodo, routeItem } from "./actions/todo.js";
import { classifyContent, type ClassifyInput, type ClassifyResult } from "./actions/classify.js";
import { wrapSession, type WrapDraft } from "./actions/wrap.js";
import { realignPlan, recommendRealign, type RealignDraft } from "./actions/realign.js";
import { readResume, reconcileResume, settleDiscrepancies, verifyTicket, type ReconcileDraft } from "./actions/resume.js";
import { assignWorker, finishWorker, type WorkerDraft } from "./actions/workers.js";
import { recommendModel, type SelectionDraft } from "./actions/model-selection.js";
import {
  applyDiagnosis,
  recordDiagnosis,
  startDiagnosis,
  type DiagnosisFinding,
  type DiagnosisStart,
} from "./actions/troubleshoot.js";
import { fetchTransport, type JevTransport } from "./jev/client.js";
import {
  adviseNext,
  askDecision,
  CHOICE_MAKERS,
  permittedChoices,
  readEnvelope,
  recordChoice,
  reportDecision,
  type ChoiceMaker,
  type DecisionDependencies,
  type JevDecisionEntry,
  type DecisionInput,
  type DecisionReport,
} from "./jev/decisions.js";
import { askEscalation, type Boundary } from "./jev/escalation.js";
import { replayDecision, type ReplayProposal } from "./jev/replay.js";
import { findPatterns, readObservations } from "./jev/observations.js";
import {
  acceptProposal,
  draftProposal,
  listProposals,
  readProposal,
  rejectProposal,
  replayProposal,
  type ProposalDependencies,
  type ProposalDraft,
} from "./jev/proposals.js";
import { assessWithoutJev, type AssessmentInput } from "./jev/assessment.js";
import { approveFallback } from "./jev/fallback.js";
import { sharingLimitsFrom } from "./jev/evidence.js";
import { overrideCriterion, validateTicket, type ValidationInput, type TicketValidationResult } from "./jev/ticket-validation.js";
import { cleanTraces, listTraces } from "./jev/traces.js";
import {
  acceptPlan,
  authorizeExecution,
  stagesRun,
  stagesWithoutModel,
  writeClassifiedPlan,
  type Authorization,
  type PlanDraft,
  type PlanResult,
} from "./actions/plan.js";
import type { ResolutionContext } from "./actions/resolve.js";
import {
  acceptSpecification,
  decideSpecification,
  writeSpecification,
  type SpecificationDraft,
} from "./actions/specification.js";
import {
  layerConfiguration,
  readJevKeyFile,
  resolveConfiguration,
  resolveJevApiKey,
  userConfigPath,
} from "./config/configuration.js";
import { readRecord, type CriterionVerdict, type RealignSource } from "./project/records.js";
import { checkHostCapabilities, processProbeOptions, type HostProbeOptions } from "./host/capabilities.js";
import { loadShippedWorkflowPackage } from "./workflow/package.js";
import { WorkflowPackageError, type DecisionAuthority, type WorkflowPackage } from "./workflow/types.js";

/**
 * The jflow helper's command line (D51, issue #4). The skill's instruction
 * files shell out to it; every command prints one JSON object on stdout so
 * the primary agent reads results, never parses prose. Exit codes: 0 the
 * command ran (including an eligible action the skill's method carries), 1 the
 * request needs the developer (blocked, ambiguous, unknown, invalid
 * configuration), 2 the project or package cannot be read.
 */

export const EXIT_OK = 0;
export const EXIT_NEEDS_HUMAN = 1;
export const EXIT_UNREADABLE = 2;

export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Host probes; defaults to the real process. Injected by tests. */
  readonly hostProbes?: HostProbeOptions;
  /** Where the Jev key is read from and how requests are sent; defaults to the process and the network. */
  readonly jev?: {
    readonly env: Readonly<Record<string, string | undefined>>;
    /** The user's key file; tests that inject `jev` leave it out, so none is read. */
    readonly readKeyFile?: () => string | undefined;
    readonly transport: JevTransport;
    /** Waits between retries; a real timer unless a test injects one. */
    readonly sleep?: (ms: number) => Promise<void>;
  };
  /** Runs a ticket's check commands; the real shell unless a test injects a script. */
  readonly checkRunner?: CheckRunner;
  /**
   * The developer's default configuration for every project
   * (`userConfigPath`), under the project's own. Only the real command line
   * sets it, so tests never read the developer's home folder.
   */
  readonly userConfigFile?: string;
  /** Told of each Jev decision asked while the command runs; `runCli` lists them in its output. */
  readonly onJevDecision?: (entry: JevDecisionEntry) => void;
  /** The package directory an accepted proposal writes; the shipped package unless a test injects a copy. */
  readonly packageDirectory?: string;
}

export const USAGE = `jflow helper

Usage:
  jflow status      [--root <dir>] [--config <file>]
  jflow next        [--root <dir>] [--config <file>]
  jflow run <request…> [--root <dir>] [--config <file>]
  jflow validate    [--config <file>]
  jflow check-host  [--root <dir>]
  jflow specification write <draft.json>            [--root <dir>]
  jflow specification confirm <decision> --basis <what the developer said> [--root <dir>]
  jflow specification reject  <decision> --basis <what the developer said> [--root <dir>]
  jflow specification accept  [--note <the developer's words>] [--root <dir>]
  jflow plan write <draft.json>                   [--root <dir>] [--config <file>]
  jflow plan accept [--note <words>] [--authorize plan|ticket --ticket <id>] [--root <dir>]
  jflow plan authorize --scope plan|ticket [--ticket <id>] --note <words> [--root <dir>]
  jflow changes claim [<path>…] --owner developer|ticket --note <words> [--root <dir>]
  jflow todo route <summary…> [--detail <context>] [--root <dir>] [--config <file>]
  jflow todo add <summary…> [--detail <context>] [--routing <envelope>
                    [--by agent|developer] [--reason <why>] [--evidence <what it rests on>]] [--root <dir>]
  jflow todo list                                [--root <dir>]
  jflow todo promote <id> --note <the developer's words> [--root <dir>]
  jflow learn propose <lesson.json>          [--stage <name>] [--root <dir>] [--config <file>]
  jflow learn decide <id> --outcome retained|candidate --by agent|developer
                    [--reason <why>] [--evidence <what it rests on>] [--assessment <A-n>] [--root <dir>]
  jflow learn list                           [--root <dir>]
  jflow learn active                         [--root <dir>]
  jflow learn check <id> --task <the task> --outcome applies|skipped --reason <why>
                    [--evidence <what it rests on>] [--root <dir>]
  jflow learn supersede <id> --successor <lesson id or change> --evidence <what contradicts it>
                    --by agent|developer [--reason <the developer's words>] [--conflicts-with <decision id>]
                    [--task <the task>] [--stage <name>] [--root <dir>] [--config <file>]
  jflow resume                               [--root <dir>] [--config <file>]
  jflow resume verify <evidence.json>        [--root <dir>] [--config <file>]
  jflow resume reconcile [<draft.json>]      [--root <dir>] [--config <file>]
  jflow resume settle --note <the developer's words> [--root <dir>]
  jflow realign <draft.json> --note <the developer's words> [--root <dir>] [--config <file>]
  jflow realign recommend --source resume|review|agent --summary <why> [--evidence <what it rests on>] [--root <dir>]
  jflow realign show                         [--root <dir>]
  jflow wrap <draft.json>                    [--root <dir>] [--config <file>]
  jflow wrap show                            [--root <dir>]
  jflow decide ask <decision> <input.json>   [--root <dir>] [--config <file>]
  jflow decide show <envelope>               [--root <dir>]
  jflow decide choose <envelope> --action <a> --by workflow|agent|developer
                    [--reason <why>] [--evidence <what it rests on>] [--root <dir>]
  jflow replay <decision> [--question <question.json>] [--threshold <0-1> [--kind <kind>]]
                    [--authority binding|advisory] [--root <dir>] [--config <file>]
  jflow proposal observations                [--root <dir>] [--config <file>]
  jflow proposal patterns                    [--root <dir>] [--config <file>]
  jflow proposal draft <proposal.json>       [--root <dir>] [--config <file>]
  jflow proposal replay <id>                 [--root <dir>] [--config <file>]
  jflow proposal accept <id> --note <the developer's words> [--root <dir>]
  jflow proposal reject <id> --note <the developer's words> [--root <dir>]
  jflow proposal list                        [--root <dir>]
  jflow proposal show <id>                   [--root <dir>]
  jflow escalate <boundary.json>             [--stage <name>] [--root <dir>] [--config <file>]
  jflow implement start [<ticket>]           [--root <dir>] [--config <file>]
  jflow implement check <evidence.json>      [--root <dir>] [--config <file>]
  jflow implement complete [<ticket>]        [--root <dir>] [--config <file>]
  jflow implement fix <diagnosis> [--note <what was changed>] [--root <dir>]
  jflow implement next [--escalation <env>]  [--root <dir>] [--config <file>]
  jflow implement park <ticket> --blocker <what blocks it> [--root <dir>]
  jflow implement independence <check.json>  [--root <dir>]
  jflow troubleshoot start <failure.json>    [--root <dir>] [--config <file>]
  jflow troubleshoot record <diagnosis.json> [--root <dir>]
  jflow review start                         [--root <dir>] [--config <file>]
  jflow review record <review.json>          [--root <dir>] [--config <file>]
  jflow review decide <ticket> --finding <id> --outcome upheld|withdrawn --note <the developer's words>
                    [--recommendation <next step>] [--root <dir>] [--config <file>]
  jflow review plan start                    [--root <dir>] [--config <file>]
  jflow review plan record <review.json>     [--root <dir>] [--config <file>]
  jflow review plan decide --finding <id> --outcome upheld|withdrawn --note <the developer's words>
                    [--root <dir>] [--config <file>]
  jflow worker recommend <draft.json>        [--root <dir>] [--config <file>]
  jflow worker assign <assignment.json>      [--root <dir>] [--config <file>]
  jflow worker finish <id>                   [--root <dir>]
  jflow ticket validate <evidence.json>      [--root <dir>] [--config <file>]
  jflow ticket override <id> --criterion <n> --verdict met|not-met|insufficient-evidence
                    --by agent|developer --reason <why> [--evidence <what it rests on>] [--root <dir>]
  jflow conflict raise <draft.json>          [--root <dir>]
  jflow conflict decide <id> --note <the developer's words> [--root <dir>]
  jflow jev approve --scope ticket|stage|plan [--stage <name>] --note <the developer's words> [--root <dir>]
  jflow jev assess <assessment.json>         [--stage <name>] [--root <dir>]
  jflow traces list  [--root <dir>]
  jflow traces clean [--root <dir>]
  jflow help

Every command prints one JSON object, with jevDecisions listing each Jev
decision it asked (answer, confidence, threshold, route, envelope, or why Jev
could not be asked). <request> is an action name or a
sentence; an ambiguous request returns a question rather than a guess.
A specification draft holds title, problem, scenarios, acceptanceCriteria,
constraints, exclusions and decisions (id, statement, basis); every
decision is recorded as a proposal until the developer confirms it.
A plan draft holds title, summary, source and tickets (id, title,
acceptanceCriteria, dependsOn); a ticket without criteria is refused.
"plan write" asks classify (testability) for every criterion first and
records each answer on its ticket. A criterion classed untestable with
confidence stops the write until it is rewritten, or set aside in
testabilityOverrides (ticketId, criterion from 0, reason, evidence).
"plan accept" alone accepts without authorizing; add --authorize when the
developer's instruction also authorized execution.
"changes claim" records who owns uncommitted changes jflow found and asked
about: the developer (left out of the ticket) or the assigned ticket. With
no paths it covers every unclaimed change. It never stages or discards.
"todo route" asks Jev's advisory classify (item-routing) whether an item
found mid-work is a todo or in scope for the assigned ticket, and writes
no record. "todo add --routing <envelope>" records the item with that
answer and the choice todo on its envelope; against in-scope it needs
--reason and --evidence. Keeping the item in scope is "decide choose
<envelope> --action in-scope".
"todo add" records future work outside the plan and authorizes nothing;
"todo promote" records the developer's decision to bring an item into the
plan, and says whether plan or realign adds its ticket.
"learn propose" records a candidate project lesson (statement, scope,
evidence links of kind and reference, and the ids of accepted decisions or
retained lessons it touches or conflictsWith) and asks Jev's advisory
lesson-retention decision. A conflict asks escalate at lesson-conflict;
the decision it conflicts with is never changed. "learn decide" records
retaining it or keeping it a candidate beside Jev's answer: setting the
answer aside needs --reason and --evidence, and where the answer is not
relied on, retaining needs the developer or your jev assess record. A
lesson scoped to the workflow, its Jev questions or its policy is refused.
"learn active" lists the lessons that may be used: retained ones only.
"learn check" records re-checking one against the task before each use:
it applies, or it is skipped with the reason. A superseded lesson or a
candidate is refused. "learn supersede" marks a contradicted lesson
superseded with the evidence and keeps it as history. Where that would
change a human decision (a lesson the developer retained, or an accepted
decision it touches) the agent's supersession asks escalate at
lesson-conflict instead. On proceed a lesson the developer retained stays
as they decided (only --by developer then supersedes it), and one that
only touches an accepted decision is superseded. An option given twice
keeps its last value.
"wrap" writes jflow/resume.json from a draft holding summary, nextSteps
and discrepancies (summary, ticketId) the agent found, plus what the
records say: the plan and its authorization, ticket outcomes, parked
tickets and blockers, open todos, lesson state and next's
recommendation. Where the records and the repository disagree it reports
the discrepancy (exit 1) and reconciles nothing. It writes no other
record and never commits, pushes, merges, publishes or cleans up.
"wrap show" prints the resume record.
"next" also asks Jev's advisory next-action decision and reports it under
"jev" with its envelope; a missing key is reported there, never skipped.
"decide ask classify" takes kind (item-routing, testability or
lesson-scope), summary, excerpts and, for lesson-scope, scopes; any other
kind, a review finding included, is refused and recorded as a trace.
"decide ask" asks a declared Jev decision over an input holding taskSummary,
candidates and excerpts (source, text); the answer's route says whether the
workflow acts on it, you weigh it, or the developer decides. "decide
choose" records the chosen action: it must be permitted by the workflow,
and setting Jev's answer aside needs --reason and --evidence.
"replay" tests a proposed question file, confidence threshold and/or
authority for one declared decision against its stored envelopes. A
question is re-asked over each stored packet; a threshold or authority
alone re-routes the stored answers without asking Jev. --kind scopes a
threshold to one boundary kind of escalate or content kind of classify,
and replays only the envelopes asked there. It reports how many answers, routes and reason codes
would change and in which direction, by boundary kind and by reason code,
each change linked to its envelope.
It writes only traces: no envelope, record, question or policy file, and
it decides nothing. A decision with no stored envelopes is reported as
nothing to replay (exit 1).
"resume" reconciles a fresh session with the records, the working tree and
the resume record, and writes nothing. It reports the authorization from
the progress record alone, the ticket to continue with its uncommitted
edits, done tickets without verification evidence (unverified), the
affected tickets, the discrepancies, and the previous recommendation
beside the current one. "resume verify" judges a done ticket on checks run
now (the evidence file of "ticket validate") and records the result; it
never changes the ticket's status. "resume reconcile" asks escalate at
resume-discrepancy for every discrepancy, the draft's (summary, ticketId,
evidence, changesScope) included; a scope change asks the developer
without Jev and records a realign recommendation. It refuses while a done
ticket is unverified, puts a discrepancy already waiting on the developer
to them again without Jev, exits 1 when the developer is asked, and
reconciles nothing itself. "resume settle" records the developer's
decision on the waiting discrepancies so they are not raised again.
"realign" is the developer's to invoke: --note records their instruction.
Its draft holds direction, changes (action rescope with ticketId and any of
title, acceptanceCriteria, dependsOn; add with ticketId, title,
acceptanceCriteria, dependsOn; park or withdraw with ticketId and reason),
and optionally specification (a revised draft), plan (title, summary) and
recommendations (ids it addresses). Unchanged tickets stay as they are. A
done ticket whose criteria changed is re-validated over its recorded
evidence. The specification
and plan both await acceptance again, and the execution authorization
ends. It exits 1 when a re-validation cannot run (nothing is written) or
waits on the developer. New and changed criteria are classified for
testability as in "plan write" (testabilityOverrides sets one aside). A
done ticket whose criteria changed is reopened for review either way.
"realign recommend" records a recommendation and starts nothing.
"proposal observations" lists the harness observations: low-confidence
answers, overrides, escalations, calls Jev did not answer and tickets at
the fix limit, read from the stored envelopes, traces and progress record,
unfiltered and never stored. "proposal patterns" groups the ones that
recur by kind, decision, place and reason code, with the changes each
points at. "proposal draft" takes decision, change (kind question with
question, kind threshold with threshold and optional for, or kind
authority with authority), observations (ids, at least one), lessons
(retained lesson ids, optional) and rationale. It replays the change and
records the proposal; nothing else changes. Without a Jev key a wording is
recorded without a report and exits 1: "proposal replay" it later.
"proposal accept" applies the change in the developer's words and bumps
the decision's version; it refuses without a report that replayed
something, or once the decision changed since. "proposal reject" records
the developer's no and changes nothing.
"implement start" starts one ticket under recorded execution
authorization: the authorized ticket, or under whole-plan authorization
the one named. It refuses while another ticket is in progress and reports
the delegation limits and the fix counter. "implement check" takes the
same evidence file as "ticket validate" plus an optional recommendation,
runs its checks, records their output with the claims under
.jflow/evidence, asks validate, and counts a not-met on
the ticket's one fix counter; at the limit it asks escalate, and an
attempt that could reach the limit needs the recommendation. Its
"workers" lists the sub-agents that worked on the ticket. It never
commits or marks the ticket done. "implement complete" does, once the
ticket passed validate and review: it records the ticket done and, unless
commitOnSuccess is off, makes one local commit of the ticket's changes and
the project records, leaving out changes the developer kept or another
ticket adopted. It never pushes, publishes or merges. "implement fix"
records that the ticket in progress applied a diagnosis's recommended fix,
under recorded execution authorization.
"implement next" picks the next eligible ticket in plan order. Under
whole-plan authorization it asks escalate at next-ticket and starts the
ticket on proceed, except the first start after the developer authorized,
which their authorization covers; otherwise it asks the developer without Jev. After the
developer's proceed is recorded on that ask's envelope (decide choose),
"--escalation <env>" starts the ticket on it without asking Jev again. It returns
needs-independence-check while a parked ticket has not been checked
against, and waiting, with the reasons, when nothing can proceed.
"implement park" parks the ticket in progress with its blocker and keeps
its uncommitted changes as its partial edits; it never marks it done or
changes authorization. "implement independence" records why a ready
ticket may start beside the parked ones: ticketId, dependencies,
decisions and partialEdits.
"troubleshoot start" takes ticketId (default: the ticket in progress) and
the failed check's command (check.source), runs it, and records its output
and exit code with a snapshot of the working tree; output in the file is
refused, and so is a check that passes when jflow runs it. "troubleshoot record" takes id, finding, evidence and
recommendation. It is refused if the working tree changed meanwhile:
troubleshoot never edits code.
"review start" opens review of the assigned ticket once validate found
every criterion met, and returns the reviewer's context, the review model
and the agents that may not review. "review record" takes ticketId,
reviewer (agent, model) and findings (kind requirement, correctness,
standard or improvement; summary; evidence; optional dispute with reason,
evidence, touches and conclusive), plus a recommendation when a blocking
finding could reach the fix limit. A blocking finding returns the ticket
to fix and through validate again; an improvement becomes a todo; a
dispute is settled by evidence, asked of escalate, or, when it touches
requirements, scope, workflow rules or permissions, put to the developer.
"review decide" records the developer's decision on a disputed finding.
"review plan" is the integrated review of a multi-ticket plan once every
ticket is done or withdrawn: "start" returns every ticket, the plan's
acceptance criteria and the agents that may not review; "record" takes
reviewer and findings under the same rule; "decide" settles a disputed
finding. A blocking finding holds the plan, and the developer decides the
new work. A one-ticket plan's ticket review covers the plan.
"worker assign" records a stage worker before it runs: stage, role (one
the stage declares), agent, model and ticketId. The model must be the
stage's configured one; when that is unavailable, add unavailable (model,
reason) and run only the configured fallback. With no model or no
fallback configured it asks and records nothing. It refuses the primary
agent and more workers than the stage allows at once. Where the stage
configures efforts, effort (one of them) is required. "worker finish"
frees the place.
"worker recommend" asks Jev's advisory model-selection decision over
stage, role, ticketId, task and optional unavailable. The options are the
model the stage may run now at each configured effort. It returns the
recommended model and effort, no-recommendation, single-option (nothing
to choose, Jev not asked) or rejected: an answer outside the options,
recorded in the workers record, on which no worker starts. Pass the
envelope to "worker assign" as selection (envelope, and by, reason and
evidence when setting it aside) to record following or overriding it.
"ticket validate" runs every command in checks in the project, records its
output and exit code, and asks the binding validate decision once per
accepted criterion over that output and the evidence file's claims (kind
claim, source, text); check output written into the file is refused. Each
check stops at the checks.timeoutMs setting. The validation's disposition
is returned-to-fix, admitted-to-review, needs-check (add missingChecks) or
awaiting-developer; it exits 1 only with "askHuman". "ticket override" sets
one criterion's verdict aside (--criterion is zero-based) and settles the
ticket again; an agent needs --reason and --evidence.
"escalate" asks the binding escalate decision at a human-facing boundary
over kind, summary and excerpts. It exits 0 with "ask": false when the
work proceeds, and 1 with "askHuman" when the developer must be asked. The
hard rules (consequential-conflict, continue-without-jev,
specification-acceptance, plan-acceptance) always ask and never reach Jev.
"conflict raise" takes summary, touches (requirements, scope,
workflow-rules, permissions) and, for a technical disagreement,
investigation (finding, evidence, conclusive); a consequential or
inconclusive one waits for the developer and never reaches Jev.
A Jev call that fails temporarily is retried jev.retryCount times with
growing backoff; an authentication or invalid-request error is not.
Once it cannot be answered, continuing without Jev waits for the
developer: "jev approve" records their approval for the ticket in
progress, a named stage, or, only when they broaden it, the whole plan.
The implement, ticket and review commands ask as their own stage; pass
--stage to decide ask and escalate so a stage approval applies there.
Without a usable answer a binding decision (escalate, validate) is the
developer's, approval or not. "jev assess"
records your own evidence assessment where Jev's answer was uncertain
(envelope) or missing (traceReference): decision, assessment, evidence,
resolution and consequential. A consequential case, or a binding decision
below its threshold, goes to the developer. "status" shows the fallback.
"traces clean" deletes the local Jev traces under .jflow/traces; run it only
when the developer asks. Project records keep their summaries.
`;

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string>>;
}

const KNOWN_OPTIONS = [
  "root",
  "config",
  "basis",
  "note",
  "authorize",
  "scope",
  "ticket",
  "owner",
  "detail",
  "action",
  "by",
  "reason",
  "evidence",
  "criterion",
  "verdict",
  "finding",
  "outcome",
  "recommendation",
  "blocker",
  "stage",
  "assessment",
  "task",
  "successor",
  "conflicts-with",
  "question",
  "threshold",
  "routing",
  "kind",
  "authority",
  "escalation",
  "source",
  "summary",
];

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!KNOWN_OPTIONS.includes(name)) {
        throw new Error(`unknown option ${arg}; options are ${KNOWN_OPTIONS.map((o) => `--${o}`).join(", ")}`);
      }
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`option ${arg} needs a value`);
      }
      options[name] = value;
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, options };
}

type ContextResult =
  | { readonly ok: true; readonly context: ResolutionContext }
  | { readonly ok: false; readonly exit: number; readonly output: unknown };

type DraftRead<T> =
  | { readonly ok: true; readonly draft: T }
  | { readonly ok: false; readonly exit: number };

/** Reads a draft JSON file the skill wrote; the record validators judge its shape. */
function readDraft<T>(target: string | undefined, what: string, io: CliIo): DraftRead<T> {
  if (target === undefined) {
    io.stderr(`${what} needs the path of a draft JSON file\n${USAGE}`);
    return { ok: false, exit: EXIT_NEEDS_HUMAN };
  }
  try {
    return { ok: true, draft: JSON.parse(readFileSync(resolvePath(io.cwd, target), "utf8")) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stdout(`${JSON.stringify({ ok: false, reason: `cannot read the draft: ${message}` }, null, 2)}\n`);
    return { ok: false, exit: EXIT_UNREADABLE };
  }
}

/** Where a project keeps its configuration when no `--config` names another file. */
const PROJECT_CONFIG = join("jflow", "config.json");

/** A JSON file's contents, or undefined when there is no file. */
function readJsonIfPresent(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

/** The developer's defaults (when the command line has them) with the project's configuration over them. */
function readConfigurationDocument(path: string | undefined, cwd: string, root: string, userConfigFile: string | undefined): unknown {
  const project = path !== undefined ? JSON.parse(readFileSync(resolvePath(cwd, path), "utf8")) : readJsonIfPresent(join(root, PROJECT_CONFIG));
  const defaults = userConfigFile === undefined ? undefined : readJsonIfPresent(userConfigFile);
  return layerConfiguration(defaults, project) ?? {};
}

function buildContext(options: ParsedArgs["options"], io: CliIo): ContextResult {
  let workflowPackage: WorkflowPackage;
  try {
    workflowPackage = loadShippedWorkflowPackage();
  } catch (error) {
    if (error instanceof WorkflowPackageError) {
      return { ok: false, exit: EXIT_UNREADABLE, output: { ok: false, package: error.issues } };
    }
    throw error;
  }

  let document: unknown;
  try {
    document = readConfigurationDocument(options["config"], io.cwd, resolvePath(io.cwd, options["root"] ?? "."), io.userConfigFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exit: EXIT_UNREADABLE,
      output: { ok: false, configuration: [{ path: "", message: `cannot read configuration: ${message}` }] },
    };
  }

  const configuration = resolveConfiguration(document, workflowPackage);
  if (!configuration.ok) {
    return { ok: false, exit: EXIT_NEEDS_HUMAN, output: { ok: false, configuration: configuration.issues } };
  }
  return { ok: true, context: { workflowPackage, configuration: configuration.configuration } };
}

function exitCodeFor(outcome: DispatchOutcome): number {
  switch (outcome.kind) {
    case "completed":
    case "ready":
      return EXIT_OK;
    case "blocked":
    case "clarify":
    case "unknown-action":
      return EXIT_NEEDS_HUMAN;
    case "malformed-record":
      return EXIT_UNREADABLE;
  }
}

function decisionDependencies(context: ResolutionContext, io: CliIo, stage?: string): DecisionDependencies {
  const jev = io.jev ?? {
    env: process.env,
    readKeyFile: () => readJevKeyFile(process.env),
    transport: fetchTransport,
  };
  return {
    context,
    apiKey: resolveJevApiKey({
      env: jev.env,
      ...(jev.readKeyFile === undefined ? {} : { readKeyFile: jev.readKeyFile }),
    }),
    transport: jev.transport,
    now: () => new Date().toISOString(),
    ...(jev.sleep === undefined ? {} : { sleep: jev.sleep }),
    ...(io.onJevDecision === undefined ? {} : { onDecision: io.onJevDecision }),
    ...(stage === undefined ? {} : { stage }),
  };
}

async function runRequest(request: string, options: ParsedArgs["options"], io: CliIo): Promise<number> {
  const built = buildContext(options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const root = resolvePath(io.cwd, options["root"] ?? ".");
  const humanAsks: HumanAskEvent[] = [];
  const outcome = dispatch(root, request, built.context, {
    onHumanAsk: (event) => humanAsks.push(event),
  });
  // `next` also carries Jev's advisory next-action answer (issue #17);
  // the records' own recommendation above is unchanged by it.
  const jev =
    outcome.kind === "completed" && outcome.action === "next"
      ? (await adviseNext(root, decisionDependencies(built.context, io))).jev
      : undefined;
  io.stdout(`${JSON.stringify(jev === undefined ? { request, outcome, humanAsks } : { request, outcome, humanAsks, jev }, null, 2)}\n`);
  return exitCodeFor(outcome);
}

/** A classify answer the agent may weigh; one below its threshold, or none, is the developer's to see. */
function classifiedForAgent(result: ClassifyResult): boolean {
  return result.ok && result.outcome.kind === "answered" && result.outcome.route !== "ask-human";
}

/** A decision that could not be asked waits on the developer: a missing key, or a failure awaiting approval. */
function decisionWaits(decision: DecisionReport): boolean {
  return decision.kind === "needs-configuration" || (decision.kind === "failed" && decision.fallback === "awaiting-approval");
}

/** Prints a helper result; a refusal needs the developer. */
function report<T extends { readonly ok: boolean }>(result: T, io: CliIo): number {
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

function runSpecification(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;

  switch (subcommand) {
    case "write": {
      const read = readDraft<SpecificationDraft>(target, "specification write", io);
      if (!read.ok) return read.exit;
      return report(
        writeSpecification(root, read.draft, { now: new Date().toISOString() }),
        io,
      );
    }
    case "confirm":
    case "reject": {
      if (target === undefined) {
        io.stderr(`specification ${subcommand} needs a decision id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const status = subcommand === "confirm" ? "confirmed" : "rejected";
      return report(
        decideSpecification(root, target, status, { basis: args.options["basis"] ?? "" }),
        io,
      );
    }
    case "accept": {
      const note = args.options["note"];
      const now = new Date().toISOString();
      return report(
        acceptSpecification(root, note === undefined ? { now } : { now, note }),
        io,
      );
    }
    default:
      io.stderr(`specification needs one of write, confirm, reject, accept\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

type AuthorizationParse =
  | { readonly ok: true; readonly authorization: Authorization | undefined }
  | { readonly ok: false; readonly message: string };

/** An authorization needs a scope and the developer's words; a ticket id is optional here. */
function parseAuthorization(
  scope: string | undefined,
  ticket: string | undefined,
  note: string | undefined,
): AuthorizationParse {
  if (scope === undefined) return { ok: true, authorization: undefined };
  if (scope !== "plan" && scope !== "ticket") {
    return { ok: false, message: `authorization scope must be plan or ticket, not "${scope}"` };
  }
  if (note === undefined || note.trim() === "") {
    return { ok: false, message: "authorization is recorded in the developer's words; pass --note" };
  }
  return {
    ok: true,
    authorization: { scope, note, ...(ticket === undefined ? {} : { ticketId: ticket }) },
  };
}

async function runPlan(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const note = args.options["note"];

  switch (subcommand) {
    case "write": {
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const read = readDraft<PlanDraft>(target, "plan write", io);
      if (!read.ok) return read.exit;
      return report(await writeClassifiedPlan(root, read.draft, decisionDependencies(built.context, io, "plan")), io);
    }
    case "accept": {
      const parsed = parseAuthorization(args.options["authorize"], args.options["ticket"], note);
      if (!parsed.ok) {
        io.stderr(`${parsed.message}\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const accepted = acceptPlan(root, {
        now: new Date().toISOString(),
        ...(note === undefined ? {} : { note }),
        ...(parsed.authorization === undefined ? {} : { authorize: parsed.authorization }),
      });
      return parsed.authorization === undefined ? report(accepted, io) : reportAuthorization(accepted, parsed.authorization, args, io);
    }
    case "authorize": {
      const parsed = parseAuthorization(args.options["scope"], args.options["ticket"], note);
      if (!parsed.ok || parsed.authorization === undefined) {
        io.stderr(`${parsed.ok ? "plan authorize needs --scope plan|ticket" : parsed.message}\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return reportAuthorization(authorizeExecution(root, parsed.authorization), parsed.authorization, args, io);
    }
    default:
      io.stderr(`plan needs one of write, accept, authorize\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

/**
 * Reports a recorded authorization and, when a stage it will run sub-agents
 * in has no model configured, asks the developer for them before anything
 * starts, rather than at the first sub-agent.
 */
function reportAuthorization(result: PlanResult, authorization: Authorization, args: ParsedArgs, io: CliIo): number {
  if (!result.ok) return report(result, io);
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const missing = stagesWithoutModel(built.context, authorization.scope);
  // The models the authorized work will use, so the developer can override one for this plan.
  const stageModels = Object.fromEntries(
    stagesRun(built.context, authorization.scope).flatMap((stage) => {
      const configured = built.context.configuration.stageModels[stage];
      return configured === undefined ? [] : [[stage, configured]];
    }),
  );
  if (missing.length === 0) return report({ ...result, stageModels }, io);
  const askHuman: HumanAskEvent = {
    kind: "human-ask",
    reasons: [
      `Execution is authorized, but no model is configured for ${missing.join(" and ")}. ` +
        `Which model should each use? Record them under stageModels in ${PROJECT_CONFIG} for this project, ` +
        `or in ${io.userConfigFile ?? "your jflow config.json beside the Jev key file"} as your defaults for every project, before implementation starts.`,
    ],
  };
  io.stdout(`${JSON.stringify({ ...result, stageModels, missingStageModels: missing, askHuman }, null, 2)}\n`);
  return EXIT_NEEDS_HUMAN;
}

function runChanges(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, ...paths] = args.positional;
  if (subcommand !== "claim") {
    io.stderr(`changes needs claim\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const owner = args.options["owner"];
  if (owner !== "developer" && owner !== "ticket") {
    io.stderr(`changes claim needs --owner developer|ticket\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const result = claimChanges(root, {
    owner,
    note: args.options["note"] ?? "",
    ...(paths.length === 0 ? {} : { paths }),
  });
  return report(result, io);
}

async function runTodo(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, ...rest] = args.positional;

  switch (subcommand) {
    case "route": {
      const summary = rest.join(" ").trim();
      if (summary === "") {
        io.stderr(`todo route needs a summary of the item\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const detail = args.options["detail"];
      const result = await routeItem(
        root,
        detail === undefined ? { summary } : { summary, detail },
        decisionDependencies(built.context, io, args.options["stage"]),
      );
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return classifiedForAgent(result) ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    case "add": {
      const summary = rest.join(" ").trim();
      if (summary === "") {
        io.stderr(`todo add needs a summary of the item\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const { detail, routing, by, reason, evidence } = args.options;
      if (by !== undefined && by !== "agent" && by !== "developer") {
        io.stderr(`todo add --by is agent or developer\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(
        recordTodo(
          root,
          {
            summary,
            ...(detail === undefined ? {} : { detail }),
            ...(routing === undefined
              ? {}
              : {
                  routing: {
                    envelope: routing,
                    ...(by === undefined ? {} : { by }),
                    ...(reason === undefined ? {} : { reason }),
                    ...(evidence === undefined ? {} : { evidence: [evidence] }),
                  },
                }),
          },
          { now: new Date().toISOString() },
        ),
        io,
      );
    }
    case "list": {
      const read = readRecord(root, "todos");
      if (read.kind === "malformed") {
        io.stdout(`${JSON.stringify(unreadable("todos", read), null, 2)}\n`);
        return EXIT_UNREADABLE;
      }
      const todos = read.kind === "present" ? read.record : { items: [] };
      return report({ ok: true, todos }, io);
    }
    case "promote": {
      const [id] = rest;
      if (id === undefined) {
        io.stderr(`todo promote needs a todo id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(promoteTodo(root, id, { note: args.options["note"] ?? "", now: new Date().toISOString() }), io);
    }
    default:
      io.stderr(`todo needs one of add, list, promote\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

async function runDecide(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target, inputPath] = args.positional;

  switch (subcommand) {
    case "ask": {
      if (target === undefined) {
        io.stderr(`decide ask needs a decision name\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      if (target === "classify") {
        // classify goes through its content kinds; a review finding, or any other kind, is refused and recorded.
        const input = readDraft<ClassifyInput>(inputPath, "decide ask classify", io);
        if (!input.ok) return input.exit;
        const classified = await classifyContent(root, input.draft, decisionDependencies(built.context, io, args.options["stage"]));
        io.stdout(`${JSON.stringify(classified, null, 2)}\n`);
        return classifiedForAgent(classified) ? EXIT_OK : EXIT_NEEDS_HUMAN;
      }
      const read = readDraft<DecisionInput>(inputPath, "decide ask", io);
      if (!read.ok) return read.exit;
      const result = await askDecision(root, target, read.draft, decisionDependencies(built.context, io, args.options["stage"]));
      const decision = reportDecision(result);
      io.stdout(`${JSON.stringify({ ok: result.kind === "answered", decision }, null, 2)}\n`);
      return result.kind === "answered" ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    case "show": {
      if (target === undefined) {
        io.stderr(`decide show needs an envelope id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(readEnvelope(root, target), io);
    }
    case "choose": {
      const action = args.options["action"];
      const by = args.options["by"] as ChoiceMaker | undefined;
      if (target === undefined || action === undefined || by === undefined || !CHOICE_MAKERS.includes(by as ChoiceMaker)) {
        io.stderr(`decide choose needs an envelope id, --action and --by workflow|agent|developer\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const envelope = readEnvelope(root, target);
      if (!envelope.ok) return report(envelope, io);
      const reason = args.options["reason"];
      const evidence = args.options["evidence"];
      return report(
        recordChoice(
          root,
          target,
          {
            action,
            by,
            ...(reason === undefined ? {} : { reason }),
            ...(evidence === undefined ? {} : { evidence: [evidence] }),
          },
          permittedChoices(root, envelope.envelope.decision, built.context),
          { now: new Date().toISOString() },
        ),
        io,
      );
    }
    default:
      io.stderr(`decide needs one of ask, show, choose\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

/** How the helper runs checks here: the project root, the configured time limit, the evidence limit and the Jev key to blank. */
function checkOptions(root: string, dependencies: DecisionDependencies, io: CliIo): CheckOptions {
  const { configuration } = dependencies.context;
  return {
    runner: io.checkRunner ?? processCheckRunner(process.env),
    cwd: root,
    // resolveConfiguration fills in the package default.
    timeoutMs: configuration.settings["checks.timeoutMs"] as number,
    maxChars: sharingLimitsFrom(configuration).maxPacketChars,
    knownSecrets: dependencies.apiKey.status === "configured" ? [dependencies.apiKey.key] : [],
  };
}

/**
 * Runs the checks an evidence draft names and returns the draft with their
 * output (issue #32), or reports the refusal and returns its exit code.
 */
function withCheckOutput<T extends ValidationInput>(
  draft: T,
  root: string,
  dependencies: DecisionDependencies,
  io: CliIo,
): { readonly ok: true; readonly draft: T } | { readonly ok: false; readonly exit: number } {
  const checked = runTicketChecks(draft, checkOptions(root, dependencies, io));
  if (!checked.ok) {
    io.stdout(`${JSON.stringify({ ok: false, kind: "refused", reason: checked.reason }, null, 2)}\n`);
    return { ok: false, exit: EXIT_NEEDS_HUMAN };
  }
  return { ok: true, draft: checked.input as T };
}

function reportValidation(result: TicketValidationResult | CheckResult, io: CliIo): number {
  const ok = result.kind === "validated";
  io.stdout(`${JSON.stringify({ ok, ...result }, null, 2)}\n`);
  return ok && result.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

async function runTicket(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  if (subcommand !== "validate" && subcommand !== "override") {
    io.stderr(`ticket needs one of validate, override\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const dependencies = decisionDependencies(built.context, io, "implement");
  if (subcommand === "validate") {
    const read = readDraft<ValidationInput>(target, "ticket validate", io);
    if (!read.ok) return read.exit;
    const checked = withCheckOutput(read.draft, root, dependencies, io);
    if (!checked.ok) return checked.exit;
    return reportValidation(await validateTicket(root, checked.draft, dependencies), io);
  }

  const { criterion, verdict, by, reason, evidence } = args.options;
  if (
    target === undefined ||
    criterion === undefined ||
    !/^\d+$/.test(criterion) ||
    verdict === undefined ||
    (by !== "agent" && by !== "developer")
  ) {
    io.stderr(`ticket override needs a ticket id, --criterion <n>, --verdict and --by agent|developer\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  return reportValidation(
    await overrideCriterion(
      root,
      {
        ticketId: target,
        criterion: Number(criterion),
        // overrideCriterion refuses a verdict outside the closed set.
        verdict: verdict as CriterionVerdict,
        by,
        reason: reason ?? "",
        ...(evidence === undefined ? {} : { evidence: [evidence] }),
      },
      dependencies,
    ),
    io,
  );
}

async function runImplement(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  if (subcommand === "park") {
    const blocker = args.options["blocker"];
    if (target === undefined || blocker === undefined) {
      io.stderr(`implement park needs a ticket id and --blocker\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
    }
    return report(parkTicket(root, { ticketId: target, blocker }, { now: new Date().toISOString() }), io);
  }
  if (subcommand === "independence") {
    const read = readDraft<IndependenceInput>(target, "implement independence", io);
    if (!read.ok) return read.exit;
    return report(recordIndependence(root, read.draft, { now: new Date().toISOString() }), io);
  }
  if (subcommand === "fix") {
    if (target === undefined) {
      io.stderr(`implement fix needs a diagnosis id\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
    }
    const note = args.options["note"];
    return report(applyDiagnosis(root, { id: target, ...(note === undefined ? {} : { note }) }, { now: new Date().toISOString() }), io);
  }
  if (subcommand !== "start" && subcommand !== "check" && subcommand !== "complete" && subcommand !== "next") {
    io.stderr(`implement needs one of start, check, complete, next, park, independence, fix\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  if (subcommand === "next") {
    const escalation = args.options["escalation"];
    const result = await nextTicket(
      root,
      decisionDependencies(built.context, io, "implement"),
      escalation === undefined ? {} : { escalation },
    );
    io.stdout(`${JSON.stringify({ ok: result.kind !== "refused", ...result }, null, 2)}\n`);
    // Waiting and asking are the developer's; a start or a check to make is the agent's.
    return result.kind === "started" || result.kind === "needs-independence-check" || result.kind === "finished"
      ? EXIT_OK
      : EXIT_NEEDS_HUMAN;
  }
  if (subcommand === "start") {
    return report(startTicket(root, target === undefined ? {} : { ticketId: target }, built.context), io);
  }
  if (subcommand === "complete") {
    return report(
      completeTicket(root, target === undefined ? {} : { ticketId: target }, built.context, { now: new Date().toISOString() }),
      io,
    );
  }
  const read = readDraft<CheckInput>(target, "implement check", io);
  if (!read.ok) return read.exit;
  const dependencies = decisionDependencies(built.context, io, "implement");
  const checked = withCheckOutput(read.draft, root, dependencies, io);
  if (!checked.ok) return checked.exit;
  return reportValidation(await checkTicket(root, checked.draft, dependencies), io);
}

async function runWorker(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const now = new Date().toISOString();
  if (subcommand === "finish") {
    if (target === undefined) {
      io.stderr(`worker finish needs an assignment id\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
    }
    return report(finishWorker(root, target, { now }), io);
  }
  if (subcommand !== "assign" && subcommand !== "recommend") {
    io.stderr(`worker needs one of recommend, assign, finish\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  if (subcommand === "recommend") {
    const draft = readDraft<SelectionDraft>(target, "worker recommend", io);
    if (!draft.ok) return draft.exit;
    const result = await recommendModel(root, draft.draft, decisionDependencies(built.context, io));
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    // Nothing configured, a missing key or a failure awaiting approval each wait on the developer.
    const waits = !result.ok || "askHuman" in result.outcome || ("decision" in result.outcome && decisionWaits(result.outcome.decision));
    return waits ? EXIT_NEEDS_HUMAN : EXIT_OK;
  }
  const read = readDraft<WorkerDraft>(target, "worker assign", io);
  if (!read.ok) return read.exit;
  const result = assignWorker(root, read.draft, built.context, { now });
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok && "assignment" in result.outcome ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

function runTroubleshoot(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const now = new Date().toISOString();
  switch (subcommand) {
    case "start": {
      const read = readDraft<DiagnosisStart>(target, "troubleshoot start", io);
      if (!read.ok) return read.exit;
      const check = read.draft?.check as Partial<DiagnosisStart["check"]> | undefined;
      if (check !== undefined && (check.text !== undefined || check.exitCode !== undefined)) {
        return report(
          refuse("the failure file holds the check's output; jflow runs the failed check itself, so give only its command as check.source"),
          io,
        );
      }
      if (typeof check?.source !== "string" || check.source.trim() === "") return report(startDiagnosis(root, read.draft, { now }), io);
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const ran = runCheck(check.source.trim(), checkOptions(root, decisionDependencies(built.context, io), io));
      return report(startDiagnosis(root, { ...read.draft, check: { source: ran.source, text: ran.text, exitCode: ran.exitCode } }, { now }), io);
    }
    case "record": {
      const read = readDraft<DiagnosisFinding>(target, "troubleshoot record", io);
      if (!read.ok) return read.exit;
      return report(recordDiagnosis(root, read.draft, { now }), io);
    }
    default:
      io.stderr(`troubleshoot needs one of start, record\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

async function runPlanReview(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [, subcommand, target] = args.positional;
  if (subcommand !== "start" && subcommand !== "record" && subcommand !== "decide") {
    io.stderr(`review plan needs one of start, record, decide\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  if (subcommand === "start") return report(startPlanReview(root, built.context), io);

  const dependencies = decisionDependencies(built.context, io, "review");
  let result;
  if (subcommand === "record") {
    const read = readDraft<{ reviewer: ReviewInput["reviewer"]; findings: FindingInput[] }>(target, "review plan record", io);
    if (!read.ok) return read.exit;
    result = await recordPlanReview(root, read.draft, dependencies);
  } else {
    const { finding, outcome, note } = args.options;
    if (finding === undefined || (outcome !== "upheld" && outcome !== "withdrawn")) {
      io.stderr(`review plan decide needs --finding <id> and --outcome upheld|withdrawn\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
    }
    result = await decidePlanFinding(root, { finding, outcome, note: note ?? "" }, dependencies);
  }
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok && result.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

async function runReview(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  if (subcommand === "plan") return runPlanReview(args, io);
  if (subcommand !== "start" && subcommand !== "record" && subcommand !== "decide") {
    io.stderr(`review needs one of start, record, decide, plan\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  if (subcommand === "start") return report(startReview(root, built.context), io);

  const dependencies = decisionDependencies(built.context, io, "review");
  let result;
  if (subcommand === "record") {
    const read = readDraft<ReviewInput>(target, "review record", io);
    if (!read.ok) return read.exit;
    result = await recordReview(root, read.draft, dependencies);
  } else {
    const { finding, outcome, note, recommendation } = args.options;
    if (target === undefined || finding === undefined || (outcome !== "upheld" && outcome !== "withdrawn")) {
      io.stderr(`review decide needs a ticket id, --finding <id> and --outcome upheld|withdrawn\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
    }
    result = await decideFinding(
      root,
      { ticketId: target, finding, outcome, note: note ?? "", ...(recommendation === undefined ? {} : { recommendation }) },
      dependencies,
    );
  }
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok && result.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

async function runEscalate(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const read = readDraft<Boundary>(args.positional[0], "escalate", io);
  if (!read.ok) return read.exit;
  const result = await askEscalation(root, read.draft, decisionDependencies(built.context, io, args.options["stage"]));
  io.stdout(`${JSON.stringify({ ok: result.kind !== "refused", ...result }, null, 2)}\n`);
  return result.kind !== "refused" && !result.ask ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

async function runLearn(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;

  switch (subcommand) {
    case "propose": {
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const read = readDraft<LessonDraft>(target, "learn propose", io);
      if (!read.ok) return read.exit;
      const result = await proposeLesson(root, read.draft, decisionDependencies(built.context, io, args.options["stage"]));
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      // A conflict's ask, a missing key or a failure awaiting approval each wait on the developer.
      const waits = !result.ok || result.outcome.askHuman !== undefined || decisionWaits(result.outcome.advice);
      return waits ? EXIT_NEEDS_HUMAN : EXIT_OK;
    }
    case "decide": {
      const { outcome, by, reason, evidence, assessment } = args.options;
      if (
        target === undefined ||
        (outcome !== "retained" && outcome !== "candidate") ||
        (by !== "agent" && by !== "developer")
      ) {
        io.stderr(`learn decide needs a lesson id, --outcome retained|candidate and --by agent|developer\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(
        decideLesson(
          root,
          target,
          {
            outcome,
            by,
            ...(reason === undefined ? {} : { reason }),
            ...(evidence === undefined ? {} : { evidence: [evidence] }),
            ...(assessment === undefined ? {} : { assessment }),
          },
          { now: new Date().toISOString() },
        ),
        io,
      );
    }
    case "list": {
      const read = readRecord(root, "lessons");
      if (read.kind === "malformed") {
        io.stdout(`${JSON.stringify(unreadable("lessons", read), null, 2)}\n`);
        return EXIT_UNREADABLE;
      }
      return report({ ok: true, lessons: read.kind === "present" ? read.record.lessons : [] }, io);
    }
    case "active":
      return report(activeLessons(root), io);
    case "check": {
      const { task, outcome, reason, evidence } = args.options;
      if (target === undefined || task === undefined || reason === undefined || (outcome !== "applies" && outcome !== "skipped")) {
        io.stderr(`learn check needs a lesson id, --task, --outcome applies|skipped and --reason\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const result = checkLesson(
        root,
        target,
        { task, outcome, reason, ...(evidence === undefined ? {} : { evidence: [evidence] }) },
        { now: new Date().toISOString() },
      );
      return report(result, io);
    }
    case "supersede": {
      const { successor, evidence, by, reason, task } = args.options;
      const conflictsWith = args.options["conflicts-with"];
      if (target === undefined || successor === undefined || evidence === undefined || (by !== "agent" && by !== "developer")) {
        io.stderr(`learn supersede needs a lesson id, --successor, --evidence and --by agent|developer\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const built = buildContext(args.options, io);
      if (!built.ok) {
        io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
        return built.exit;
      }
      const result = await supersedeLesson(
        root,
        target,
        {
          successor,
          evidence: [evidence],
          by,
          ...(reason === undefined ? {} : { reason }),
          ...(task === undefined ? {} : { task }),
          ...(conflictsWith === undefined ? {} : { conflictsWith: [conflictsWith] }),
        },
        decisionDependencies(built.context, io, args.options["stage"]),
      );
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.outcome.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    default:
      io.stderr(`learn needs one of propose, decide, list, active, check, supersede\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

function runWrap(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [target] = args.positional;
  if (target === "show") {
    const read = readRecord(root, "resume");
    if (read.kind === "malformed") {
      io.stdout(`${JSON.stringify(unreadable("resume", read), null, 2)}\n`);
      return EXIT_UNREADABLE;
    }
    if (read.kind === "absent") return report({ ok: false, reason: "there is no resume record; wrap writes one" }, io);
    return report({ ok: true, resume: read.record }, io);
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const read = readDraft<WrapDraft>(target, "wrap", io);
  if (!read.ok) return read.exit;
  const result = wrapSession(root, read.draft, built.context, { now: new Date().toISOString() });
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  // Discrepancies are the developer's to see; wrap reconciles none of them.
  return result.ok && result.outcome.discrepancies.length === 0 ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

async function runResume(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  if (subcommand === "settle") {
    return report(settleDiscrepancies(root, { note: args.options["note"] ?? "" }, { now: new Date().toISOString() }), io);
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  switch (subcommand) {
    case undefined:
      return report(readResume(root, built.context), io);
    case "verify": {
      const read = readDraft<ValidationInput>(target, "resume verify", io);
      if (!read.ok) return read.exit;
      const dependencies = decisionDependencies(built.context, io);
      const checked = withCheckOutput(read.draft, root, dependencies, io);
      if (!checked.ok) return checked.exit;
      return reportValidation(await verifyTicket(root, checked.draft, dependencies), io);
    }
    case "reconcile": {
      let draft: ReconcileDraft = {};
      if (target !== undefined) {
        const read = readDraft<ReconcileDraft>(target, "resume reconcile", io);
        if (!read.ok) return read.exit;
        draft = read.draft;
      }
      const result = await reconcileResume(root, draft, decisionDependencies(built.context, io));
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.outcome.askHuman.length === 0 ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    default:
      io.stderr(`resume takes no subcommand, or one of verify, reconcile, settle\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

async function runRealign(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [target] = args.positional;
  if (target === "show") {
    const read = readRecord(root, "realign");
    if (read.kind === "malformed") {
      io.stdout(`${JSON.stringify(unreadable("realign", read), null, 2)}\n`);
      return EXIT_UNREADABLE;
    }
    return report({ ok: true, realign: read.kind === "present" ? read.record : { recommendations: [], realignments: [] } }, io);
  }
  if (target === "recommend") {
    const { source, summary, evidence } = args.options;
    if (source === undefined || summary === undefined) {
      io.stderr(`realign recommend needs --source and --summary\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
    }
    return report(
      recommendRealign(
        root,
        { source: source as RealignSource, summary, evidence: evidence === undefined ? [] : [evidence] },
        { now: new Date().toISOString() },
      ),
      io,
    );
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  const read = readDraft<RealignDraft>(target, "realign", io);
  if (!read.ok) return read.exit;
  const result = await realignPlan(root, read.draft, { note: args.options["note"] ?? "" }, decisionDependencies(built.context, io, "realign"));
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok && result.outcome.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

async function runReplay(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [decision] = args.positional;
  const { question, threshold, kind, authority } = args.options;
  if (
    decision === undefined ||
    (question === undefined && threshold === undefined && authority === undefined) ||
    (threshold !== undefined && (threshold.trim() === "" || Number.isNaN(Number(threshold))))
  ) {
    io.stderr(`replay needs a decision and --question, --threshold (a number from 0 to 1) and/or --authority\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }
  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  let proposal: ReplayProposal = {
    ...(threshold === undefined ? {} : { threshold: Number(threshold) }),
    ...(kind === undefined ? {} : { kind }),
    ...(authority === undefined ? {} : { authority: authority as DecisionAuthority }),
  };
  if (question !== undefined) {
    const read = readDraft<unknown>(question, "replay --question", io);
    if (!read.ok) return read.exit;
    proposal = { ...proposal, question: read.draft };
  }
  const result = await replayDecision(root, decision, proposal, decisionDependencies(built.context, io));
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok && result.report.nothingToReplay === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
}

async function runProposal(args: ParsedArgs, io: CliIo): Promise<number> {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const note = args.options["note"] ?? "";
  const now = new Date().toISOString();
  const dependencies = (context: ResolutionContext): ProposalDependencies => ({
    ...decisionDependencies(context, io),
    ...(io.packageDirectory === undefined ? {} : { packageDirectory: io.packageDirectory }),
  });

  switch (subcommand) {
    case "list":
      return report(listProposals(root), io);
    case "show":
      if (target === undefined) {
        io.stderr(`proposal show needs a proposal id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(readProposal(root, target), io);
    case "reject":
      if (target === undefined) {
        io.stderr(`proposal reject needs a proposal id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(rejectProposal(root, target, { note }, { now }), io);
    case "accept":
      if (target === undefined) {
        io.stderr(`proposal accept needs a proposal id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(acceptProposal(root, target, { note }, { now: () => now, ...(io.packageDirectory === undefined ? {} : { packageDirectory: io.packageDirectory }) }), io);
    case "observations":
    case "patterns":
    case "draft":
    case "replay":
      break;
    default:
      io.stderr(`proposal needs one of observations, patterns, draft, replay, accept, reject, list, show\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }

  const built = buildContext(args.options, io);
  if (!built.ok) {
    io.stdout(`${JSON.stringify(built.output, null, 2)}\n`);
    return built.exit;
  }
  switch (subcommand) {
    case "observations":
      return report({ ok: true, ...readObservations(root, built.context) }, io);
    case "patterns": {
      const view = readObservations(root, built.context);
      return report({ ok: true, patterns: findPatterns(view.observations), unreadable: view.unreadable }, io);
    }
    case "draft": {
      const read = readDraft<ProposalDraft>(target, "proposal draft", io);
      if (!read.ok) return read.exit;
      const result = await draftProposal(root, read.draft, dependencies(built.context));
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.outcome.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    default: {
      if (target === undefined) {
        io.stderr(`proposal replay needs a proposal id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      const result = await replayProposal(root, target, dependencies(built.context));
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.outcome.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
  }
}

function runConflict(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const now = new Date().toISOString();

  switch (subcommand) {
    case "raise": {
      const read = readDraft<ConflictDraft>(target, "conflict raise", io);
      if (!read.ok) return read.exit;
      const draft = read.draft;
      const result = raiseConflict(root, { ...draft, touches: draft.touches ?? [] }, { now });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.outcome.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    case "decide": {
      if (target === undefined) {
        io.stderr(`conflict decide needs a conflict id\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(decideConflict(root, target, { note: args.options["note"] ?? "", now }), io);
    }
    default:
      io.stderr(`conflict needs one of raise, decide\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

function runJev(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  const [subcommand, target] = args.positional;
  const now = new Date().toISOString();
  const stage = args.options["stage"];
  switch (subcommand) {
    case "approve": {
      const scope = args.options["scope"];
      if (scope !== "ticket" && scope !== "stage" && scope !== "plan") {
        io.stderr(`jev approve needs --scope ticket|stage|plan\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return report(
        approveFallback(root, { scope, note: args.options["note"] ?? "", ...(stage === undefined ? {} : { stage }) }, { now }),
        io,
      );
    }
    case "assess": {
      const read = readDraft<AssessmentInput>(target, "jev assess", io);
      if (!read.ok) return read.exit;
      const result = assessWithoutJev(root, read.draft, { now, ...(stage === undefined ? {} : { stage }) });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.outcome.askHuman === undefined ? EXIT_OK : EXIT_NEEDS_HUMAN;
    }
    default:
      io.stderr(`jev needs one of approve, assess\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

function runTraces(args: ParsedArgs, io: CliIo): number {
  const root = resolvePath(io.cwd, args.options["root"] ?? ".");
  switch (args.positional[0]) {
    case "list":
      return report({ ok: true, traces: listTraces(root) }, io);
    case "clean":
      return report({ ok: true, ...cleanTraces(root) }, io);
    default:
      io.stderr(`traces needs one of list, clean\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

/**
 * Runs one command. Its JSON output also lists every Jev decision the command
 * asked (issue #34), answered or not, under `jevDecisions`, so the agent can
 * tell the developer about each one; a command that asked nothing lists none.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let stdout = "";
  const decisions: JevDecisionEntry[] = [];
  const code = await runCommand(argv, {
    ...io,
    stdout: (text) => (stdout += text),
    onJevDecision: (entry) => {
      decisions.push(entry);
      io.onJevDecision?.(entry);
    },
  });
  io.stdout(withDecisions(stdout, decisions));
  return code;
}

/** Adds `jevDecisions` to a command's one JSON object; any other output (help text) is left as it is. */
function withDecisions(stdout: string, decisions: readonly JevDecisionEntry[]): string {
  if (stdout.trim() === "") return stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return stdout;
  return `${JSON.stringify({ ...parsed, jevDecisions: decisions }, null, 2)}\n`;
}

async function runCommand(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return EXIT_NEEDS_HUMAN;
  }

  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      io.stdout(USAGE);
      return EXIT_OK;

    case "status":
    case "next":
      return runRequest(args.command, args.options, io);

    case "run": {
      const request = args.positional.join(" ").trim();
      if (request === "") {
        io.stderr(`run needs a request: an action name or a sentence\n${USAGE}`);
        return EXIT_NEEDS_HUMAN;
      }
      return runRequest(request, args.options, io);
    }

    case "validate": {
      const built = buildContext(args.options, io);
      const output = built.ok
        ? {
            ok: true,
            package: { id: built.context.workflowPackage.id, schemaVersion: built.context.workflowPackage.schemaVersion },
            configuration: built.context.configuration,
          }
        : built.output;
      io.stdout(`${JSON.stringify(output, null, 2)}\n`);
      return built.ok ? EXIT_OK : built.exit;
    }

    case "specification":
      return runSpecification(args, io);

    case "plan":
      return runPlan(args, io);

    case "changes":
      return runChanges(args, io);

    case "todo":
      return runTodo(args, io);

    case "learn":
      return runLearn(args, io);

    case "wrap":
      return runWrap(args, io);

    case "realign":
      return runRealign(args, io);

    case "resume":
      return runResume(args, io);

    case "decide":
      return runDecide(args, io);

    case "escalate":
      return runEscalate(args, io);

    case "replay":
      return runReplay(args, io);

    case "proposal":
      return runProposal(args, io);

    case "implement":
      return runImplement(args, io);

    case "review":
      return runReview(args, io);

    case "troubleshoot":
      return runTroubleshoot(args, io);

    case "worker":
      return runWorker(args, io);

    case "ticket":
      return runTicket(args, io);

    case "conflict":
      return runConflict(args, io);

    case "jev":
      return runJev(args, io);

    case "traces":
      return runTraces(args, io);

    case "check-host": {
      const root = resolvePath(io.cwd, args.options["root"] ?? ".");
      const report = checkHostCapabilities(root, io.hostProbes ?? processProbeOptions());
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return EXIT_OK;
    }

    default:
      io.stderr(`unknown command "${args.command}"\n${USAGE}`);
      return EXIT_NEEDS_HUMAN;
  }
}

/**
 * Entry point for the built helper (`dist/cli.js`); tests call `runCli`
 * directly. Anything the commands did not handle (an I/O failure reading the
 * project, say) is reported as unreadable rather than as a stack trace.
 */
export async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      cwd: process.cwd(),
      userConfigFile: userConfigPath(process.env),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    process.exitCode = EXIT_UNREADABLE;
  }
}
