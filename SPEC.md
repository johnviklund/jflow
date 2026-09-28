# jflow first release: specification (draft)

Date: 2026-09-18
Status: ACCEPTED by the human on 2026-09-20 (D27 gate passed; revision
including D38-D50). Synthesized from
RELEASE-SCOPE.md and DISCOVERY.md D1-D34 using AI Hero's to-spec process.
No tracker is configured yet, so this spec is kept as a project file rather
than published to an external issue tracker.

Legend: items marked **(proposed default — confirm)** are unconfirmed per
RELEASE-SCOPE.md's "Proposed defaults, not yet accepted" section. Everything
else reflects an accepted decision (D1-D34) and is not open for silent
reinterpretation.

Status update (2026-09-18): the human confirmed the 7 proposed defaults from
RELEASE-SCOPE.md and the workflow-action-contract test seam. A new item (#8,
Jev API key handling — not previously covered in discovery) was raised and
confirmed in the same pass; see the Further Notes list. The
"(proposed default — confirm)" markers are left in place through the
document as a durable record of what was proposed vs. originally accepted in
discovery, even though all 8 are now confirmed.

Status update (2026-09-20, later): D51 records the skill/helper boundary,
answering a brief question no earlier decision covered; see Implementation
Decisions. It changes how tickets are delivered, not what they deliver.

Status update (2026-09-20): the human reviewed this draft and RELEASE-SCOPE.md
and recorded D38-D42 in DISCOVERY.md. D39, D40 and D41 reopened D35, D36, D18
and D10; a grill the same day settled every collision as D43-D50. This revision
applies D38-D50. Nothing is open. The human accepted this revision on
2026-09-20. Per D28, ticket-breakdown acceptance and execution authorization
are separate and have not been given for the revised scope.

## Problem Statement

LLMs are built to please humans and produce human-facing content. They are not
built to make precise, repeatable decisions at scale: which model is the most
efficient for this stage, what to do next, whether an output meets its stated
criteria, whether this is the moment to interrupt the human, what kind of
content this is, whether this session solved something worth remembering.
An agent harness that leaves all of those calls to the LLM is inconsistent
run to run, over-asks the human, and cannot be tuned from its own record.

Developers running long, multi-stage plans with AI agents feel this most when
work departs from the expected sequence (a blocked ticket, a failed check, a
disputed review finding, an interrupted session): they lose track of what to
invoke next, get interrupted for approvals that a bounded rule could have
made, and re-explain the project every session because lessons are not kept.

## Solution

Ship jflow: an AI-agent harness built from the combination of an LLM and Jev
(TypeSafe Server One), packaged as a single, JSON-defined workflow that a
user's own primary conversational agent (host- and model-agnostic) loads to
run one custom development workflow end-to-end in one conversation. The LLM
converses, investigates, writes and coordinates; Jev makes the bounded,
repeatable decisions the workflow declares (D37, D38). Without Jev this would
be another LLM workflow; the combination is the product.

jflow supplies: a fixed set of workflow actions (brainstorm, plan, implement,
troubleshoot, review, wrap, realign, plus status/next/todo/learn available
throughout); seven declared Jev decisions, each with a declared authority (D43):
`escalate` and `validate` are binding, `next-action`, `assignment`,
`lesson-retention`, `model-selection` and `classify` are advisory, and none
grants authorization;
a bias toward the fewest human approvals the workflow's rules allow (D40);
mandatory independent review; project-file-based authoritative records for
plans, tickets, progress, and lessons so any fresh conversation can reconcile
and resume; two kinds of learning, project lessons applied automatically and
harness observations that feed replay-gated, human-accepted proposals to
improve the Jev question and policy files (D39, D46); and local Git commits
after a ticket passes review. The first release targets GPT Desktop as host,
ships one workflow package (no alternates), and defers tracker integration,
arbitrary workflow customization, concurrent ticket implementation, and any
claim that Jev improves routing (D36).

## User Stories

### Actions and entry points

1. As a developer, I want to invoke jflow conversationally or by naming an
   action, so that I don't have to memorize a fixed command syntax.
2. As a developer, I want a `brainstorm` action that investigates an idea or
   existing problem and produces a specification, so that I have an agreed
   definition of what to build before planning starts.
3. As a developer, I want `brainstorm` to end with a specification covering
   the problem, scenarios, acceptance criteria, constraints, exclusions, and
   resolved decisions, so that later stages have a stable basis for agreement.
4. As a developer, I want the specification to require my explicit acceptance
   before `plan` creates implementation tickets, so that implementation never
   starts against an unagreed definition.
5. As a developer, I want a `plan` action that turns an accepted specification
   into a proposed ticket breakdown, so that I can review discrete units of
   implementation work before they start.
6. As a developer, I want to accept the ticket breakdown before implementation
   begins, so that I control what gets built and in what shape.
7. As a developer, I want plan acceptance and execution authorization treated
   as distinct decisions that a single instruction can still satisfy (e.g.
   "approved, implement the whole plan"), so that I'm not forced into two
   separate confirmations when I don't want them.
8. As a developer, I want "looks good" to accept a plan without silently
   expanding my authorization to execute it, so that acceptance and execution
   don't get conflated by accident.
9. As a developer, I want an `implement` action that carries out one ticket at
   a time, so that changes stay reviewable and traceable to a single unit of
   work.
10. As a developer, I want bounded parallel agent work permitted within the
    current ticket, so that independent sub-tasks inside a ticket can proceed
    concurrently without me micromanaging them.
11. As a developer, under whole-plan authorization, I want implementation to
    continue to the next eligible ticket without asking me again for every
    ticket, so that I'm not interrupted for permission I've already granted.
12. As a developer, I want a blocked ticket parked (not marked complete) while
    a genuinely independent, ready ticket continues, so that one blocker
    doesn't stall all authorized progress.
13. As a developer, I want the agent to verify that an unresolved blocker and
    any partial edits won't affect the ticket it's about to start before
    proceeding in parallel, so that parking a ticket never introduces hidden
    coupling risk.
14. As a developer, I want the agent to simply wait when no independent work
    can safely proceed, rather than guessing, so that I don't get surprised by
    unauthorized shortcuts.
14a. As a developer, I want `plan` to scope each ticket as a small,
    independently testable vertical slice intended to fit one fresh context
    window, so that redoing a ticket lost to session compaction is cheap
    rather than a large loss. I accept this is a mitigation, not a guarantee
    a ticket won't still blow out mid-run.
14b. As a developer, I want every ticket to carry acceptance criteria whose
    outcome can be validated by Jev from recorded verification evidence, and
    I want `plan` to refuse to emit a ticket that has none, so that "done" is
    a checked claim rather than an implementer's assertion (D41).
14c. As a developer, I want a `realign` action I can invoke when I change my
    mind about the plan mid-implementation, so that the spec, tickets and
    progress records are reconciled with my new direction (affected tickets
    re-scoped, added, parked or withdrawn; completed work re-checked) and
    presented for my acceptance before implementation continues, instead of
    me hand-editing records or restarting the plan (D42).
14d. As a developer, I want `realign` to be mine to invoke — the agent may
    recommend it when resume or review finds a consequential discrepancy, but
    never run it on its own authority — so that agreed scope only changes when
    I say so.
15. As a developer, I want a `troubleshoot` action that diagnoses problems
    without itself making code edits, so that diagnosis and remediation stay
    separated and remediation goes through an authorized implement/fix action.
16. As a developer, I want a `review` action that independently assesses a
    ticket's changes and, at the end of a plan, the integrated result across
    tickets, so that no work is accepted without a check separate from the
    person/agent that built it.
17. As a developer, I want a single-ticket plan's one review to be allowed to
    cover both the ticket-level and integrated-plan-level scope, so that the
    workflow doesn't force a redundant second review of identical scope.
18. As a developer, I want a `wrap` action that reconciles outcomes, unresolved
    todos, and lessons and leaves a resume record, so that ending a session
    doesn't lose context or leave loose ends invisible.
19. As a developer, I want wrap to never automatically push, merge, publish,
    or destructively clean up, so that ending a session can't silently take
    externally-visible or destructive action on my behalf.
20. As a developer, I want `status`, `next`, `todo`, and `learn` available at
    any point regardless of the current action, so that I can check progress,
    ask what to do next, capture unrelated work, or record a lesson without
    interrupting or restarting the current stage.
21. As a developer, I want a `todo` action that records future work items
    separately from the active plan, so that an unrelated discovery (e.g. a
    bug found mid-implementation) is captured without silently expanding my
    current assignment.
22. As a developer, I want promoting a todo item into the active plan to
    require an explicit decision from me, so that recording an item is never
    itself authorization to build it.

### Orchestration and delegation

23. As a developer, I want the primary agent to coordinate implementation,
    supporting skills/agents, diagnosis, review, and fixes within an assigned
    ticket without me invoking each skill by hand, so that I stay at the level
    of assigning and reviewing work rather than sequencing it manually.
24. As a developer, I want jflow to work with my choice of primary
    conversational model/host rather than depending on one specific model, so
    that I'm not locked into a single vendor or tier.
25. As a developer, I want the main conversational model to stay the same
    across stages while stage workers use their own configured models, so that
    my primary conversation partner doesn't unexpectedly change mid-workflow.
26. As a developer, I want each workflow stage to declare required agent roles
    and delegation limits, with the primary agent free to choose optional
    assignments (e.g. a debugging agent, parallel workers) within those
    constraints, so that execution adapts to the work without silently
    changing workflow policy.
27. As a developer, I want review to always use a separate reviewer agent,
    even if it's configured to use the same model as the implementer, so that
    self-review by the implementing agent never satisfies the review
    requirement.
28. As a developer, I want the reviewer model to be configurable independently
    of the implementer model, so that I don't need access to multiple models
    to use jflow.
29. As a developer, I want confirmed requirement, correctness, or mandatory
    project-standard violations found in review to block ticket completion,
    so that known-bad work can't slip through.
30. As a developer, I want optional/advisory review improvements routed to
    todo instead of blocking the ticket or expanding my assignment, so that
    nice-to-haves don't stall shipped work.
31. As a developer, I want disputed review findings resolved with evidence, or
    escalated to me when the dispute is consequential, so that disagreements
    get settled rather than silently dropped or silently obeyed.
32. As a developer, I want at most two unsuccessful fix-and-re-review attempts
    on the same blocking finding before the agent asks me for input with the
    unresolved problem, attempted fixes, and a recommendation, so that repeated
    failed attempts don't loop indefinitely.
32a. As a developer, I want a failed ticket test to be the normal reason I'm
    asked for help during implementation — only once the agent has exhausted
    its fix attempts on it — so that I'm escalated to for problems the LLM
    genuinely can't solve, not for routine progress (D41). Failed validation
    criteria and blocking review findings share one per-ticket counter, so
    "this ticket has had N failed fixes" is the whole story (D48).
33. As a developer, I want that fix-and-review retry limit to be configurable,
    so that I can tune it for my own risk tolerance.
34. As a developer, I want a local commit created after a ticket passes checks
    and review, containing only that ticket's changes and relevant project
    records, so that history stays granular and reviewable.
35. As a developer, I want local-commit-on-success enabled by default but
    configurable (on/off), so that I can opt out if I don't want it.
36. As a developer, I want pushing, publishing, and merging to always require
    separate authorization from committing, so that local work-in-progress
    never becomes externally visible without my say-so.

### Judgment boundaries (Jev)

37. As a developer, I want a bounded-judgment assistant (Jev) that recommends
    the next eligible action and relevant supporting skills, so that I get
    routing help without ceding authorization decisions to it.
38. As a developer, I want Jev to assess proposed agent assignments for
    relevance and overlap, so that redundant or mismatched delegations get
    flagged before they run.
39. As a developer, I want Jev to assess candidate project lessons for
    retention and later relevance, so that noisy or irrelevant lessons don't
    accumulate.
39a. As a developer, I want Jev to validate a ticket's output against its
    stated acceptance criteria using the recorded verification evidence,
    answering per criterion met / not-met / insufficient-evidence, so that
    completion is a bounded, repeatable judgment rather than the
    implementer's own claim (D41, D47). This judgment is binding: not-met
    returns the ticket to fix, all-met admits it to review, and
    insufficient-evidence means run the missing check or escalate. It is the
    gate into review, never a replacement for it.
39b. As a developer, I want the workflow to ask me for approval only when
    Jev's `escalate` decision says so, and otherwise to proceed within the
    authority I've already given, so that I'm interrupted as little as the
    rules allow (D40, D44). It is one general question asked at every
    human-facing boundary, binding, with a conservative first threshold that
    I accept will over-ask until a recorded corpus supports lowering it
    (D45). Consequential conflicts (story 42), continuing without Jev
    (stories 43-44) and the acceptance gates (stories 4, 6) still come to me
    regardless and never go through Jev.
39c. As a developer, I want every declared Jev decision to carry a declared
    authority, binding or advisory, in the workflow package, so that nothing
    becomes binding by drift and I can see at a glance which answers the
    workflow acts on and which the agent merely weighs (D43).
39d. As a developer, I want Jev to recommend a model and effort for each
    stage worker from the models I configured for that stage and their
    explicit fallbacks, never from outside that set, so that cost and
    capability get matched per assignment without jflow ever picking a model
    I didn't approve (D49, advisory; D20 unchanged).
39e. As a developer, I want Jev to classify whether a discovered item is todo
    or in scope, which part of the project a candidate lesson applies to, and
    whether a drafted acceptance criterion is actually testable, so that the
    places where the LLM currently sorts things alone get a bounded second
    opinion (D50, advisory). Review finding disposition is deliberately not
    classified; the fixed rule in story 29 decides it alone.
40. As a developer, I want it made clear that Jev's scores never prove
    correctness in the abstract, and that exact prerequisite/authorization
    checks are always performed separately (not by Jev judgment alone), so
    that jflow doesn't silently under-verify important gates.
41. As a developer, I want the primary agent able to override any Jev
    answer, binding or advisory, when it records an evidence-based reason
    within workflow rules and its existing authority, so that Jev's answers
    don't become an unquestionable gate; for a binding answer that recorded
    reason is the only way past (D6, D43).
42. As a developer, I want consequential conflicts (requirements, scope,
    workflow rules, permissions) escalated to me rather than resolved
    silently, while ordinary technical disagreements get resolved by
    investigation, so that I'm only interrupted when it actually matters.
43. As a developer, I want jflow to retry a temporary Jev failure a limited
    number of times and then ask me before continuing without Jev, so that
    I'm never silently downgraded to primary-agent-only judgment.
44. As a developer, I want my approval to continue without Jev to apply to the
    current ticket or stage only (not silently broadened), with the fallback
    status recorded and kept visible, so that a one-time approval can't
    quietly cover unrelated future work.
45. As a developer, I want jflow to send Jev only evidence relevant to the
    current decision (task summaries, candidates, selected excerpts) within
    project-configured sharing limits, excluding credentials and full
    conversation/repository uploads by default, so that my data exposure to
    Jev stays minimal and intentional.
46. As a developer, I want exact Jev requests/responses kept locally, outside
    version control, while project progress records keep concise summaries
    and trace references, so that another machine can recover project
    progress without needing the raw traces, and traces don't leak into
    shared history by default.

### Models and configuration

47. As a developer, I want to configure a different model for each workflow
    stage (worker), so that I can balance cost/capability per stage without
    changing my primary conversation model.
48. As a developer, I want jflow to use only an explicitly configured fallback
    model when a configured stage-worker model is unavailable, and otherwise
    ask me, so that jflow never silently substitutes an unapproved model.
49. As a developer, I want jflow's workflow defined in JSON with a supported
    settings surface (stage models, explicit fallbacks, delegation/retry
    limits, evidence-sharing controls), so that customization is structured
    and validated rather than freeform.
50. As a developer, I want jflow to validate configuration and required host
    capabilities before running an action, surfacing missing models/tools and
    actionable setup errors rather than silently weakening a gate (e.g. the
    separate-review requirement), so that misconfiguration fails loudly and
    early **(proposed default — confirm)**.

### Project records, resume, and learning

51. As a developer, I want plans, tickets, progress, and project lessons kept
    as authoritative project files (not chat history), so that a fresh
    conversation can recover full context.
52. As a developer, I want a resumed session to reconcile saved progress
    against actual project files and available verification evidence before
    continuing, limiting checks to affected work and preserving existing
    edits rather than restarting a ticket by default, so that resuming is
    cheap and doesn't discard work.
53. As a developer, I want a consequential discrepancy found at resume (e.g.
    changed requirements) escalated to me rather than silently reconciled, so
    that stale assumptions don't get carried forward unnoticed.
54. As a developer, I want evidence-backed project lessons (clear scope,
    source links, no conflict with accepted decisions) retained automatically
    with a visible report of what was saved, so that useful lessons
    accumulate without manual bookkeeping.
55. As a developer, I want speculative lessons kept as candidates rather than
    silently retained, and lessons that conflict with accepted decisions
    escalated to me, so that unverified or contradicting "learning" can't
    quietly override my decisions.
56. As a developer, I want retained lessons re-checked for applicability
    before use, with contradicted lessons marked superseded (with evidence)
    rather than silently overwritten, so that stale lessons don't mislead
    future work **(proposed default — confirm)**.
57. As a developer, I want jflow to keep two kinds of memory separate, so that
    "learning" can't become a backdoor for unreviewed behavior changes while
    the workflow's own weak spots still get recorded. Project lessons are
    retained automatically per D21. Harness observations (low-confidence
    answers, overrides, repeated escalations) are recorded automatically and
    applied never, as a derived view over the trace records the Jev client
    already persists rather than a second store, and are never filtered by
    Jev. Question and policy files change only through a proposal that has
    been replayed against recorded envelopes and explicitly accepted by me
    (D35, narrowing D3/D21).
57a. As a developer, I want jflow to generate proposals that improve the Jev
    question and policy files from harness observations and project lessons,
    the same way it helps improve LLM-facing instructions such as AGENTS.md,
    so that Jev's judgments get better for this repo over time instead of
    staying as good as the first draft of their questions (D39). Each
    proposal still needs my explicit acceptance, and before I see it jflow
    replays the proposed question or threshold against the stored envelopes
    and reports how many answers would change and in which direction (D46),
    so that I'm accepting a shown effect rather than a hunch.
58. As a developer, I want raw traces (Jev traces, detailed evidence) kept
    until I explicitly clean them up, with no automatic deletion, export, or
    upload, so that I control retention and can inspect history later
    **(proposed default — confirm)**.

### Git and environment

59. As a developer, I want jflow to use a local Git repository for
    implementation and review, without brainstorm/plan requiring Git first,
    so that early-stage work isn't blocked on repo setup
    **(proposed default — confirm)**.
60. As a developer, I want jflow to never initialize, discard, or absorb
    pre-existing uncommitted changes silently, pausing affected work when
    ownership of existing changes is unclear, so that jflow can't
    accidentally destroy or claim work it didn't create
    **(proposed default — confirm)**.

## Implementation Decisions

- **Workflow package shape**: One JSON-defined workflow package, shipped as
  the sole workflow in the first release (D8, D24). It declares the action
  set (brainstorm, plan, implement, troubleshoot, review, wrap, realign;
  status, next, todo, learn as always-available cross-cutting actions), per-stage required
  roles and delegation limits, and the supported configuration surface
  (stage models, explicit model fallbacks, delegation/retry limits,
  evidence-sharing limits). Arbitrary stage addition and method replacement
  are out of scope for this release (D24). **Decisions and policy (D37)**:
  the package also declares the judgments Jev makes within the process, which
  PROJECT-BRIEF.md names as the configuration's second job and which the
  first draft omitted. Two top-level keys are added at **schema version 2**
  (a released schema is not widened in place): `decisions`, mapping a named
  decision to a question reference and version, and `policy`, mapping a named
  decision to its thresholds and weights. Question content lives in separate
  files under `workflow/questions/`, and policy thresholds live in their own
  file separate from the question files, so changing a threshold is a
  one-line diff. **Every `decisions` entry also declares its `authority`,
  `binding` or `advisory` (D43)**, with the same `basis` requirement as
  thresholds; authority changes only through the D39/D46 proposal gate.
  Every policy entry must declare a `basis` field recording
  where its numbers came from; the `escalate` threshold ships as an
  uncalibrated placeholder, set conservatively so it routes to the human
  readily (D45), because DISCOVERY.md records that no useful confidence
  threshold has been established. No test may assert a threshold's value.
  Tests assert only that routing behaves correctly above and below it. The
  package schema owns whether a question file is well-formed, versioned and
  resolvable; the content of each question file is proposed for explicit
  human acceptance under the same gate D35 imposes on later changes. Seven
  decisions are declared in the first release: `next-action`, `assignment`,
  `lesson-retention`, `model-selection`, `classify` (advisory) and
  `escalate`, `validate` (binding); see the Jev integration boundary.
- **Skill and helper boundary (D51)**: jflow ships as a skill, a directory of
  instructions with a bundled helper script. The skill's per-action
  instruction files carry the methods (how to brainstorm, plan, implement,
  review, wrap and realign, how to present results, when to run the helper)
  and are verified by execution on the host. The helper carries the exact
  parts: package and configuration validation, project-record reads and
  writes, prerequisite and authorization resolution, Jev calls with envelopes
  and traces, the `validate` and `escalate` outcomes, the per-ticket fix
  counter, replay, and the local commit. The workflow-action-contract seam
  tests the helper. Every action ticket delivers both its instruction file and
  the helper commands it relies on. The reason is adoption of an open-source
  release; a skill lowers the bar to use it.
- **Primary agent contract**: jflow does not assume or require a specific
  host or primary-agent model (D11). It targets GPT Desktop as the first
  verified host (D13); exact invocation syntax, host capabilities, and
  end-to-end compatibility must be verified against current GPT Desktop
  documentation before being claimed as supported, not assumed from the
  brief's illustrative syntax.
- **Stage-worker model configuration**: The main conversational model is
  fixed across stages; stage workers use per-stage configured models (D18,
  D19). An unavailable configured worker model falls back only to an
  explicitly configured fallback, otherwise the agent asks the human (D20).
  The actual model used is recorded.
- **Jev API key handling** (confirmed 2026-09-18, new item #8): the Jev API
  key is never stored in project files or version control. It is read from an
  environment variable or from the user's key file, `~/.config/jflow/jev-key`,
  which sits outside every project (changed 2026-09-26: the ChatGPT desktop
  app offers no secret storage, and a variable set in a shell does not reach
  a desktop app started from its launcher). If it is missing,
  jflow asks the human how to configure it rather than proceeding without Jev
  or silently falling back; this is distinct from the temporary-failure
  retry/fallback handling below, which assumes a key is already configured.
- **Jev integration boundary**: The first release declares six Jev
  decisions, each with a declared authority (D43):
  - `next-action` (advisory, D18): next eligible action and supporting
    skills.
  - `assignment` (advisory, D18): relevance and overlap of proposed agent
    assignments. Not counted in the grill's "six" (D49); it was never
    removed and stays as D18 accepted it, so seven decisions are declared.
  - `lesson-retention` (advisory, D18): retention and later relevance of a
    candidate project lesson.
  - `escalate` (**binding**, D44): one general question at every
    human-facing boundary (next ticket under whole-plan authorization, a
    failed fix attempt, a disputed finding, a conflicting lesson, a resume
    discrepancy): must the human be consulted before proceeding. At the
    next ticket under whole-plan authorization it is asked only when the
    start is unusual: a ticket is parked, an independence check stands in
    for a dependency, a resume discrepancy is open, or the latest finished
    ticket had a failed fix attempt, a verdict set aside or no passed review.
    An ordinary start is decided by those rules without Jev (amended
    2026-09-27 for the first start, 2026-09-28 for every ordinary one, third
    jflow trial: at six ordinary starts Jev answered proceed every time, at
    confidences from 0.31 to 0.91 that did not follow the situation, so the
    developer was asked with nothing for Jev to judge). Answer
    `proceed` or `escalate` with a closed reason code and confidence; the
    packet carries the boundary kind so it can be split per boundary later
    by D46 replay. First threshold conservative (D45).
  - `validate` (**binding**, D47): per criterion `met` / `not-met` /
    `insufficient-evidence` over the ticket's accepted acceptance criteria
    and the recorded verification evidence (test results, check outputs,
    the implementer's claim). Check output is recorded by the helper, which
    runs the check commands the agent names; the agent never supplies it
    (changed 2026-09-27, issue #32: in two trials an agent summarized test
    output in place of the output, and validate could not judge it). Not
    the diff, not the repository. It judges
    whether evidence satisfies stated criteria, not code quality or omitted
    requirements. `not-met` returns the ticket to fix; all `met` admits it
    to review; `insufficient-evidence` runs the missing check or, if none
    exists, asks `escalate`. Validation is the gate into review, never a
    replacement for it (D9, D32).
  - `model-selection` (advisory, D49): a model and effort for a stage
    worker, chosen only from the stage's configured models and explicit
    fallbacks (D19, D20). D20 is unchanged: no silent substitution, the
    actual model is recorded.
  - `classify` (advisory, D50): a class for a piece of workflow content,
    with the content kind in the packet: discovered-item routing (todo vs
    in-scope, D26), lesson scope (feeding D21), and ticket testability (run
    inside `plan`; an untestable criterion is rewritten before D28
    acceptance). Review finding disposition is not classified; D33's rule
    stands alone.

  Hard rules never reach Jev and always ask the human: D7 consequential
  conflicts, D16/D17 continuing without Jev, and the D27/D28 acceptance
  gates. Jev never grants authorization; exact prerequisite and authorization
  checks are performed independently of Jev (D6/D18). Binding means the
  workflow acts on the answer directly; advisory means the primary agent
  weighs it. Either way, the primary agent may choose a different permitted
  action only by recording an evidence-based reason in the decision envelope,
  within existing workflow rules and authority (D6). Evidence sent
  to Jev is a bounded, decision-specific packet (task summary, candidates,
  selected excerpts) honoring project sharing limits; credentials and full
  conversation/repository content are excluded by default (D22). Jev
  request/response traces are stored locally, outside version control;
  project records keep summaries plus trace references only (D23).

  **Authority versus improvement (D36, D43)**: D36's "advisory throughout"
  wording is superseded by the per-decision authority field; its other
  content stands. A proposal to make review finding disposition a Jev
  judgment was rejected on 2026-09-19 and stays rejected (D50). The release
  makes no claim that Jev improves routing; a binding decision is not
  evidence that it is a good one. It demonstrates only that decisions are
  bounded, recorded in full, and reconstructable from their own records,
  meaning the stored packet, question and policy versions, answer and reason
  code together rebuild the exact request without chat history or a live Jev
  call. Whether Jev earns its place is a release-2 question answered by
  replaying the corpus this release builds.
- **Jev failure handling**: Temporary Jev failures are retried a limited,
  configurable number of times; exhausting retries requires human approval
  before continuing without Jev, scoped to the current ticket/stage unless
  explicitly broadened, and recorded with fallback status kept visible (D16,
  D17). **(Proposed default — confirm)**: retry twice after the initial
  attempt with backoff and a finite timeout; surface authentication/invalid-
  request errors immediately without retry; this is a distinct counter from
  the review fix-retry limit. Uncertain/unusable Jev answers require
  primary-agent evidence assessment with a recorded resolution, using the
  same human-escalation rules; return to normal Jev use at the next decision
  boundary after recovery, recording the change **(proposed default —
  confirm)**.
- **Ticket lifecycle**: `implement` processes one ticket at a time; bounded
  parallel agent work is allowed inside the current ticket (D29). Under
  whole-plan authorization, work proceeds to the next eligible ticket without
  re-asking (D28, D29). A blocked ticket is parked (not completed); an
  independent, ready ticket may proceed only after verifying the blocker and
  any partial edits don't affect it; if nothing can safely proceed, jflow
  waits (D30). Concurrent implementation of multiple non-dependent tickets is
  deferred, not implemented in this release (D29).
- **Ticket sizing as compaction mitigation** **(new, added and confirmed
  2026-09-18, following AI Hero's `to-tickets`/`implement` precedent)**:
  `plan` scopes each ticket as a small, independently testable vertical slice
  intended to fit comfortably in one fresh context window, so that if a
  session compacts or is lost mid-run, redoing the ticket from its written
  definition is cheap. This is a mitigation, not a guarantee — the human
  confirmed from experience that a ticket that "looks small" can still blow
  out mid-run. jflow does not attempt mid-ticket checkpointing to compensate
  (see Testing Decisions/resume behavior); a ticket only writes its
  completion/commit state once it passes checks and review. A ticket lost to
  compaction before that point is redone, not resumed from a partial state.
- **Testable tickets (D41, D47, D48)**: every ticket carries acceptance
  criteria whose outcome Jev can validate from recorded verification
  evidence; `plan` does not emit a ticket without them, and runs `classify`
  on each drafted criterion for testability before presenting the breakdown
  (D50). During `implement`, a failed test is the normal escalation path:
  the agent attempts fixes, and asks the human (via `escalate`) only when it
  cannot solve the failure within the retry limit. One counter per ticket
  covers every unsuccessful fix attempt, whether a `not-met` validation
  criterion or a blocking review finding triggered it (D48, widening D10);
  the default is 2 and it is configurable.
- **Realign (D42)**: a human-invoked action for changing the plan while
  implementation is in flight. It reconciles the accepted specification, the
  ticket breakdown and progress records with the human's new direction
  (affected tickets re-scoped, added, parked or withdrawn; completed work
  re-checked against the changed requirements) and presents the result for
  acceptance under D27/D28 before implementation continues. It implements
  nothing. The primary agent may recommend it, for example when D15 resume
  or a review finds a consequential discrepancy, but may not run it on its
  own authority.
- **Review gate**: Every ticket gets an independent review from a reviewer
  agent distinct from the implementer, using a fresh reviewer context
  (requirements, standards, changes, verification evidence); the reviewer's
  model is independently configurable and may equal the implementer's model,
  but self-review by the implementing agent never satisfies the gate (D31,
  D32). The plan also gets an integrated review checking cross-ticket
  interactions and overall acceptance criteria; a single-ticket plan may
  satisfy both scopes with one review pass rather than a duplicated second
  review (D9). Finding disposition: confirmed requirement/correctness/
  mandatory-standard violations block completion; optional improvements
  become todo items; disputed findings need evidence-backed resolution or
  human escalation for consequential disputes (D33). Retry limit: two
  unsuccessful fix attempts on the ticket, counting validation misses and
  blocking findings together (D10, D48), then ask the human with the
  unresolved problem, attempted fixes, and a recommendation; this limit is
  configurable and independent of the Jev retry count. A ticket reaches
  review only after `validate` reports every criterion met (D47).
- **Commits**: After a ticket passes checks and independent review, jflow
  creates a local commit containing only that ticket's changes and relevant
  project records; enabled by default, configurable off. Pushing, publishing,
  and merging always require separate authorization (D34).
- **Git environment handling** **(proposed default — confirm)**: Require a
  local Git repository for implementation and review; brainstorm/plan may
  precede Git setup. Never initialize, discard, or absorb pre-existing
  uncommitted changes silently; pause affected work when repo/ownership state
  is unclear. `troubleshoot` and `review` never edit code themselves — only
  an authorized implement/fix action makes edits.
- **Project records**: Plans, tickets, progress, and project lessons live in
  project files as the authoritative record, recoverable by a fresh
  conversation without relying on chat history (D14). Resume reconciles saved
  progress against actual files and available verification evidence, limited
  to affected work, preserving existing edits and running missing checks
  rather than restarting a ticket or trusting a stale completion claim by
  default; consequential discrepancies (e.g. changed requirements) escalate
  to the human (D15). Exact file formats/schemas are an implementation choice
  for the ticket-writing stage, not specified here, since to-spec instructs
  against baking in file paths/formats that may go stale — but the schema
  must at minimum represent: plan, tickets (with status/dependencies),
  progress/reconciliation state, project lessons (with scope, evidence links,
  and superseded/active status), Jev fallback/approval status, and a wrap
  resume record.
- **Compound learning**: Automatically retain project lessons with
  supporting evidence, clear scope, and no conflict with accepted decisions;
  report what was saved with evidence links. Speculative lessons remain
  candidates only; conflicts with accepted decisions escalate to the human
  (D21). **Two memory kinds, kept separate (D35, narrowing D3/D21)**: project
  lessons as above, and harness observations (low-confidence answers,
  overrides, repeated escalations) recorded automatically and applied never.
  Harness observations are a derived view over the trace records the Jev
  client and its failure handling already persist, not a second store, and
  are never filtered by Jev. Question and policy files change only through a
  proposal replayed against recorded envelopes and explicitly accepted by the
  human. This depends on the closed reason-code requirement: a view over
  unlabelled records is worthless, so if reason codes are cut, D35 is
  revisited rather than shipped hollow. A `memory/<slug>/` layout is proposed
  but not implemented in this release. **Changed by D39 (2026-09-20)**:
  generating question/policy improvement proposals from harness observations
  and project lessons is a first-release capability, not only a gate; Jev's
  output is only as good as its questions, so the questions should improve
  from learnings for this repo, alongside LLM-facing instructions such as
  AGENTS.md. Human acceptance is still required for every proposal, and
  **minimal replay ships in release 1 to gate it (D46, changing D36's
  deferral)**: the proposed question or threshold is re-run against the
  stored envelopes for that decision and the report shows how many answers
  would change and in which direction, per boundary kind and reason code.
  Load envelopes, call Jev, diff answers; nothing more. It gates a change and
  does not evaluate Jev. The first expected proposals are lowering the
  `escalate` threshold (D45) and splitting `escalate` or `classify` by kind
  (D44, D50).
  **(Proposed default — confirm)**: re-check a retained
  lesson's applicability before use each time; mark contradicted lessons
  superseded with evidence rather than silently overwriting an accepted human
  decision. **(Proposed default — confirm)**: keep raw traces until explicit
  local cleanup — no automatic deletion/export/upload; preserve portable
  summaries after cleanup.
- **Configuration validation** **(proposed default — confirm)**: Validate
  configuration and required host capabilities before execution; surface
  missing models/tools as actionable setup errors; configuration can never
  disable the mandatory separate-review requirement.
- **Action set and semantics**: brainstorm (investigate → specification,
  human acceptance required before plan creates tickets, D27), plan (accepted
  spec → ticket breakdown, human acceptance required before implement starts,
  D28), implement (D29/D30 above), troubleshoot (diagnosis only, no edits),
  review (D9/D31-D33 above), wrap (reconcile outcomes/todos/lessons, leave a
  resume record; never auto-push/merge/publish/destructively clean, D34-
  equivalent user story from RELEASE-SCOPE), realign (human-invoked in-flight
  plan change, D42 above). status/next/todo/learn are
  available at any workflow point (D25). todo records future work without
  auto-adding it to the active plan; promotion requires an explicit decision
  (D26).
- **Model neutrality in requirements**: All requirements and documentation
  use model-neutral language; Astra/Fable/Sol/Sonnet are documented as user
  preferences only, never as a verified support list or automatic routing
  policy (D11, D12).

## Testing Decisions

- Prefer testing at the seam of "workflow action contract": given a workflow
  state (project files) and a triggering request, does the action produce the
  correct next state, records, and (where applicable) authorization behavior —
  rather than testing internal agent prompt text. This is the highest, most
  stable seam available in a project with no existing implementation, and
  keeps the number of test seams close to one per action contract.
- Only test observable behavior: file/record state before and after an
  action, what was asked of the human (and when), and what was/was not
  authorized — not the literal wording of any agent's internal reasoning or
  prompt.
- Priority modules/behaviors to cover, mapped to the demonstrations in
  RELEASE-SCOPE.md:
  1. Full lifecycle: idea → accepted spec → accepted plan → authorized
     multi-ticket implementation → per-ticket review → integrated review.
  2. Failure path: a failed check triggers troubleshoot/fix; a blocking review
     finding triggers re-review; two unsuccessful attempts trigger human
     escalation with evidence.
  3. Parking: a blocked ticket is parked (not completed) while a genuinely
     independent ready ticket proceeds, without losing the blocker record or
     silently expanding authorization.
  4. Resume: a fresh conversation reconciles interrupted work from project
     files and continues without discarding partial progress.
  5. Model configuration: configured stage/reviewer models are used and
     recorded; an unavailable model without an explicit fallback triggers a
     human ask rather than silent substitution.
  6. Jev outage/uncertainty: exhausted retries require human-approved
     fallback, scoped correctly; uncertain Jev answers get a recorded
     evidence-based resolution.
  7. Learning: a verified lesson is retained and applied in a later relevant
     task without altering workflow logic; an unrelated discovery is filed as
     todo, not auto-scheduled.
  8. Guardrails: invalid configuration, excluded evidence, or missing review
     evidence must not silently pass; raw traces stay out of version control.
  9. Approval minimisation (D40, D44, D45): a `proceed` answer within
     existing authority produces no human ask; `escalate` does; a hard rule
     (D7 conflict, D16 fallback, D27/D28 gate) asks without consulting Jev.
     Tests assert routing above and below the threshold, never the
     threshold's value (D37).
  10. Testable tickets and validation (D41, D47, D48): `plan` rejects a
      ticket without acceptance criteria; `validate` receives criteria plus
      recorded evidence and its `not-met` returns the ticket to fix, all-met
      admits it to review, `insufficient-evidence` runs the missing check;
      the per-ticket counter escalates at the limit regardless of which gate
      caught the failure.
  11. Realign (D42): a mid-implementation plan change re-scopes affected
      tickets, re-checks completed work, and re-enters the D27/D28 acceptance
      gate without losing progress records; the agent never runs it unasked.
  12. Question-file proposals and replay (D39, D46): a harness observation
      pattern yields a proposal with linked evidence and a replay report
      built from stored envelopes only (no chat history, no new live
      decisions); nothing changes until the human accepts.
  13. Authority (D43): a binding answer is acted on directly and a recorded
      evidence-based reason is the only way past it; an advisory answer is
      recorded and may be set aside with a reason; an undeclared authority
      fails package validation.
  14. Model selection and classification (D49, D50): a recommended model
      outside the configured set is rejected by the workflow, not just
      ignored; `classify` never receives a review finding.
- The seam tests the helper (D51). Instruction-file behaviour is not unit
  tested; it is verified by a recorded run on the host, and the release
  demonstrations split along the same line.
- Prior art: none in this repository yet (no implementation exists). The
  installed AI Hero `implement` skill already expects TDD where possible plus
  review-then-commit; the installed `code-review` skill expects a fixed Git
  reference and reviews committed changes against HEAD. Confirm these two
  skills' handoff is compatible with jflow's ticket/commit/review sequence
  before relying on them as-is (flagged as an open question in DISCOVERY.md,
  not yet verified by execution).
- Do not claim measurable Jev-routing improvement, universal host/model
  support, lower cost, or higher accuracy without evidence; where the spec's
  demonstrations exercise Jev-assisted choices, compare against the stated
  rules and against ordinary primary-agent judgment before making any
  improvement claim.

## Out of Scope

- Additional workflow packages beyond the user's one custom development
  workflow (D8).
- General/arbitrary workflow editing, adding stages, or replacing workflow
  methods (D24).
- GitHub/Linear (or other external tracker) integration; publishing specs or
  tickets to an external tracker (D14; RELEASE-SCOPE "Specification and
  validation work still needed").
- Concurrent implementation of separate (non-dependent) tickets (D29).
- Abstract correctness scoring by Jev, and Jev classification of review
  finding disposition (D18, D50). Ticket-output validation against stated
  criteria, model selection from the configured set, and the three D50
  content kinds are in scope (D47, D49, D50); anything beyond the six
  declared decisions is not.
- Binding authority for any decision other than `escalate` and `validate`
  (D43). Changing a decision's authority goes through the D39/D46 gate.
- Workflow logic changes driven by compound learning. Narrowed by D35: project
  lessons still never change workflow logic, and harness observations are
  recorded but applied never. Question and policy files change only through a
  human-accepted, replay-gated proposal (D3, D21, D35, D46); generating such
  proposals is in scope under D39, applying them without acceptance is not.
- Tuning machinery beyond minimal replay, and any claim that Jev improves
  routing. Minimal replay (load envelopes, call Jev, diff answers) is in
  scope to gate proposals (D46); scoring, optimisation and evaluation of Jev
  are not. The first release demonstrates only that decisions are bounded,
  recorded in full, and reconstructable from their own records. Whether Jev
  earns its place is a release-2 question (D36).
- Automatic switching of the main conversational model between stages (D19).
- License, GitHub ownership, and public distribution/packaging decisions
  (deferred until before public publication; not required for this draft
  spec, per RELEASE-SCOPE).
- Verified, exhaustive support claims for any host/model beyond what has been
  explicitly checked against current documentation (D11, D13).

## Further Notes

- **Proposed defaults awaiting confirmation** (all called out inline above
  and repeated here for a single confirmation pass, per RELEASE-SCOPE.md):
  1. Require a local Git repo for implement/review only (not brainstorm/plan);
     never silently initialize/discard/absorb pre-existing changes; pause
     when ownership is unclear; troubleshoot/review never edit code.
  2. Validate configuration and host capabilities before execution with
     actionable errors; configuration can never disable the mandatory
     separate-review gate.
  3. Retry a temporary Jev failure twice after the initial attempt (backoff +
     finite timeout); surface auth/invalid-request errors immediately; this
     counter is separate from the review fix-retry limit.
  4. Treat uncertain/unusable Jev answers as needing primary-agent evidence
     assessment with a recorded resolution and the existing escalation rules;
     keep missing-service fallback subject to explicit human approval; return
     to normal Jev use at the next decision boundary after recovery,
     recording the change.
  5. Keep raw traces until explicit local cleanup (no auto delete/export/
     upload); preserve portable summaries after cleanup.
  6. Re-check a retained lesson's applicability before each use; mark
     contradicted lessons superseded with evidence rather than silently
     overwriting an accepted human decision.
  7. Wrap reconciles outcomes/todos/lessons and leaves a resume record; it
     never auto-pushes, merges, publishes, or destructively cleans up.
  8. Jev API key handling **(new, not from discovery — added and confirmed
     2026-09-18)**: never store the Jev API key in project files or version
     control. Read it from an environment variable or the user's key file
     outside every project (changed 2026-09-26, see above). If it's missing, ask the human how to configure it rather than
     proceeding without Jev or silently falling back — this is distinct from
     the temporary-failure retry/fallback policy in items 3-4, which assumes
     a key is already configured.
- **Seam check requested** (to-spec step 2): this is a greenfield project
  with no existing code, so the natural seam is the *workflow action
  contract* seam described in Testing Decisions above — action in, project-
  file state out, plus recorded human-ask/authorization events — rather than
  a seam inside any specific agent's prompt or a UI seam. Please confirm this
  is the right seam before planning creates tickets around it, or propose a
  different one (e.g. if you want a thinner or thicker seam, such as testing
  at the JSON-workflow-definition level only, or including host-adapter
  boundaries as a separate seam).
- Exact project-record file formats/schemas are intentionally left as an
  implementation decision for the planning/ticket stage rather than fixed
  here, per to-spec's guidance not to bake in details that may go stale — the
  minimum required content is listed under Implementation Decisions.
- This spec does not itself authorize implementation; per D27/D28, it needs
  explicit human acceptance, and `plan` needs separate ticket-breakdown
  acceptance (which may be combined with execution authorization in one
  instruction) before `implement` starts.
- No issue tracker or triage vocabulary is configured yet (RELEASE-SCOPE.md),
  so this spec was written to a project file (SPEC.md) instead of being
  published externally, per the instruction not to silently publish issues to
  an external tracker.
