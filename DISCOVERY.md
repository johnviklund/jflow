# jflow release discovery

Updated: 2026-09-18
Status: interview stopped at the user's request to conserve usage. Scope consolidated in RELEASE-SCOPE.md; final shared-understanding confirmation is pending.

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

### Session handoff

The user asked to finish soon because remaining usage is limited. Consolidate
accepted decisions and distinguish unresolved defaults rather than extending the
interview. RELEASE-SCOPE.md is a discovery handoff, not an approved specification
or authorization to implement. Preserve D1-D34 when producing the specification.
