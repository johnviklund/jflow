# jflow first release: discovery handoff

Date: 2026-09-18, updated 2026-09-20
Status: accepted decisions consolidated; D38-D50 applied; nothing open. The
specification awaits acceptance under D27.

Read this first when resuming. DISCOVERY.md contains the detailed decision record
D1-D50 and research sources. CONTEXT.md contains vocabulary. PROJECT-BRIEF.md
preserves the initial direction; later accepted discovery decisions supersede its
original release proposals. No implementation has started.

## Problem and release promise

Updated 2026-09-20 per D38. jflow is an AI-agent harness built from the
combination of an LLM and Jev (TypeSafe Server One). LLMs are built to please
humans and produce human-facing content, not to make precise, repeatable
decisions at scale; Jev is built for those. Without Jev this is another LLM
workflow; the combination is the product. Knowing which skill to invoke next,
especially when work departs from the expected sequence, is one important use
case within that, not the whole value.

jflow lets the user stay in one conversation while their primary agent
coordinates a packaged workflow, uses Jev for the bounded, repeatable decisions
the workflow declares, asks the human only when the rules or Jev's escalation
signal require it, delegates stage work, preserves project learning, improves
its own Jev questions through human-accepted proposals, and keeps recoverable
project records.

Ship one package containing the user's custom development workflow. Other
workflows are a future enhancement. GPT Desktop is the first intended host;
end-to-end compatibility still needs verification. The primary-agent model is
not fixed by jflow. Astra/Fable and Sol/Sonnet are the user's preferred model tiers,
not a verified availability list or exclusive support requirement.

## Accepted release scope

- Actions: brainstorm, plan, implement, troubleshoot, review, wrap, and realign
  (D42). Status, next, todo, and learn are available throughout. Support
  conversational requests and explicit action selection. Exact host invocation
  syntax must be verified.
- Brainstorm produces a specification for human acceptance. Plan produces tickets
  for human acceptance. Acceptance and execution authorization are distinct;
  one instruction can provide both. Honor existing explicit authorization.
- Every ticket carries acceptance criteria whose outcome Jev can validate from
  recorded verification evidence; plan does not emit a ticket without them (D41).
- Realign is human-invoked: when the human changes the plan mid-implementation,
  it reconciles spec, tickets and progress with the new direction and re-enters
  the acceptance gate. The agent may recommend it, never run it unasked (D42).
- Minimise human approvals. Ask the human when Jev's binding `escalate` decision
  says so, or when a hard rule applies (consequential conflict, continuing
  without Jev, an acceptance gate); otherwise proceed within existing authority
  (D40, D43, D44). The first threshold is conservative and lowered only by a
  replayed proposal (D45, D46).
- The primary conversational model remains unchanged between stages. Stage
  workers use configurable models. Workflow rules specify required roles and
  delegation limits; the primary agent chooses optional assignments within them.
- Implement one ticket at a time, permitting bounded parallel work within it.
  Under whole-plan authorization, continue eligible tickets without repeated
  permission. Park blocked tickets and continue independent ready work only when
  dependencies, unresolved decisions, and partial edits permit it.
- Review every ticket and the integrated plan result. A single-ticket plan can
  combine both scopes. A separate reviewer is mandatory; its model is configurable
  and may match the implementer. Self-review never satisfies the gate.
- Confirmed requirement, correctness, and mandatory-standard violations block
  completion. Optional improvements go to todo. Resolve disputed findings with
  evidence or escalate consequential conflicts to the human.
- After two unsuccessful fix-and-review attempts on the same blocking finding,
  ask the human with evidence and a recommendation. This default is configurable.
  A failed validation criterion counts on the same per-ticket counter as a
  blocking finding, so the limit is per ticket, not per gate (D41, D48).
- Create a local commit after a ticket passes checks and review, enabled by
  default and configurable. Include only its changes and relevant project records.
  Pushing, publishing, and merging need separate authorization.
- Todo captures future work without adding it to the active plan automatically.
- Compound learning retains project lessons only. Automatically retain lessons
  supported by evidence, with clear scope, source links, and a visible report.
  Speculation stays a candidate; conflicts with accepted decisions go to the human.
  Project lessons never modify workflow logic. Narrowed by D35: harness
  observations (low-confidence answers, overrides, repeated escalations) are
  also recorded automatically, as a derived view over existing trace records,
  and are applied never. Question and policy files change only through a
  human-accepted proposal. Generating those proposals from harness observations
  and project lessons is a first-release capability (D39): Jev's output is only
  as good as its questions, so the questions should improve for this repo, like
  AGENTS.md does. Minimal replay (re-run the proposal against stored envelopes,
  report which answers would change) ships in release 1 and gates every
  proposal before the human sees it (D46).
- Keep authoritative plans, tickets, progress, and lessons in project files.
  On resume, reconcile them with actual work and relevant verification evidence.
  Preserve partial work and run missing checks rather than restarting by default.
- Keep the package JSON-defined. User customization initially covers supported
  settings such as stage models, explicit fallbacks, delegation/retry limits, and
  evidence-sharing controls. Arbitrary stages and method replacement are deferred.

## Jev's accepted role and boundaries

The first release declares seven Jev decisions, each with a declared authority
in the workflow package (D43): `next-action` (advisory), `assignment`
(advisory, D18), `lesson-retention` (advisory), `escalate` (binding, D44), `validate` (binding, D47),
`model-selection` (advisory, from the configured set only, D49) and `classify`
(advisory: discovered-item routing, lesson scope, ticket testability; never
review finding disposition, D50). Exact prerequisites and authorization are
checked separately. Jev never grants authorization and its scores do not prove
correctness in the abstract.

Binding means the workflow acts on the answer; advisory means the primary agent
weighs it. In both cases the primary agent may choose a different permitted
action only with a recorded, evidence-based reason within the workflow and
existing authority (D6). Hard rules never reach Jev and always ask: consequential
conflicts involving requirements, scope, workflow rules, or permissions (D7),
continuing without Jev (D16/D17), and the acceptance gates (D27/D28).

Every threshold and every authority carries a declared basis (D37). The
`escalate` threshold ships conservative (D45); `validate` is the gate into
review, never a replacement for it (D47).

After limited retries for temporary Jev failures, ask before continuing without
Jev. Human fallback approval covers the current ticket or stage unless explicitly
broadened. Record it and keep fallback status visible. Separately, an unavailable
worker model may use only an explicitly configured fallback; otherwise ask.

Send Jev bounded decision-specific evidence within project sharing limits:
summaries, candidates, and selected excerpts. Exclude credentials and full
conversation/repository uploads by default. Preserve exact requests and responses
locally outside version control. Project files retain concise summaries and trace
references. Detailed trace sharing is explicit; another machine can recover
progress without those traces, but cannot inspect their full contents.

Carry forward the brief's request-before-call, response-before-interpretation,
versioned inputs, failure recording, and appended outcome requirements.

## Deferred

Other workflow packages; general workflow editing and method replacement;
GitHub/Linear integration; concurrent implementation of separate tickets;
abstract correctness scoring and review-disposition classification by Jev
(validation against stated criteria, model selection from the configured set,
and the three D50 content kinds are in scope); binding authority for any
decision beyond `escalate` and `validate`; tuning or evaluation machinery
beyond minimal replay; workflow changes through learning; automatic
main-conversation model switching.

Also deferred, and deliberately left visible rather than closed quietly (D36):
**whether Jev improves routing at all.** The first release makes no
routing-improvement claim. What it demonstrates is that decisions are bounded,
recorded in full, and reconstructable from their own records. Whether Jev earns
its place is a release-2 question, answered by replaying recorded envelopes
against the corpus the first release builds. Replay and tuning machinery are
themselves deferred. No first-release demonstration may be presented as
evidence that Jev routes better than the stated rules or ordinary primary-agent
judgment. D43 (2026-09-20) supersedes D36's "advisory throughout" wording with
a per-decision authority field; D36's improvement stance is untouched, because
a binding decision is not evidence that it is a good one.

Compound learning is narrowed rather than simply deferred (D35, D39, D46):
project lessons still never change workflow logic, harness observations are
recorded but applied never, and question and policy files change only through a
human-accepted proposal gated by minimal replay. Generating those proposals and
replaying them are in scope; evaluating Jev with them is not.

## Grill of 2026-09-20

D38-D42 reopened four 2026-09-19 decisions; D43-D50 settled all of them the
same day. See DISCOVERY.md. Nothing is open.

## Proposed defaults, not yet accepted

These close remaining behavioral gaps without expanding the release. The user
requested a short finish, so confirm these together rather than restart discovery.

- Use a local Git repository for implementation and review in the first release.
  Brainstorm and planning may precede Git setup. Never initialize, discard, or
  absorb pre-existing changes silently; pause affected work when ownership is
  unclear. Diagnose and review do not edit code themselves; an authorized
  implementation/fix action handles edits.
- Validate configuration and required host capabilities before execution. Show
  missing models/tools and actionable setup errors; do not silently weaken gates.
  Project settings cannot disable the accepted separate-review requirement.
- Retry a temporary Jev failure twice after the initial attempt, using backoff
  and a finite timeout. Authentication or invalid-request errors are surfaced
  immediately. This retry count is separate from the accepted review-fix limit.
- Treat uncertain or unusable Jev answers as requiring primary-agent evidence
  assessment, with a recorded resolution and the existing human escalation rules.
  Keep missing-service fallback subject to explicit human approval. Return to
  normal Jev use at the next decision boundary after recovery, recording the change.
- Keep raw traces until explicit local cleanup in the initial release. No automatic
  deletion, export, or upload. Preserve portable summaries after trace cleanup.
- Recheck a retained lesson's applicability before use. Mark contradicted lessons
  superseded with evidence; do not silently overwrite accepted human decisions.
- Wrap reconciles outcomes, unresolved todos, and lessons and leaves a resume
  record. It does not automatically push, merge, publish, or destructively clean up.

## Specification and validation work still needed

Use AI Hero's to-spec, then to-tickets, before implementation. The installed skills
need a configured tracker and triage vocabulary. A local-file setup is consistent
with the release direction but has not yet been configured for building jflow.
Do not silently publish issues to an external tracker.

The specification should turn the accepted behavior into precise action contracts,
record formats, workflow transitions, configuration validation, evidence rules,
and acceptance criteria. Choose implementation details there rather than asking
the user to design file formats. Preserve the distinction between decisions and
proposals. Fetch relevant current documentation when implementing integrations.

Proposed release demonstrations and tests:

1. Idea to accepted specification and plan, followed by authorized implementation
   of multiple tickets, ticket reviews, and integrated review.
2. A failed check invokes diagnosis/fixes; blocking review findings trigger
   re-review; two unsuccessful attempts request human input.
3. A blocked ticket is parked and genuinely independent work proceeds without
   losing the blocker or expanding authorization.
4. A fresh conversation reconciles interrupted work and continues from files.
5. Configured worker models and a separate reviewer are used and recorded;
   unavailable models obey explicit fallback policy.
6. Jev outage requires human-approved fallback; conflicting recommendations and
   uncertain answers produce inspectable decisions.
7. A verified lesson is retained and used in a later relevant task without changing
   workflow logic; an unrelated discovery remains a todo item.
8. Invalid configuration, excluded evidence, and missing review evidence cannot
   silently pass. Raw traces remain outside version control.
9. A `proceed` answer within authority asks nothing; `escalate` asks; a hard
   rule asks without consulting Jev (D40, D44).
10. Plan rejects a ticket without acceptance criteria; `validate` returns a
    not-met ticket to fix and admits an all-met ticket to review; the per-ticket
    counter escalates at the limit whichever gate caught the failure (D41, D47,
    D48).
11. A mid-implementation realign re-scopes affected tickets, re-checks completed
    work, and re-enters acceptance without losing records (D42).
12. A harness-observation pattern yields a question-file proposal with linked
    evidence and a replay report from stored envelopes; nothing changes until
    the human accepts (D39, D46).
13. A binding answer is acted on directly and only a recorded reason gets past
    it; an undeclared authority fails validation (D43).
14. A model recommendation outside the configured set is rejected; `classify`
    never receives a review finding (D49, D50).

Measure Jev-assisted choices against rules and ordinary primary-agent judgment
before making improvement claims. Do not claim universal host/model support,
lower cost, or more accurate routing without evidence.

License, GitHub owner, and distribution packaging must be decided before public
publication. They do not require another interview before producing a draft spec.
