# jflow release discovery

Updated: 2026-09-20
Status: interview stopped at the user's request to conserve usage. Scope consolidated in RELEASE-SCOPE.md; final shared-understanding confirmation is pending. D35-D37 were added on 2026-09-19 during a review of proposals from a second assistant; they change D3, D21 and the Jev scope recorded in D18 rather than editing those entries. D38-D42 were added on 2026-09-20 from the user's review of SPEC.md and RELEASE-SCOPE.md; they reframe the product around the LLM+Jev harness and widen Jev's role. D43-D50, from a grill the same day, resolve their collisions with D7, D10, D16, D18, D35 and D36. D51, also 2026-09-20, settles the skill/helper boundary. Nothing is open.

## Resume here

Read PROJECT-BRIEF.md, this file, and CONTEXT.md. Continue with grill-with-docs,
using grilling and domain-modeling. Investigate facts before asking questions.
Ask about one product decision at a time. Save accepted answers here immediately;
keep proposals and factual findings separate. Do not begin implementation.

Read RELEASE-SCOPE.md first for the consolidated handoff. The user asked to finish
soon because usage is limited. Do not restart the long interview or re-ask accepted
decisions. Remaining proposals are explicitly separated in that handoff.

The user rejected narrowing jflow to assistance carrying out an existing plan.
Workflow orchestration through the primary agent and compound learning are central
to the product. Compound learning is limited to project learning and must not
update workflow logic. The primary agent may coordinate steps within an authorized assignment
without the user invoking each skill. Workflows declare required roles and
delegation limits; the primary agent chooses optional assignments within them.
The primary agent may override Jev-assisted recommendations with recorded evidence
within workflow rules and authority, and involve the human when a conflict needs
their judgment. Escalate conflicts that require consequential human choices;
resolve ordinary technical disagreements through investigation. The first release
ships one package containing the user's custom workflow. Other workflows are a
future enhancement. Independent review is required for each ticket and for the
integrated plan result; a single-ticket plan can combine them. The default limit
is two unsuccessful fix-and-re-review attempts on the same blocking finding,
then human input. Astra is only an example; jflow must not depend on a specific
primary-agent model. The user's first host is GPT Desktop. Project files own plans,
tickets, progress, and lessons; tracker integrations are deferred. Resume reconciles
saved progress against actual work and verification evidence. After limited Jev
retries, ask the human before proceeding without Jev. Fallback approval covers the
current ticket or stage unless the human explicitly authorizes a broader scope.
The initial Jev judgment set is accepted. Stage workers use configured models;
the main conversational model remains unchanged between stages. Use only explicit
configured model fallbacks; otherwise ask the human. Evidence-backed project
lessons may be retained automatically, with scope, source links, and a visible
report. Jev receives bounded decision-specific evidence within project sharing
limits, excluding credentials and full-context uploads by default. Exact Jev traces
stay local and outside version control; project records contain summaries and trace
references. First-release customization is limited to supported settings of the
bundled workflow; arbitrary stages and method replacement are deferred. Next
prepare the specification from the consolidated handoff after confirmation.
The accepted actions are brainstorm, plan, implement,
troubleshoot, review, and wrap, with status, next, todo, and learn available
throughout. Brainstorm replaces the brief's former name what. Todo captures and
lists future work without automatically adding it to the active plan.
Brainstorm produces a specification requiring human acceptance before planning
creates implementation tickets.
The human accepts the ticket breakdown before implementation. Acceptance and
execution authorization are distinct but may be supplied in one instruction.
Implementation runs one ticket at a time, with bounded parallel agent work allowed
inside the current ticket. Concurrent implementation of separate tickets is deferred.
Under whole-plan authorization, a blocked ticket may be parked while independent
ready work continues after checking dependencies and partial edits.
Review requires a separate reviewer agent. Its model is configurable and may
match the implementation model; self-review never satisfies the review gate.
Confirmed requirement, correctness, and mandatory-standard violations block
completion; optional improvements go to todo. Disputes require evidence or escalation.

## Accepted baseline

The agreed direction and responsibility boundaries in PROJECT-BRIEF.md carry
forward. Its proposed first public release and candidate capabilities remain
proposals, not commitments.

The user explicitly requested a small, useful open-source release, investigation
before questions, one decision at a time, and durable records for fresh sessions.
Use AI Hero's workflow to turn the agreed discovery outcome into a specification
and tickets before implementation.

## Decision dependencies

1. First user and recurring problem.
2. Demonstrable outcome and smallest useful workflow, based on that problem.
3. Supported host and methods, based on the chosen workflow.
4. Configuration, authority, uncertainty, and recovery behavior for that scope.
5. Evaluation, distribution, licensing, and public claims.
6. Reconcile all decisions and obtain shared-understanding confirmation before
   moving to the specification and tickets.

Revisit this order when an answer changes the dependencies. It is an interview
guide, not an accepted release plan.

## Findings

- The project directory initially contained only PROJECT-BRIEF.md. There is no
  implementation to validate and no initialized Git repository.
- The installed grill-with-docs delegates to grilling and domain-modeling.
  Both dependencies were read. The user's one-at-a-time instruction takes
  precedence over grilling's default of asking a whole round of questions.
- Installed to-spec, to-tickets, implement, and code-review skill files exist.
  Their suitability as jflow workflow methods has not been assessed.
- Reading the installed to-spec and to-tickets revealed a later prerequisite:
  configure the issue tracker and triage vocabulary before invoking them.
  This does not block discovery.
- TypeSafe documents bounded selection among supplied candidates. Its
  [skill-suggestion example](https://docs.typesafe.ai/cookbooks/skill_suggestion)
  uses a shortlist followed by closer assessment and allows rejecting all skills.
  That vendor example uses Jev 1.12 and Claude Haiku 4.5; it does not validate
  jflow's host, primary agent, or workflow.
- [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
  include multi-hop reasoning, numeric precision, and sensitivity to irrelevant
  or adversarial context. These support the brief's boundary between bounded
  judgments and exact prerequisite or authorization checks.
- [Confidence guidance](https://docs.typesafe.ai/confidence) calls for testing
  thresholds on application data. No jflow routing advantage or useful confidence
  threshold has been established. Sources inspected on 2026-09-18.
- The installed AI Hero implement skill already calls for TDD where possible,
  code review, and committing work. The installed code-review requires a fixed
  Git reference and reviews committed changes against HEAD. A jflow configuration
  cannot assume these are independent steps with compatible handoffs merely
  because both skills exist. This is a local instruction inspection, not an
  execution test or a claim about all versions of these skills.

## Open proposals

- The proposed two-workflow release is superseded by D8: ship the user's custom
  workflow only. Other workflow packages are deferred.
- The opening hypothesis of selecting a skill for an already assigned action was
  too narrow. The user's answer includes deciding what comes next when a long
  plan departs from its expected flow.
- Withdrawn proposal after Q2: limit the release to carrying out an existing plan
  and defer specification and planning. The user rejected this framing and
  emphasized compound learning and agent orchestration. Exact lifecycle coverage
  still needs a decision; do not treat the proposed exclusions as accepted.

## Pending question

Final confirmation of RELEASE-SCOPE.md and its clearly labeled proposed defaults.
Do not treat the remaining defaults as accepted before confirmation. No more
individual discovery questions are planned unless a consequential contradiction
emerges. Publication-only decisions can wait until publication.

## Accepted decisions from this interview

### D1: User problem and desired experience

Source: user's answer to Q1, 2026-09-18.

During implementation of long plans, the user finds it difficult to know which
skill to run next, particularly when work does not follow the expected flow.
The user also wants jflow to handle when supporting skills should be invoked.

The desired experience is to use a workflow whose skills the community has
already tested and packaged, reducing the need to manage those choices manually.
This establishes the intended benefit. It does not establish that such community
packages exist, define what testing proves, or commit the first release to a
registry or marketplace.

The first-release boundary, supported deviations, and authority to continue
between actions remain open. No measurable routing improvement is claimed.

### D2: Orchestration and compound learning are central

Source: user's correction after Q2, 2026-09-18.

The user wants to converse with a primary agent such as Astra, which uses jflow
to execute the workflow. Agent orchestration of that workflow and compound
learning are part of jflow's intended value. Skill selection alone is an
incomplete description of the product.

Carry forward the brief's existing responsibility boundary: the primary agent
drives execution and delegation. This answer does not establish a separate
orchestration service or verify a particular host's capabilities.

The concrete meaning and first-release depth of compound learning, delegation,
and lifecycle coverage remain open. Define them before proposing scope cuts.

### D3: Compound learning is project learning only

Source: user's answer to Q3, 2026-09-18.

Retain project lessons for use in relevant later work. Do not use compound
learning to update workflow logic. The user rejected workflow improvement through
learning because those changes could make future runs behave unexpectedly.

This supersedes the assistant's recommendation to include proposals for changes
to reusable workflows in compound learning. Learning must not serve as an
indirect way to change workflow transitions or policy. The mechanism for selecting,
validating, storing, and applying project lessons is still undecided.

### D4: Coordinate steps within the authorized assignment

Source: user's acceptance of Q4, 2026-09-18.

When assigned a ticket, the primary agent may use jflow to coordinate the necessary
implementation, supporting skills and agents, diagnosis, review, and fixes without
requiring the user to invoke each skill. It returns when the ticket is complete or
a consequential decision needs the user's input, within existing authority.

Starting another ticket depends on the assignment: a single ticket does not
authorize the broader plan. A recommendation alone grants no additional authority.
Exact stopping conditions, retry limits, and delegation policy remain open.

### D5: Required roles and limits, discretionary optional delegation

Source: user's acceptance of Q5, 2026-09-18.

A workflow declares required agent roles and delegation limits. The primary agent
decides optional assignments within those constraints, such as using a debugging
agent or parallel workers when appropriate. Required roles remain mandatory.

These choices adapt execution to the current work without modifying workflow
logic. Exact roles, limits, host capabilities, and Jev's role in judging proposed
assignments remain to be specified.

### D6: Evidence-based overrides and human involvement for conflicts

Source: user's acceptance and extension of Q6, 2026-09-18.

The primary agent may choose a different permitted action from a Jev-assisted
recommendation when it records an evidence-based reason in the decision envelope.
It may not bypass required roles, prerequisites, or authorization.

The user also wants human involvement when needed, for example Astra asking the
human to resolve a conflict. Not every disagreement must interrupt the user.
The escalation boundary was subsequently settled in D7.

### D7: Escalate consequential conflicts, investigate technical disagreements

Source: user's acceptance of Q7, 2026-09-18.

Ask the human when resolving a conflict requires choosing or changing agreed
requirements, scope, workflow rules, or permissions. Explain the conflict and
recommend a resolution, then wait for the decision. For example, a review request
that contradicts the accepted specification requires reconciliation with the human.

The primary agent resolves ordinary technical disagreements when investigation
can settle them. It also asks when evidence remains inconclusive and the choice
materially affects the outcome.

### D8: One custom workflow package in the first release

Source: user's acceptance and clarification of Q8, 2026-09-18.

Ship one package containing the user's own custom development workflow. Adding
other workflows is a future enhancement. This supersedes the brief's proposal to
ship both native and adapted external-skill configurations.

The accepted direction covers defining work, planning, implementation, supporting
skills, agent orchestration, review, and project learning. Users may start with an
idea or existing work. The native workflow outline in PROJECT-BRIEF.md is the
starting candidate; exact methods and gates still need definition.

Retain the agreed JSON-defined workflow direction. Do not turn the earlier
suggestion of a configuration variation into a requirement to ship another
workflow. The minimum evidence for configurability remains to be settled.

AI Hero's workflow remains the process used to develop jflow. This decision does
not select AI Hero as the workflow jflow ships or establish external-skill support.

### D9: Independent review at ticket and integrated-plan levels

Source: user's acceptance of Q9, 2026-09-18.

Independent review is mandatory after each ticket and at the end of the plan.
Ticket review checks changes against the ticket's requirements. The final review
checks interactions between tickets and the overall acceptance criteria.

For a single-ticket plan, one independent review may cover both scopes. The
workflow should not repeat a review of identical scope merely to satisfy two
labels. Finding disposition, fix cycles, and reviewer independence requirements
still need definition.

### D10: Two unsuccessful fix-and-review attempts before escalation

Source: user's acceptance of Q10, 2026-09-18.

Use two unsuccessful fix-and-re-review attempts on the same blocking finding as
the configurable default limit. Then ask the human, presenting the unresolved
problem, attempted fixes, and recommended next step. Consequential conflicts
still require earlier escalation. The value is an accepted initial policy, not
an empirically validated optimum.

### D11: No dependency on a particular primary-agent model

Source: user's clarification alongside Q10, 2026-09-18.

Astra is only an example. Users should be able to use their choice of LLM as the
primary agent. Use model-neutral language in requirements and documentation.

This is a product requirement for model independence. It does not prove that every
model or host can execute the workflow correctly. Specify necessary host
capabilities and verify support before making compatibility claims.

### D12: Preferred model tiers

Source: user's response to Q11, 2026-09-18.

The user's preferred high-end models are Astra or Fable; preferred mid-tier
models are Sol or Sonnet. These are preferences, not an exclusive support list,
verified model identifiers, or an accepted automatic routing policy.

The host application was subsequently selected in D13. Investigate concrete model
availability and controls; do not infer those from model names.

### D13: GPT Desktop is the first intended host

Source: user's clarification of Q11, 2026-09-18.

Target the GPT Desktop app first. Keep model-neutral product requirements and
verify the actual local agent capabilities before claiming release compatibility.

Official documentation inspected on 2026-09-18:

- [Build skills](https://learn.chatgpt.com/docs/build-skills) documents standalone
  skills in the ChatGPT desktop app, skill directories with optional scripts,
  and plugin packaging for reusable distribution.
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  documents subagent workflows and local Codex delegation triggered by direct
  requests or applicable skill/AGENTS.md instructions. It distinguishes local
  Codex execution from hosted ChatGPT Work execution.

This session has demonstrated project-file reads/writes and delegated research.
That is partial feasibility evidence, not an end-to-end jflow compatibility test.
Host mode, model availability, helper execution, API access, installation, and
recovery still need verification. Do not assume the brief's illustrative /jflow
syntax is the exact desktop invocation syntax.

### D14: Project files are authoritative; defer tracker integrations

Source: user's acceptance of Q12, 2026-09-18.

Keep plans, tickets, progress, and project lessons in the project folder as the
authoritative record. A fresh conversation must be able to recover work from
those files without relying on prior chat history. Defer GitHub/Linear integration
from the first release.

Private API traces have a separate storage policy still to be defined. This
decision does not require committing all records to Git or storing credentials
in project files. Exact file formats and recovery checks remain open.

### D15: Reconcile actual work when resuming

Source: user's acceptance of Q13, 2026-09-18.

On every resume, reconcile saved progress with actual project files and relevant
verification evidence before continuing. Limit checks to affected work, preserve
existing edits, and run missing checks rather than trusting a completion claim or
restarting an entire ticket by default.

Consequential discrepancies, such as changed requirements, require human input.
The previous recommendation is not automatically valid after project state changes.

### D16: Human authorization required for Jev fallback

Source: user's correction of Q14, 2026-09-18.

Retry temporary Jev failures a limited number of times. If retries are exhausted,
ask the human driver before continuing without Jev. Do not automatically substitute
primary-agent judgment. Preserve the pending decision and failure record while
awaiting input.

This rejects the assistant's proposed automatic fallback. Approval duration and
the exact API retry limit remain open. The two-attempt fix-and-review limit is a
separate policy and does not determine the API retry count.

### D17: Scope fallback approval to the current ticket or stage

Source: user's acceptance of Q15, 2026-09-18.

Human approval to continue without Jev covers the current ticket or stage. Do not
ask again for every decision within that scope. Record the approval and keep
fallback status visible. Broader permission requires explicit human instruction.

Approval does not carry into unrelated work or change workflow rules. The precise
behavior when Jev becomes available again remains to be specified.

### D18: Initial Jev judgments and configurable models per stage

Source: user's acceptance and extension of Q16, 2026-09-18.

The first-release Jev judgments cover:

- Recommending the next eligible action and relevant supporting skills.
- Assessing proposed agent assignments for relevance and overlap.
- Assessing project lessons for retention and relevance to later work.

Defer automatic model/effort selection by Jev and scoring completion claims.
Required reviews, tests, and evidence checks remain separate.

The user explicitly requires the ability to use different models per stage.
Configured per-stage choices are in scope even though automatic Jev model
selection is deferred. D19 resolves those choices as applying to stage workers.

The [official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents),
checked on 2026-09-18, documents explicit subagent model and reasoning settings
for local Codex. This supports investigating stage workers with configured models;
it does not establish automatic main-conversation model switching or availability
of all preferred models in the chosen host. No host settings were changed.

### D19: Fixed conversational model, configurable stage-worker models

Source: user's acceptance and clarification of Q17, 2026-09-18.

Keep the main conversational model unchanged between stages. The primary agent
coordinates stage work delegated to agents using the configured stage models,
then integrates their results and communicates with the human.

Per-stage model selection applies to stage workers, not automatic switching of
the main conversation's model. Required independent review remains a separate
role. Exact worker configuration, context handoff, and unavailable-model behavior
remain to be specified.

### D20: Explicit configured worker-model fallbacks only

Source: user's acceptance of Q18, 2026-09-18.

If a configured stage-worker model is unavailable, use only a fallback explicitly
configured by the user. Otherwise ask the human. Do not silently substitute the
primary model or another available model.

Record the actual model used and preserve required roles, including independent
review. This is separate from Jev-outage fallback, which requires human approval
after limited retries as specified in D16 and D17.

### D21: Automatically retain evidence-backed project lessons

Source: user's acceptance of Q19, 2026-09-18.

The primary agent may save project lessons automatically when they have supporting
evidence, a clear scope, and no conflict with accepted decisions. Link the evidence
and report what was saved. Speculative lessons remain candidates; conflicts go to
the human.

Jev may assess usefulness and novelty, but its score alone does not establish
truth. Retained lessons cannot change workflow logic. Exact evidence criteria,
retrieval, and stale-lesson handling remain to be specified.

### D22: Bounded evidence sent to Jev

Source: user's acceptance of Q20, 2026-09-18.

Send only evidence relevant to the current Jev decision: task summaries, candidate
descriptions, and selected code or review excerpts, within project-configured
sharing limits. Exclude credentials. Do not send the full conversation or
repository by default.

A decision may require another request with additional permitted evidence.
Exact packet sizes, sharing controls, and trace-storage policy remain to be
specified. This decision does not authorize uploading excluded evidence.

### D23: Private local traces, portable project summaries

Source: user's acceptance of Q21, 2026-09-18.

Store exact Jev requests and responses locally, outside version control by default.
Keep concise decision summaries and trace references in project progress records.
Sharing detailed traces requires an explicit action.

A different machine can recover project progress from transferred/versioned
project records without having the detailed traces. Full local inspection requires
transferring those traces separately. Trace location, retention, and deletion
behavior remain open; version-control exclusion does not itself prevent backups
or other filesystem synchronization.

### D24: Settings-only customization for the initial package

Source: user's acceptance of Q22, 2026-09-18.

Keep the user's packaged workflow defined in JSON. In the first release, users
may customize supported settings such as stage models, explicit model fallbacks,
delegation limits, retry limits, and evidence-sharing controls.

Adding arbitrary stages or replacing workflow methods is deferred with future
workflow support. Validate the supported settings; do not promise a general
workflow engine in the first release. This narrows the original brief's broad
configuration ambition without removing JSON-defined workflows.

### D25: Accepted action set; brainstorm replaces what

Source: user's acceptance and rename in Q23, 2026-09-18.

The custom package exposes brainstorm, plan, implement, troubleshoot, review,
and wrap. Status, next, todo, and learn are available throughout. Rename what to
brainstorm; the user accepted the other proposed action names and purposes.

Users may ask conversationally or name an action. These are jflow entry points,
not a sequence of skill invocations the user must remember. Brainstorm investigates
and defines what to build; plan turns the agreement into a plan and tickets;
implement performs and verifies assigned work; troubleshoot diagnoses; review
independently assesses; wrap reconciles completion and preserves learning.

Detailed action contracts, including todo behavior, remain to be specified.

### D26: Todo is future work, not automatic scope expansion

Source: user's acceptance of Q24, 2026-09-18.

Todo captures and lists future work separately from the active plan. For example,
an unrelated bug discovered during implementation is saved with relevant context
while assigned work continues. Promoting the item into the active plan requires
an explicit decision; recording it alone does not authorize implementation.

### D27: Accept the specification before creating implementation tickets

Source: user's acceptance of Q25, 2026-09-18.

Brainstorm ends with a specification covering the problem, scenarios, acceptance
criteria, constraints, exclusions, and resolved decisions. The human accepts it
before plan creates implementation tickets.

Acceptance may be conversational and must be recorded. Planning then proceeds
within the user's assignment. This gate establishes the agreement that later
implementation and review use.

### D28: Accept the ticket breakdown and establish execution scope

Source: user's acceptance of Q26, 2026-09-18.

The human accepts the proposed ticket breakdown before implementation begins.
Acceptance of the plan and authorization to execute it are separate decisions,
but one instruction may provide both, for example "approved, implement the whole
plan" or "approved, implement ticket 1".

"Looks good" accepts the plan without expanding the assignment. Honor existing
explicit authorization to execute after acceptance rather than asking again
solely because the workflow has changed stages.

### D29: Sequential implementation tickets

Source: user's acceptance of Q27, 2026-09-18.

Implement one ticket at a time. Bounded parallel agent work may occur within that
ticket. Normally complete the ticket's checks, independent review, and required
fixes before starting the next eligible ticket. Whole-plan authorization allows
progression without asking between tickets.

Defer concurrent implementation of separate tickets. D30 defines the exception
for parked blocked tickets; parking never marks the ticket complete.

### D30: Park blocked work and continue independent authorized tickets

Source: user's acceptance of Q28, 2026-09-18.

Within an authorized plan, the primary agent may park a blocked ticket and proceed
with an independent ready ticket after reporting the blocker and asking any
required human question. Verify that the unresolved issue and partial edits will
not affect that next ticket.

The blocked ticket remains incomplete. If no independent work can safely start,
wait. This permits useful progress, not bypassing review, retry limits, or required
human authorization.

### D31: Configurable review; multiple-model access is not required

Source: user's response to Q29, 2026-09-18.

The user likes the proposed review feature but wants it configurable by the human,
not dependent on access to multiple models. Model diversity is not a prerequisite
for using jflow.

The assistant's Q29 proposal already allowed a separate reviewer to use the same
model as the implementer. D32 resolves the subsequent distinction: configuration
controls the reviewer model, not whether a separate reviewer is required.

### D32: Mandatory separate reviewer with configurable model

Source: user's clarification of Q30, 2026-09-18.

Review must use a separate reviewer agent. Never count self-review by the
implementing agent as satisfying the review requirement. The human configures
the reviewer model; it may be the same model used for implementation, so access
to multiple models is not required.

Use a fresh reviewer context containing the requirements, standards, changes,
and verification evidence, as proposed in Q29/Q30. The primary agent still
integrates findings and manages progress. Detailed review evidence and finding
disposition remain to be specified.

### D33: Blocking findings, advisory improvements, and disputed findings

Source: user's acceptance of Q31, 2026-09-18.

Confirmed violations of accepted requirements, correctness, or mandatory project
standards block completion. Optional improvements become todo items without
blocking the ticket or expanding the assignment.

Disputed findings require an evidence-backed resolution. Consequential conflicts
go to the human under the established escalation policy. Record the disposition
rather than silently ignoring a finding or implementing every suggestion.

### D34: Local commits after successful ticket review

Source: user's acceptance of Q32, 2026-09-18.

In a Git project, create a local commit after each ticket passes verification and
independent review. Enable this by default and make it configurable. Include only
the ticket's changes and relevant project records. Pushing, publishing, and merging
remain separately authorized actions.

### D35: Two memory kinds; harness observations are recorded and never applied

Source: user's acceptance during the 2026-09-19 review of a proposal by a second
assistant (Fable), reworked in that session. This decision **changes D3 and D21
rather than replacing them**. D3 and D21 remain the record of what was decided on
2026-09-18 and why; this entry records that the guarantee was narrowed, when, and
on what grounds. Do not edit D3 or D21 to match.

D3 and D21 gave an absolute guarantee that compound learning never changes workflow
logic. That was written before harness improvement had been designed, and it is
broader than what the project actually needs. It is narrowed here to a smaller but
stronger guarantee.

jflow keeps two kinds of memory, and never mixes them:

- **Project lessons.** Evidence-backed lessons about the project being built,
  retained automatically under D21's existing criteria.
- **Harness observations.** Records of how the workflow itself behaved: low-confidence
  answers, overrides, and repeated escalations.

Harness observations are recorded automatically and **applied never**. They are a
derived view over the trace records the Jev client and its failure handling already
persist, not a second memory store. Recording all of them is deliberate: they are
not filtered by Jev, because filtering the record of the system's own failures
through the system being judged would remove exactly the cases worth keeping.

Question files and policy files change only through a proposal that has been replayed
against recorded envelopes and explicitly accepted by the human. Nothing else may
change them, including the primary agent acting within existing authority.

This decision depends on the closed reason-code requirement being implemented. A
derived view over records that carry no labels is worth nothing, so if reason codes
are cut, this decision must be revisited rather than shipped hollow.

A `memory/<slug>/` layout is proposed for the two kinds, but is not implemented in
this release.

### D36: Jev stays advisory in the first release, and the release claims no routing improvement

Source: user's acceptance during the 2026-09-19 review, 2026-09-19.

A proposal to make one Jev judgment binding, specifically review finding disposition,
was **rejected**. It collided with three accepted decisions at once: D18 permits
exactly three judgments and disposition is not among them; D6 and the specification's
Jev integration boundary make every Jev output advisory with an override always
available; and disposition is out of scope as Jev completion and correctness scoring.
Finding disposition stays the deterministic rule D33 defines.

Jev therefore remains advisory throughout the first release. The release makes **no
claim that Jev improves routing**, and no demonstration should be read as evidence
that it does.

What the first release does demonstrate is narrower and testable: that decisions are
bounded, recorded in full, and reconstructable from their own records. Reconstructable
means the stored packet, the question and policy versions, the answer and the reason
code are together sufficient to rebuild the exact request without consulting chat
history or the live Jev service. That is an assertion about stored records. It is not
replay machinery, which is deliberately deferred.

Whether Jev earns its place is a **release-2 question**, answered by replaying recorded
envelopes against the corpus the first release builds. This gap must stay visible. It
is recorded in RELEASE-SCOPE.md's deferred list for that reason, and must not be closed
quietly by a later claim that the demonstrations show Jev working.

One judgment is made load-bearing to the extent D18 allows: next-action and skill
recommendation becomes the first worked example of the decisions and policy surface
D37 defines, with a threshold routing low-confidence answers to the human.

### D37: The workflow package declares decisions and policy, at schema version 2

Source: user's acceptance during the 2026-09-19 review, 2026-09-19.

PROJECT-BRIEF.md states that the configuration has two jobs, describing the process
and defining the judgments Jev makes within it. Only the first was built. The workflow
package gains two top-level keys to close that gap:

- `decisions`: a named decision maps to a question reference and a version.
- `policy`: a named decision maps to its thresholds and weights.

Question content lives in separate files under `workflow/questions/`, and policy
thresholds live in their own file separate from the question files, so changing a
threshold is a one-line diff.

This is a **schema version 2** change. The shipped validator and its version field
exist so that a released schema is not widened in place.

Two constraints attach to policy, and both exist because DISCOVERY.md already records
that no useful confidence threshold has been established and that thresholds must be
tested against application data the project does not yet have:

- Every policy entry **must** declare a `basis` field recording where its numbers came
  from. The first threshold ships as an uncalibrated placeholder pointing at D36, set
  conservatively so that it routes to the human readily. The requirement is schema-wide,
  not specific to the first entry, so that no future threshold can ship without
  declaring its provenance.
- **No test may assert a threshold's value.** Tests assert only that routing behaves
  correctly above and below it. A passing suite must never be readable as evidence that
  a number is correct.

Ownership is split. The package schema owns whether a question file is well-formed,
versioned and resolvable. The Jev judgment issue owns what the first question actually
asks, and that content reaches the human as a proposal for explicit acceptance under
the same gate D35 imposes on later changes. Exempting the founding question file from
that gate would hollow out D35 before it is written.

The decision is accepted; the corresponding change to the tracker issue that owns the
workflow package is a scope change and is proposed separately rather than folded in.

### D38: The product is the LLM+Jev harness; skill routing is one use case

Source: user's review comments on SPEC.md and RELEASE-SCOPE.md, 2026-09-20. This
decision **reframes D1 and extends D2** rather than replacing them. D1 stays as the
record of the first answer given; this entry records that it was the wrong emphasis.

"Losing track of which skill to invoke next" is an important use case but not the
main value. The main value is an optimised, efficient AI-agent harness built from
the combination of an LLM and Jev (TypeSafe Server One). LLMs are built to please
humans and produce human-facing content, not to make precise, repeatable decisions
at scale. Jev is built for exactly those decisions. Without Jev, jflow is just
another LLM workflow; the combination is the product.

The repeatable decisions the user names as Jev's territory: selecting the most
efficient model, knowing what to do next, validating and scoring output, escalating
to the human when needed, classifying content, and judging whether a session solved
a problem worth remembering.

Scope note, not a reversal: D18 defers automatic model/effort selection and
completion scoring, and D36 says the release claims no routing improvement. D38
sets the product vision and the spec's Problem Statement; it does not by itself add
judgments to the first-release set. D41 adds one. The rest of the list stays in the
vision and the deferred list until a later decision moves it.

### D39: Jev question and policy files improve from learnings, through proposals

Source: user's review comment 2 and clarification, 2026-09-20. This decision
**changes D35** rather than replacing it. Do not edit D35 to match.

Jev's output is only as good as its input questions, so the question files (and
the policy thresholds attached to them) should improve from learnings when the
evidence supports it. jflow helps with this the same way it helps improve
LLM-facing instructions such as AGENTS.md: it is a first-release capability, not
just a gate that later work might pass through.

What D39 keeps from D35: harness observations are still recorded automatically
and applied never; question and policy files still change only through a proposal
explicitly accepted by the human; the reason-code dependency still holds.

What D39 changes: generating such proposals is now an expected jflow behaviour,
derived from harness observations and project lessons. D35 required a proposal to
be replayed against recorded envelopes before acceptance, and D36 defers replay
machinery to release 2. Until replay exists, a proposal is accepted on its linked
evidence (the observations and envelopes that motivated it) rather than on a
replay result. Whether that weaker gate is acceptable for the first release is
open; see "Open for the next grill".

### D40: Minimise human approvals; Jev's escalation signal decides when to ask

Source: user's review comment 3 and clarification, 2026-09-20. This decision
**changes D36 and touches D6, D7 and D16**. Do not edit those entries to match.

Always aim to minimise human approvals. Seek human approval only when Jev's
response signals escalation. When Jev signals proceed, the primary agent proceeds
within its existing authority without asking.

What stays: D6's override (the primary agent may choose a different permitted
action with a recorded evidence-based reason); D7's consequential-conflict rule
(requirements, scope, workflow rules and permissions still go to the human); D16
and D17 (continuing without Jev at all still needs human approval, scoped to the
ticket or stage); acceptance gates D27 and D28. Jev never grants authorization.

What changes: D36 described Jev as advisory throughout, with the human-routing
threshold as the only load-bearing use. Under D40, Jev's escalate/proceed signal is
the default router for whether the human is asked. That is a binding use of a Jev
answer in the sense D36 rejected, though narrower than the disposition proposal it
rejected: it decides whether to interrupt the human, not what the work's outcome
is. The threshold and basis requirements of D37 apply to the escalation signal.
How this reconciles with D36's "no routing-improvement claim" is open; see "Open
for the next grill".

### D41: Every ticket is testable; Jev validates ticket output; escalate on unfixable failures

Source: user's review comment 4, 2026-09-20. This decision **changes D18 and
narrows D10**. Do not edit those entries to match.

Each ticket in a plan must be testable, with acceptance criteria whose outcome Jev
can validate. This extends the D28 plan-acceptance requirement and the ticket-sizing
mitigation recorded in SPEC.md: an untestable ticket is not an acceptable ticket.

Validating ticket output against its acceptance criteria becomes a fourth Jev
judgment. D18 deferred "scoring completion claims"; D41 admits the narrower form:
Jev judges whether the recorded verification evidence satisfies the ticket's
stated criteria. It still does not judge correctness in the abstract, and the
independent review (D9, D32) and exact prerequisite checks remain separate.

Human escalation during implementation happens when the LLM cannot solve a failed
test. D10's limit (two unsuccessful fix-and-re-review attempts, configurable) is
the concrete trigger for that. D7's consequential-conflict escalation is not
removed by this; a failed test is the normal escalation path, a scope conflict the
exceptional one. Whether the D10 counter should apply to failed tests as well as
blocking review findings, or get its own counter, is open.

### D42: Add a realign action for in-flight plan changes

Source: user's review comment 5, 2026-09-20. This decision **changes D25**. Do not
edit D25 to match.

Add `realign` to the action set. The human invokes it when they decide to change
the plan while implementation is in flight. It reconciles the accepted
specification, the ticket breakdown, and progress records with the human's new
direction: affected tickets are re-scoped, added, parked or withdrawn; completed
work is re-checked against the changed requirements; and the result is presented
for acceptance under D27/D28 before implementation continues. It does not itself
implement anything. The user's personal `workflow` skill already has a `realign`
verb, which is the reference behaviour.

`realign` is invoked by the human. The primary agent may recommend it (for
example when D15 resume or a review finds a consequential discrepancy) but may
not run it on its own authority, since its whole purpose is a human-driven change
to agreed scope.

### D43: Per-decision authority, declared in the package

Source: user's acceptance of grill Q1, 2026-09-20. This decision **resolves the
D40/D36 collision** and changes D36. Do not edit D36 to match.

Every `decisions` entry in the workflow package (D37) declares its authority:
`binding` or `advisory`.

- **Binding**: the workflow acts on Jev's answer directly. The only exceptions are
  D6's override (a different permitted action, with an evidence-based reason
  recorded in the decision envelope) and the hard rules that hold regardless of
  any Jev answer: D7 consequential conflicts, D16/D17 continuing without Jev, and
  the D27/D28 acceptance gates.
- **Advisory**: the primary agent weighs the answer alongside its own evidence.

The escalation signal (D40) ships binding. Next-action/skill recommendation,
assignment assessment and lesson assessment (D18) stay advisory in the first
release. The authority of D41's validation judgment is a separate decision.

D36's "advisory throughout" wording is superseded by this per-decision field.
D36's other content stands: the release makes no routing-*improvement* claim,
demonstrates only that decisions are bounded, recorded and reconstructable, and
leaves whether Jev earns its place to release-2 replay. Authority and improvement
are different claims; a binding decision is not evidence that it is a good one.

Nothing becomes binding by drift: authority is a declared package field with the
same `basis` requirement D37 puts on thresholds, changed only through the D35/D39
proposal gate. A fact checked before this question: the shipped package is still
schema version 1 with no `decisions` or `policy` keys, so D37's surface, and this
field, are unbuilt.

### D44: One general escalation question, split later from evidence

Source: user's acceptance of grill Q2, 2026-09-20. Defines the binding decision
D43 names.

The first release ships one declared decision, `escalate`, asked at every
human-facing boundary the workflow reaches: before starting the next ticket under
whole-plan authorization, after a fix attempt fails, when a review finding is
disputed, when a candidate lesson conflicts, at resume with a discrepancy, and
any other point where the workflow could ask the human. The question is "given
this situation packet, must the human be consulted before proceeding?" The answer
is `proceed` or `escalate`, with a closed reason code and a confidence. One
question file, one threshold, many call sites. The packet carries the boundary
kind so the answer is reconstructable (D36) and so later splitting is possible.

Splitting into per-boundary questions (`escalate.fix-loop`,
`escalate.review-dispute`, and so on) is the intended path once harness
observations show which call sites misroute. That split happens through D39
proposals, not by design up front. This is D39's first concrete job.

Hard rules never reach Jev and always ask: D7 consequential conflicts
(requirements, scope, workflow rules, permissions), D16/D17 continuing without
Jev, and the D27/D28 acceptance gates. They are not escalation call sites.

### D45: The first escalation threshold is conservative, lowered only by proposal

Source: user's acceptance of grill Q3, 2026-09-20. Applies D37's basis rule to
the D44 decision.

The `escalate` decision's first threshold is set conservatively: below-threshold
confidence routes to the human, and the threshold is high enough that Jev must be
clearly sure before `proceed` is honoured. The user accepts being asked more often
than D40 ultimately intends during the first release. Every over-ask is recorded
as a harness observation (D35), and the threshold is lowered through a D39
proposal once envelopes exist, not by guess.

The policy entry's `basis` field states this in full: an uncalibrated placeholder,
conservative per D37 and D45, to be lowered by proposal once a recorded corpus
supports it. No test asserts its value (D37).

Rejected alternatives: a permissive first threshold (fewer interruptions from day
one, but the mistakes worth learning from would be the unseen ones), and split
thresholds by boundary kind (a step toward D44's future split, taken too early).

### D46: Minimal replay ships in release 1 to gate proposals

Source: user's acceptance of grill Q4, 2026-09-20. This decision **changes D36's
deferral of replay machinery** and restores D35's gate in full. Do not edit D36
to match.

A question/policy proposal (D39) is accepted only after minimal replay: the
proposed question or threshold is re-run against the stored envelopes for that
decision, and the result reports how many answers would have changed and in
which direction, per boundary kind and reason code. The human accepts or rejects
on that report plus the linked observations.

Minimal means exactly this: load envelopes, call Jev with the proposed inputs,
diff the answers. It is not tuning, not scoring, and not a claim that the
proposal is better. Whether Jev improves routing remains a release-2 question
(D36); replay here gates a change, it does not evaluate Jev. The input side is
free because D36 already requires every envelope to be stored in full and
reconstructable without chat history or a live Jev call.

Cost accepted: one release-1 ticket and the Jev calls a replay burns. Rejected
alternatives: evidence-linked acceptance without replay (weakest exactly where
D45's threshold lowering needs it most) and no proposals in release 1 (leaves
D44's split and D45's lowering waiting for release 2).

### D47: Ticket validation is a binding judgment over criteria and evidence

Source: user's acceptance of grill Q5, 2026-09-20. Defines the judgment D41
added and sets its authority under D43.

The `validate` decision takes a bounded packet (D22): the ticket's acceptance
criteria as accepted under D28, and the recorded verification evidence (test
results, check outputs, the implementer's claim of what was done). Not the diff,
not the repository. It answers per criterion: `met`, `not-met` or
`insufficient-evidence`, with a closed reason code and a confidence.

Limits: it judges whether the evidence satisfies the stated criteria. It does not
judge code quality, requirements the criteria omitted, or anything the
independent review owns (D9, D32). All criteria `met` admits the ticket to
review; validation is the gate into review, never a replacement for it.

Authority: **binding**. `not-met` returns the ticket to fix. `met` on every
criterion admits it to review. `insufficient-evidence` means run the missing
check; if no such check exists, the `escalate` decision (D44) is asked. The
implementer's own "done" claim carries no weight on its own. D6's override
applies, so proceeding past a `not-met` requires an evidence-based reason in the
envelope; that friction is intended. This is the judgment where an LLM grading
its own work is least trustworthy (D38), so it is the one most worth binding.

### D48: One shared fix-attempt counter per ticket

Source: user's acceptance of grill Q6, 2026-09-20. This decision **widens D10**
from "the same blocking finding" to the ticket. Do not edit D10 to match.

Every unsuccessful fix attempt on a ticket increments one counter, whether the
failure was a `not-met` validation criterion (D47) or a blocking review finding
(D33). At the configured limit, default 2 as D10 set, the `escalate` decision
(D44) is asked with the attempts, the evidence and a recommended next step.

The unit that matters is the ticket: D41's framing is "the LLM cannot solve a
failed test", not which gate caught it. A per-ticket counter also yields the
cleanest harness observation ("tickets needing more than N fixes") for D39.
Accepted cost: two validation misses and one review finding reach the limit with
no review retry left. Rejected: independent counters per gate (up to four failed
attempts before escalation) and a counter keyed to each criterion or finding
(most faithful to D10's wording, most bookkeeping).

### D49: Model selection and content classification enter release 1, advisory

Source: user's acceptance of grill Q7, 2026-09-20. This decision **changes D18's
deferral of model/effort selection** and adds a judgment D36 kept out, in the
advisory form D43 permits. Do not edit D18 or D36 to match.

The first release declares seven Jev decisions. Five were settled earlier: next-action
(D18, advisory), assignment assessment (D18, advisory; omitted from the grill's
count of six by the assistant, never removed), escalate (D44, binding), validate
(D47, binding), and lesson retention (D18, advisory). Two more join, both advisory:

- **Model selection.** For a stage-worker assignment, Jev recommends a model and
  effort from the user's configured set for that stage, including its explicit
  fallbacks (D19, D20). Never a model outside that set. The primary agent may
  follow or override with a recorded reason (D6). D20's unavailable-model rule is
  unchanged: no silent substitution, ask the human when no configured fallback
  exists. The actual model used is still recorded.
- **Content classification.** Jev proposes a class for a piece of workflow
  content. Advisory only, so it does not displace D33's deterministic disposition
  rule; D36's rejection was of a *binding* disposition judgment, and D43 now makes
  authority a per-decision field. The set of classified content is settled in D50.

Accepted cost: seven question files, thresholds and calibrations from zero
envelopes. The user chose coverage of the D38 vision over a thinner first corpus.
Rejected: neither (four judgments), and model selection alone.

### D50: One classify decision covering item routing, lesson scope and testability

Source: user's acceptance of grill Q8, 2026-09-20. Completes D49.

The first release ships one advisory decision, `classify`, whose packet carries
the content kind, mirroring D44's boundary kind so it can be split later by D46
replay. Three content kinds:

- **Discovered item routing**: todo versus in-scope for the current ticket
  (D26). Today the primary agent decides alone.
- **Lesson scope**: which part of the project a candidate lesson applies to,
  feeding D21's clear-scope criterion and the applicability re-check.
- **Ticket testability**: whether a drafted acceptance criterion is validatable
  under D47. Runs inside `plan` before the breakdown is presented for D28
  acceptance; a criterion classed untestable is rewritten, not shipped.

**Excluded: review finding disposition.** D33's deterministic rule stands alone.
Even advisory Jev classification beside it would invite the LLM to argue the
rule down, and D36 rejected a Jev disposition judgment on grounds that still
hold. Disagreement is not a harness observation here because there is no Jev
answer to disagree with.

### D51: Skills carry the methods; a bundled helper carries the exact parts

Source: user's question during implementation of issue #1 and acceptance of
the assistant's recommendation, 2026-09-20. Answers PROJECT-BRIEF.md's open
question "Which behavior remains in the agent's skill instructions?", which no
earlier decision covered. TICKETS.md and issue #1 chose TypeScript and Vitest
as the stack without recording where code stops and skill instructions start;
issues #5-#22 were written as if every action were software.

jflow ships as a **skill**: a directory of instructions with a bundled script,
the packaging the target host documents. The user's reason is adoption: jflow
is to be open-sourced, and a skill lowers the bar to use it.

- **Skills carry the methods.** One `jflow` skill with per-action instruction
  files supplies how to brainstorm, plan, implement, review, wrap and realign,
  how to present results to the human, and when to run the helper. The
  primary agent reads them. They are verified by execution on the host, not by
  unit tests.
- **The helper carries the exact parts.** A small command-line helper the
  skill shells out to: validate the package and configuration, read and write
  project records, resolve prerequisites and authorization, call Jev and store
  envelopes and traces, apply the `validate` and `escalate` outcomes, hold the
  per-ticket fix counter, run replay, and create the local commit. These are
  the precise, repeatable decisions D38 says the LLM is bad at, so they live in
  code. PROJECT-BRIEF.md already said "use code for exact computations and
  established prerequisites."

The workflow-action-contract test seam tests the helper: project records plus
a request in, eligible, blocked or ask-the-human out. Each action issue has two
deliverables, its instruction file and the helper commands it relies on, and
the release demonstrations split the same way: helper behaviour as automated
tests, primary-agent behaviour as a recorded host run.

Rejected: skills plus a minimal Jev-call script, with counters, envelopes and
gating kept in instructions. That returns the repeatable decisions to the LLM,
the problem the product exists to remove. Consequence accepted: the helper
needs a runtime on the host; how it is bundled for distribution is decided
with the deferred packaging questions, not here.

Grill closed 2026-09-20: D43-D50 settle every item in the list below.

### Open for the next grill

Added 2026-09-20; all items settled the same day.

1. ~~D39 vs D35/D36~~: settled by D46 (minimal replay in release 1).
2. ~~D40 vs D36~~: settled by D43, D44, D45.
3. ~~D41 vs D18/D10~~: settled by D47 and D48.
4. ~~D38's remaining Jev territory~~: settled by D49 and D50.

1. ~~D39 vs D35/D36~~: settled by D46 (minimal replay in release 1).
2. ~~D40 vs D36~~: settled by D43, D44, D45.
3. ~~D41 vs D18/D10~~: settled by D47 (binding validation) and D48 (shared
   per-ticket counter).
4. D38's remaining Jev territory (model selection, content classification,
   "worth remembering" as a distinct judgment): which of these, if any, move
   into release 1?

### Specification accepted

2026-09-20: the human accepted SPEC.md as revised for D38-D50, satisfying the
D27 gate. D28 (ticket breakdown acceptance and execution authorization) is not
yet satisfied for the revised scope: GitHub issues #1-#24 and TICKETS.md
predate D38-D50, and issue #17 in particular still describes three advisory
judgments.

### Ticket breakdown accepted

2026-09-20: the human accepted the revised ticket breakdown, satisfying the
acceptance half of D28. Issues #2, #17, #8, #9 were revised in place (schema
version 2; seven decisions with per-decision authority and the decision
envelope; the validate gate and the shared per-ticket fix counter), #6, #12,
#19, #22 and #23 received smaller updates, and #25-#31 were added: escalate,
validate, minimal replay, model-selection, classify, question-file proposals
and realign. Execution authorization has not been given. Accepted choices:
#8 waits for #25 and #26 rather than shipping with a placeholder gate; each
decision issue proposes its own question wording for acceptance under D37;
#29 keeps all three classify call sites in one issue.

### Session handoff

The user asked to finish soon because remaining usage is limited. Consolidate
accepted decisions and distinguish unresolved defaults rather than extending the
interview. RELEASE-SCOPE.md is a discovery handoff, not an approved specification
or authorization to implement. Preserve D1-D50 when producing the specification.
