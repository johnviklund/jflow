# jflow first release: discovery handoff

Date: 2026-09-18
Status: accepted decisions consolidated; proposed defaults await confirmation.

Read this first when resuming. DISCOVERY.md contains the detailed decision record
D1-D34 and research sources. CONTEXT.md contains vocabulary. PROJECT-BRIEF.md
preserves the initial direction; later accepted discovery decisions supersede its
original release proposals. No implementation has started.

## Problem and release promise

Developers carrying out long plans struggle to know which skills to invoke next,
especially when work departs from the expected sequence. jflow lets the user stay
in one conversation while their primary agent coordinates a packaged workflow,
uses Jev for bounded judgments, delegates stage work, preserves project learning,
and keeps recoverable project records.

Ship one package containing the user's custom development workflow. Other
workflows are a future enhancement. GPT Desktop is the first intended host;
end-to-end compatibility still needs verification. The primary-agent model is
not fixed by jflow. Astra/Fable and Sol/Sonnet are the user's preferred model tiers,
not a verified availability list or exclusive support requirement.

## Accepted release scope

- Actions: brainstorm, plan, implement, troubleshoot, review, and wrap. Status,
  next, todo, and learn are available throughout. Support conversational requests
  and explicit action selection. Exact host invocation syntax must be verified.
- Brainstorm produces a specification for human acceptance. Plan produces tickets
  for human acceptance. Acceptance and execution authorization are distinct;
  one instruction can provide both. Honor existing explicit authorization.
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
  human-accepted proposal replayed against recorded envelopes.
- Keep authoritative plans, tickets, progress, and lessons in project files.
  On resume, reconcile them with actual work and relevant verification evidence.
  Preserve partial work and run missing checks rather than restarting by default.
- Keep the package JSON-defined. User customization initially covers supported
  settings such as stage models, explicit fallbacks, delegation/retry limits, and
  evidence-sharing controls. Arbitrary stages and method replacement are deferred.

## Jev's accepted role and boundaries

Jev recommends eligible actions and supporting skills, assesses proposed agent
assignments for relevance and overlap, and assesses lessons for retention and
later relevance. Exact prerequisites and authorization are checked separately.
Jev scores do not prove correctness or completion.

The primary agent may override a Jev-assisted recommendation with a recorded,
evidence-based reason within the workflow and existing authority. Ask the human
about consequential conflicts involving requirements, scope, workflow rules, or
permissions, and consequential choices that evidence cannot settle.

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
automatic Jev model/effort selection; Jev completion scoring; workflow changes
through learning; automatic main-conversation model switching.

Also deferred, and deliberately left visible rather than closed quietly (D36):
**whether Jev improves routing at all.** Jev stays advisory for the whole first
release, which therefore makes no routing-improvement claim. What the release
demonstrates is that decisions are bounded, recorded in full, and
reconstructable from their own records. Whether Jev earns its place is a
release-2 question, answered by replaying recorded envelopes against the corpus
the first release builds. Replay and tuning machinery are themselves deferred.
No first-release demonstration may be presented as evidence that Jev routes
better than the stated rules or ordinary primary-agent judgment.

Compound learning is narrowed rather than simply deferred (D35): project
lessons still never change workflow logic, harness observations are recorded
but applied never, and question and policy files change only through a
human-accepted proposal replayed against recorded envelopes.

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

Measure Jev-assisted choices against rules and ordinary primary-agent judgment
before making improvement claims. Do not claim universal host/model support,
lower cost, or more accurate routing without evidence.

License, GitHub owner, and distribution packaging must be decided before public
publication. They do not require another interview before producing a draft spec.
