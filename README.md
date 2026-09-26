# jflow

A JSON-defined workflow package that a primary conversational agent loads to
run one custom development workflow end to end.

See `SPEC.md` for the first-release specification, `TICKETS.md` for the
current ticket breakdown, and `CONTEXT.md` for project vocabulary.

## Status

Release-1 issues #1–#22 and #25–#31 are implemented, and #23's helper side (TICKETS.md T1–T5 decompose #1 and #2). #23's instruction side and #24, the host spike, need runs on the host that have not been made. The foundation:

- `workflow/jflow.workflow.json` — the single shipped workflow package
  (schema version 2): the action set, per-action roles, delegation limits,
  Git and code-edit rules, prerequisites, the supported configuration
  surface, and the seven declared Jev decisions with their `authority`,
  `basis` and policy thresholds (D37, D43).
- `workflow/questions/` — one question file per declared decision, each
  with a closed answer set and a closed reason-code set. The package checks
  that they resolve and are well-formed. Wording moves from `skeleton` to
  `proposed` to `accepted`, and accepted wording records when and in what
  words the developer accepted it. The developer accepted the wording each
  decision's issue proposed (#17, #25, #26, #28, #29); all seven are
  accepted, and change only through a question-file proposal (#30).
- `src/workflow/` — workflow package types, loading, and validation;
  `policy.ts` routes an answer above or below a declared threshold without
  any code or test treating the number itself as correct.
- `src/config/` — configuration validation, defaults, and Jev API key
  resolution.
- `src/actions/` — workflow-action-contract resolution: workflow state in,
  eligible/blocked decision out. `status` is the first action that runs end
  to end, reading the state from project files.
- `src/project/` — the authoritative record store (issue #3): one JSON file
  per record kind under `jflow/` — `specification` and `plan` (each owns
  its acceptance gate), `tickets`, `progress` (authorization), `lessons`,
  `jev` (fallback status: off, awaiting approval with the pending decision
  kept, or approved for a recorded scope), `resume` and `todos` — read and written
  through `readRecord`/`writeRecord`. Schemas are closed, so a raw Jev trace
  has no field of its own; a credential-looking key or value is refused on
  write; each write goes through a temporary file and rename; a malformed
  record is reported with the offending paths and never read as empty. `state.ts` derives the resolver's `WorkflowState`
  from the `progress` record (Git presence is observed from `.git`, never
  recorded).
- `src/validation.ts` and `src/secrets.ts` — the shared issue collector and
  field validators, and the one definition of what counts as a credential,
  used by the package loader, configuration and the record store.
- `src/actions/request.ts` and `dispatch.ts` — a request (an action name or
  a sentence) resolves to exactly one action or to a clarifying question;
  dispatch checks its prerequisites against the records and reports the
  action `ready` for the skill's method, or runs it when the helper owns it
  (issue #4).
- `src/actions/specification.ts` — the helper side of `brainstorm` (issue
  #5): write a specification as awaiting acceptance, record the developer's
  decision on each proposal, record explicit acceptance; `plan` stays
  refused until then, and an accepted specification is never rewritten
  (that is `realign`).
- `src/actions/plan.ts` — the helper side of `plan` (issue #6): write the
  ticket breakdown (refused without an accepted specification, for a
  ticket without acceptance criteria, or for a dependency cycle), record
  plan acceptance, and record execution authorization as a separate fact
  that the same instruction may grant — "looks good" accepts only. The plan
  is accepted only after the specification it rests on, and `plan write`
  never replaces a realigned breakdown awaiting acceptance.
- `src/actions/implement.ts` — the helper side of `implement` (issue #8).
  `implement start` starts exactly one ticket under recorded execution
  authorization: the authorized ticket, or the named one under whole-plan
  authorization, with its dependencies done and no other ticket in
  progress. It reports the stage's delegation limits for parallel sub-work.
  `implement check` records the ticket's check output under
  `.jflow/evidence/` in the form `validate` consumes, asks `validate`, and
  keeps the ticket's one fix counter (`progress.fixAttempts`, D48). The
  ticket's first failure only returns it to fix; each later one is an
  unsuccessful fix attempt. At `review.fixRetryLimit` (default 2)
  `escalate` is asked at `fix-failed` with the attempts, evidence and the
  agent's recommendation. `countUnsuccessfulFix` is the same counter for
  review's blocking findings (#9). The evidence file's `workers` records
  the sub-agents that worked on the ticket (`progress.implementers`).
  Nothing here commits or marks a ticket done.
- `src/actions/review.ts` — the helper side of `review` (issue #9). The
  `ticket.admittedToReview` prerequisite reads the assigned ticket's
  latest validation, so `review start` refuses a ticket until `validate`
  has found every criterion met. It returns the reviewer's fresh context
  and the review stage model. `review record` refuses a reviewer that is
  the primary agent or a recorded worker, whatever its model. It disposes
  of each finding by D33's fixed rule and never asks Jev to classify one.
  Requirement, correctness and standard findings block. An improvement
  becomes a todo. A dispute is withdrawn on recorded evidence. Otherwise
  it is asked of `escalate` at `review-dispute`, or, when consequential,
  raised as a conflict for the developer without Jev. A review that returns
  the ticket to fix clears its validation and counts on the shared fix
  counter. `review decide` records the developer's ruling on a dispute.
  The latest review is kept in `progress.reviews`.
- `src/jev/fallback.ts`, `assessment.ts` — Jev failure and fallback
  (issue #18, D16, D17). `askDecision` retries a temporary failure
  `jev.retryCount` times (default 2) with doubling backoff and the finite
  `jev.timeoutMs`. It never retries an authentication or invalid-request
  error. A decision still unanswered sets the fallback to
  `awaiting-approval` with the pending decision. `jev approve` records the
  developer's approval for the ticket in progress, one stage, or the whole
  plan when they broaden it. `status` shows the fallback. The next answer
  returns to normal use, and every change is logged in the Jev record's
  history. `jev assess` records the primary agent's evidence assessment
  where an answer was not relied on, or was missing for the failure on
  record under an approved fallback. A consequential case, or any binding
  decision, goes to the developer. The retry count is separate from `review.fixRetryLimit`.
- `src/actions/workers.ts` — stage workers (issue #15, D18-D20). `worker
  assign` records a worker before it runs in `jflow/workers.json`: its
  stage, declared role, agent and the model reported for it. The helper
  cannot observe the host, so it enforces that only a configured model is
  ever reported. The
  model must be the stage's configured one, or, when that is reported
  unavailable, the explicitly configured fallback, recorded as a
  substitution. With neither configured it asks and records nothing. It
  refuses a role the stage does not declare, more active workers within
  one ticket than the stage's delegation limits allow, and the primary
  agent, whose model jflow never switches. Recorded workers count as a
  ticket's implementers, so none of them reviews it. A test keeps the skill, the workflow package, the
  README and the helper's usage free of specific model names.
- `src/actions/model-selection.ts` — Jev's advisory `model-selection`
  (issue #28, D49). `worker recommend` builds the options from what the
  stage may run now: its configured model, or only its configured
  fallback when the host reported the model unavailable (D20), at each
  effort in `stageModels.<stage>.efforts`; with no efforts there is one
  option and nothing to ask. It asks Jev with those options
  as the only choices, beside `no-recommendation`. An answer outside them
  is rejected and recorded in the workers record, and no worker starts on
  it. It is not a Jev outage. `worker assign` with `selection` records
  following the recommendation, or setting it aside with a reason and
  evidence, on its envelope, plus the effort and envelope on the
  assignment. The envelope must be for the same stage, role and ticket,
  unused, and hold a recommendation. The choice is written only once the
  assignment is known to be valid. Where efforts are configured, an
  assignment needs one of them. Replay keeps each envelope's own options.
- `src/actions/plan-review.ts` — the integrated review of a plan (issue
  #13, D9). `planCompletion` holds a multi-ticket plan incomplete until
  every ticket is done or withdrawn and an integrated review has passed.
  `implement next` returns `needs-plan-review` until then, and `next`
  recommends it. `review plan start|record|decide` reuses ticket review's
  finding rule, dispute handling and reviewer check, against the
  implementers of every ticket. A blocking finding holds the plan and asks
  the developer, since the fix is new work in the plan. A one-ticket
  plan's passing ticket review is recorded as the plan review too
  (`progress.planReview`, scope `single-ticket`), and no second review is
  taken. A plan review counts only while the tickets it covered are the
  plan's tickets. A blocked plan takes a new review only after the
  tickets change, or once the developer withdraws the finding in their
  words.
- `src/actions/progression.ts`, `independence.ts` — whole-plan progress
  (issue #12, D29, D30). `implement next` picks the next eligible ticket
  in plan order. Under whole-plan authorization it asks `escalate` at
  `next-ticket` before every start, and `proceed` starts the ticket;
  `implement start` there only restarts the ticket in progress. Without whole-plan
  authorization it asks the developer without Jev. It reports
  `needs-independence-check`, or `waiting` with reasons, and then starts
  nothing. `implement park` records a blocked ticket as parked with its
  blocker. Its uncommitted changes become its partial edits, which count
  as claimed and are never committed with another ticket. It never
  changes authorization. `implement independence` records a check
  covering dependencies, unresolved decisions and partial edits.
  `implement start` and `next` refuse a ticket beside a parked one
  without such a check, or one that depends on a parked ticket.
- `src/actions/troubleshoot.ts` — the helper side of `troubleshoot`
  (issue #11). `troubleshoot start` records a failed check in
  `jflow/diagnoses.json` with a snapshot of the working tree: HEAD and a
  hash of each changed path. `troubleshoot record` adds the finding,
  evidence and recommended fix. It is refused if the tree changed in the
  meantime, and names what changed. `implement fix` records the fix as
  applied by the started ticket, under recorded authorization. `review
  start` hands the ticket's diagnoses to the reviewer.
- `src/actions/completion.ts` — completing a ticket (issue #10, D34).
  `implement complete` refuses a ticket until `validate` has found every
  criterion met and its review passed. It then records the ticket `done`
  and, with `commitOnSuccess` on (the default), makes one local commit of
  the ticket's changed paths and the changed records under `jflow/`. Paths
  the developer kept or another ticket adopted are left out, and so is
  anything the developer staged. When Git refuses the commit, the records
  are restored. The commit names its ticket in a `Jflow-Ticket` trailer,
  so no record is left to write after it. The ticket's adopted changes are
  released. A ticket-scope authorization ends with the ticket; whole-plan
  authorization continues.
- `src/project/worktree.ts` — the helper's only access to Git (issues #7,
  #10). Everything goes through `readOnlyGit` (`status`, `rev-parse`, `log`)
  except `commitPaths`, the ticket's commit. It runs `add
  --intent-to-add` and `commit --only` on the paths it is given, so no path
  initializes a repository, discards a change, absorbs pre-existing work,
  or pushes, publishes or merges.
  It reads the working tree's uncommitted changes, leaving out `jflow/`.
  `state.ts` reports the changes with no recorded owner, and `implement`
  and `review` pause on them (`git.changesOwned`) until
  `jflow changes claim` records the developer's answer: `developer` (kept
  out of the ticket) or `ticket` (adopted; the claim holds only while that
  ticket is assigned). Once the ticket's work has begun, new changes are
  presumed the ticket's. Telling them apart from the developer's own
  mid-ticket edits is left to #10 and #22.
- `src/actions/conflicts.ts` — D7's hard rule. A conflict that touches
  requirements, scope, workflow rules or permissions is recorded in
  `jflow/conflicts.json` and waits for the developer. A technical
  disagreement is settled by recorded investigation, or waits for the
  developer when the investigation is inconclusive. Jev is never asked.
- `src/actions/classify.ts` — Jev's advisory `classify` (issue #29, D50):
  one question over three content kinds, each offered only its own
  choices, the kind leading the packet so envelopes and replay can tell
  them apart. `plan write` asks it about every drafted criterion
  (testability) and records each answer on its ticket; a criterion it
  confidently classes untestable stops the write until it is rewritten
  or set aside with a reason and evidence. `todo route` asks it whether
  an item found mid-work is a todo or in scope (item-routing); `todo add
  --routing` records the item with that answer and the choice on its
  envelope. `learn propose` asks it which candidate scope a lesson
  applies to (lesson-scope) and records the proposal with the lesson. Any
  other kind, a review finding above all, is refused before Jev and kept
  as a local trace.
- `src/actions/todo.ts` and `next.ts` — `todo` records future work in
  `jflow/todos.json`, outside the plan, at any point, and authorizes
  nothing. Promotion records the developer's decision in their words and
  says whether `plan` or `realign` adds the ticket. It never adds the
  ticket itself. `next` reports each action's eligibility with its reasons
  and one recommendation, including what only the developer can grant. It
  writes nothing (issue #14).
- `src/actions/learn.ts` — `learn` (issue #19) records a candidate project
  lesson in `jflow/lessons.json` at any point, with its scope and evidence
  links, and asks the advisory `lesson-retention` decision about it. The
  answer's summary and envelope are recorded with the lesson, and the
  agent's decision to retain it or keep it a candidate is recorded next to
  them. Setting the answer aside needs a reason and evidence. Where the
  answer is not relied on, retaining needs the developer or the agent's
  `jev assess` record. A lesson that conflicts with an accepted decision or
  a retained lesson, or that Jev answers `escalate` for, asks `escalate` at
  `lesson-conflict`. On `proceed` it stays a candidate, and only the
  developer's own word can retain it later; on an ask, only the developer
  decides. The decision it conflicts with is never changed either way. A
  lesson scoped to jflow's workflow, its Jev questions or its policy is
  refused. Only the lessons
  record is written, so the interrupted action resumes as it was.
- `src/actions/wrap.ts` — `wrap` (issue #21) writes `jflow/resume.json`, the
  record a fresh session continues from without chat history. It carries
  the agent's summary and next steps, plus what the records say: the plan
  and its authorization, every ticket's outcome (the active ticket's fix
  attempts, validation and review), parked tickets with their blockers,
  open todos, lesson state, a Jev fallback waiting for approval, the
  uncommitted paths, and `next`'s recommendation. It compares the
  records with the repository (a done ticket's missing commit, an assigned
  ticket that is not in progress, changes recorded but absent, changes no
  one owns, a ticket that passed review but is not done, a done ticket
  without a commit), carries over discrepancies recorded earlier, and adds
  the agent's own findings. It reports every discrepancy and reconciles none.
  It writes no other record and only reads Git.
- `src/actions/resume.ts` — resuming in a fresh conversation (issue #22,
  D15). `readResume` writes nothing: it reports the resume record beside
  the records and the working tree, the authorization from the progress
  record alone, the ticket to continue with its uncommitted edits, done
  tickets no validation supports, the affected tickets, the discrepancies
  (those `wrap` checks, plus an authorization that differs from the resume
  record's, paths changed since wrap, and a done ticket whose validation
  fails), and the previous recommendation beside the current one.
  `verifyTicket` judges a done ticket on checks run now through
  `validate`, without changing its status. `reconcileResume` asks
  `escalate` at `resume-discrepancy` for each discrepancy with its
  evidence; a scope change asks the developer without Jev and records a
  `realign` recommendation (once). It refuses while a completion claim is
  unverified, and puts a discrepancy already waiting on the developer to
  them again without Jev. `settleDiscrepancies` records their decision so
  it is not raised again. Only `progress.reconciliation` is written.
- `src/actions/realign.ts` — `realign` (issue #31, D42), run only on the
  developer's recorded words. It re-scopes, adds, parks or withdraws the
  tickets the new direction affects and leaves the others and their
  records as they were. A done ticket whose criteria changed is
  re-validated through `validate` over its recorded evidence and reopened
  with its review cleared, since the review covered the old criteria;
  when it cannot be re-validated nothing is written. New and changed
  criteria are classified for testability as in `plan write`, and the
  plan review, which covered the old scope, is cleared.
  The specification and plan re-enter acceptance and the execution
  authorization ends. Each realign and each recommendation (which starts
  nothing) is kept in `jflow/realign.json`. It edits no code and marks
  nothing done.
- `src/actions/lesson-use.ts` — using a retained lesson (issue #20). Only
  active lessons are offered (`learn active`). Each is re-checked against
  the task before use, and the check (applies, or skipped with the reason)
  is recorded on the lesson (`learn check`). A contradicted lesson is
  marked superseded with the evidence and kept as history; a superseded
  lesson or a candidate is never applied. Superseding a lesson the
  developer retained, or one whose contradiction touches an accepted
  decision, asks `escalate` at `lesson-conflict`. On `proceed` a lesson the
  developer retained stays retained, with the contradiction recorded, and
  only their own word supersedes it; one that only touched an accepted
  decision is superseded, which never writes that decision.
- `src/jev/` — the Jev client (issue #16).
  - `evidence.ts` builds the bounded packet for one decision: task summary,
    candidates and selected excerpts. It redacts credentials, including the
    key itself, and drops full-conversation or full-repository content
    while `evidenceSharing` excludes it. It cuts to
    `evidenceSharing.maxPacketChars` and lists every omission.
  - `client.ts` makes one call to TypeSafe's `POST /v1/systemone`. A
    missing key returns the question to ask and sends nothing. The exact
    exchange goes to a trace without the key. The caller gets a portable
    summary (answer, closed reason code, confidence, trace reference) or
    a failure marked retryable or not. Retries and fallback are #18's.
  - `decisions.ts` is the decision runtime (issue #17). It asks a declared
    decision by name and stores every answer as a decision envelope under
    `.jflow/envelopes/` before returning it. An envelope holds the packet,
    the question and a policy digest, the answer, reason code, confidence,
    authority, route and chosen action, and it rebuilds the exact request.
    Routes: `act` (binding), `weigh` (advisory) or `ask-human` (below the
    threshold, or wording not yet accepted). Choosing against an answer
    needs a reason and evidence. A choice the workflow's own checks do not
    permit is refused. `next` asks `next-action` end to end. It also
    builds the `assignment` and `lesson-retention` packets.
  - `escalation.ts` is the binding `escalate` decision (issue #25). At a
    human-facing boundary (`next-ticket`, `fix-failed`, `review-dispute`,
    `lesson-conflict`, `resume-discrepancy`, `missing-check`, `other`) it
    asks whether the developer must be consulted. A confident `proceed` is recorded as the
    workflow's choice and asks no one. `escalate`, a below-threshold
    answer, a missing key or a failed call asks the developer. The hard
    rules (consequential conflict, continuing without Jev, the
    specification and plan acceptance gates) always ask and never reach
    Jev. The boundary kind rides in the packet, so the envelope alone says
    where the question was asked and whether the developer was asked.
  - `ticket-validation.ts` is the binding `validate` gate (issue #26). It
    asks one question per criterion accepted with the plan, over the
    recorded evidence (check output or the implementer's claim, never a
    diff or repository content). Any `not-met` returns the ticket to fix.
    Otherwise `insufficient-evidence` asks for the ticket's checks not yet
    run, or asks `escalate` at `missing-check` when none remain: `proceed`
    returns the ticket to fix so the missing check is added, and an ask
    waits on the developer. Only all `met` admits it to review. A
    below-threshold answer counts as insufficient evidence. Claim-only
    evidence is settled by rule without asking Jev. The outcome is
    `progress.validations[ticket]`. Setting a verdict aside records the
    choice on its envelope and settles again.
  - `replay.ts` is minimal replay (issue #27, D46). A proposed question
    file for one declared decision is re-asked over every stored envelope
    of that decision, in its stored frame, and routed as if accepted. A
    proposed confidence threshold alone re-routes the stored answers
    without asking Jev. The report counts the answers, routes and reason
    codes that would change, and in which direction, by boundary kind and
    by reason code, each change linked to its envelope. `escalate` breaks
    down by boundary kind and `classify` by content kind.
    Replay writes only traces: no envelope, record, fallback status,
    question or policy file. A decision with no envelopes is reported as
    nothing to replay. A proposed authority re-routes the stored answers
    too, and a threshold for one kind replays only that kind's envelopes.
  - `observations.ts` is the harness-observation view (issue #30, D35):
    low-confidence answers, overrides, escalations, calls Jev did not
    answer and tickets at the fix limit, read from the envelopes, traces
    and progress record on every call. There is no store, and nothing is
    filtered. `findPatterns` groups recurring ones by kind, decision,
    place and reason code.
  - `proposals.ts` is question-file proposals (issue #30, D39, D46). A
    proposal names one decision and one change (a wording, a threshold
    for the decision or for one kind, or an authority), links at least
    one observation and any retained lessons, and carries its replay
    report. It is kept under `.jflow/proposals/`. Only `acceptProposal`
    writes the package: with the developer's words, a report that
    replayed something, and the decision still at the version it was
    replayed against. It bumps the decision's version in the question
    file and declaration together. It edits the package text in place
    (`workflow/json-edit.ts`), so the threshold itself is a one-line
    change beside the version and basis lines it touches. A rejection is
    recorded and changes nothing.
  - `kinds.ts` reads where a decision was asked from its packet. A
    threshold declared as `confidence:<kind>` in a decision's policy
    routes that kind; every other kind keeps `confidence`.
  - `traces.ts` keeps traces under `.jflow/traces/` (the directory carries
    its own `.gitignore`) until `jflow traces clean`.
- `src/host/` — host capability checks, verified by execution and labelled
  `verified`/`unverified`, never assumed from documentation.
- `src/cli.ts`, `bin/jflow.js` — the helper's command line (`status`, `run`,
  `validate`, `check-host`, `specification`, `plan`, `changes`, `next`,
  `todo`, `learn`, `wrap`, `resume`, `realign`, `decide`, `escalate`, `replay`, `proposal`, `implement`, `review`, `troubleshoot`,
  `ticket`, `conflict`, `traces`); one JSON object per command. `npm run build`
  emits `dist/`.
- `skill/` — the `jflow` skill directory in the layout the host documents:
  `SKILL.md`, `actions/<action>.md` method files (`status.md`, `next.md`,
  `todo.md`, `learn.md`, `wrap.md`, `brainstorm.md`, `plan.md`, `implement.md`, `review.md`,
  `troubleshoot.md` and `realign.md`),
  `scripts/jflow` (runs the helper), `references/HOST.md` (what is verified
  on which host).
- `src/testing/` — the project-directory test harness: set up a directory in
  a known workflow state, run a request, assert the resulting files and the
  human-ask events raised. Test scaffolding, not library API.

Host capabilities were checked on the ChatGPT desktop app on 2026-09-26; see
`skill/references/HOST.md`.

## Release demonstrations

The fourteen release demonstrations (RELEASE-SCOPE.md, issue #23) run as
automated tests at the workflow-action-contract seam, one file each in
`src/demonstrations/`. Each drives the helper's command line as the skill
does, against a project directory with a real Git repository and a
scripted Jev (`src/testing/demo.ts`). It asserts the records, the working
tree and commits, the asks returned, and the authorization, never agent
wording. No test asserts a threshold's value: a scripted answer is
confident or unsure relative to whatever threshold is declared.

| # | Demonstration | Test |
| --- | --- | --- |
| 1 | idea to accepted specification and plan, authorized multi-ticket implementation, per-ticket and integrated review | `01-idea-to-integrated-review` |
| 2 | failed check, diagnosis and fix; blocking finding and re-review; the fix limit asks | `02-fix-loop` |
| 3 | a blocked ticket parked; independent work proceeds; blocker and authorization kept | `03-park-and-independent-work` |
| 4 | a fresh conversation reconciles interrupted work and continues from files | `04-fresh-conversation-resume` |
| 5 | configured worker models and a separate reviewer; explicit fallback only | `05-worker-models-and-reviewer` |
| 6 | Jev outage needs approval; conflicting and uncertain answers are inspectable | `06-jev-outage-and-uncertainty` |
| 7 | a lesson retained and re-checked without changing workflow logic; a discovery stays a todo | `07-lessons-and-todos` |
| 8 | invalid configuration, excluded evidence and missing review fail loudly; traces stay out of Git | `08-nothing-passes-silently` |
| 9 | proceed asks nothing, escalate asks, a hard rule asks without Jev | `09-escalation` |
| 10 | a ticket without criteria refused; validate's two outcomes; one fix counter across gates | `10-criteria-validate-counter` |
| 11 | a mid-implementation realign re-scopes, re-checks and re-enters acceptance | `11-realign` |
| 12 | an observation pattern yields a replayed proposal that changes nothing until accepted | `12-question-file-proposal` |
| 13 | a binding answer acts; only a recorded reason gets past it; an undeclared authority fails | `13-binding-authority` |
| 14 | a model outside the configured set is rejected; classify never gets a review finding | `14-model-selection-and-classify` |

What they show is the helper side only (D51): that the gates, records,
asks and authorization behave as specified around Jev's answers. The
instruction side, an agent following the skill on a host, is unverified
for every demonstration until a run is recorded in
`skill/references/HOST.md`.

What they do not show: Jev's answers here are scripted, so nothing here
measures whether Jev chooses better than the stated workflow rules or
than ordinary primary-agent judgment. No such comparison has been made,
and jflow makes no claim of better routing, lower cost, or support for any
host or model beyond what `skill/references/HOST.md` records as verified
(D11, D36).

## Invariants enforced in code

- Resume reconciles nothing itself: it changes no ticket, edit, fix
  counter or authorization, takes authorization from the progress record
  alone, and puts every discrepancy through `escalate` (a scope change to
  the developer directly). A completion claim no validation supports is
  listed for its checks to run, never trusted.
- `realign` runs only with the developer's recorded words. It ends the
  execution authorization, puts the specification and plan back behind
  acceptance, reopens every done ticket whose criteria changed, and never
  marks a ticket done or edits code. A recommendation to realign changes
  nothing else. The plan is accepted only after its specification, and
  `plan write` never replaces a realigned breakdown.
- Review always requires a role that is independent of the implementer; no
  workflow package or configuration can disable that gate. A review by the
  primary agent or a recorded worker is refused, and review is refused
  until `validate` has found every criterion met.
- `troubleshoot` and `review` can never edit code. A diagnosis is
  recorded only once the working tree is confirmed as it was, and its fix
  only under an authorized `implement`.
- `implement` and `review` require a local Git repository; `brainstorm` and
  `plan` do not. jflow runs read-only Git commands, apart from a ticket's
  own local commit. It never initializes a repository or discards changes,
  and never absorbs pre-existing uncommitted changes. Changes with no recorded owner pause
  `implement` and `review` until the developer names one, and a workflow
  package cannot drop that pause.
- Plan acceptance and execution authorization are distinct state flags.
- A ticket is committed and recorded done only after it passes `validate`
  and review. The commit holds only its changes and the records. jflow
  never pushes, publishes or merges.
- A stage worker model never falls back implicitly — the fallback must name an
  explicit model, otherwise jflow asks.
- The Jev API key is read from `JFLOW_JEV_API_KEY` or host secret storage, and
  is rejected if found in configuration. A missing key produces a question for
  the human, not a silent fallback.
- Raw traces are kept until explicit local cleanup and stay out of version
  control; project records carry trace references only.
- A project lesson never changes the workflow: nothing in the package, its
  gates or Jev's questions reads the lessons record, and a lesson scoped to
  the workflow is refused. A retained lesson may be linked to a
  question-file proposal as a contributor, but a proposal needs an
  observation of its decision and the developer's acceptance. An assessed lesson is active only on a recorded
  decision to retain it, and `learn` never changes an accepted decision.
- `wrap` writes only the resume record. It reports discrepancies between
  the records and the project without reconciling them, and never
  commits, pushes, merges, publishes or cleans up, raw traces included.
- Only a retained lesson is offered for use or can be checked as
  applying; a candidate or a superseded lesson never is. The agent cannot
  supersede a lesson the developer retained without `escalate`, and on
  `proceed` their decision stands.
- A superseded lesson must name its successor and the evidence; an approved
  Jev fallback and an authorized execution must record their scope; a parked
  ticket must record why.
- A Jev answer is relied on only when its wording is accepted and its
  confidence meets the threshold. For the agent, choosing against it needs
  a recorded reason and evidence. The developer's choice needs their
  recorded words. No answer permits an action that prerequisite or
  authorization checks refuse. Only a declared binding decision's outcome
  is written to a project record (`validate`, as `progress.validations`).
  Consequential conflicts go to the developer without a Jev call.
- Every declared decision carries an `authority` and a `basis`, and every
  policy entry a `basis`; a version-1 package carrying `decisions` or
  `policy` is rejected rather than widened. No test asserts a threshold's
  value.

## Development

```sh
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # emit dist/ for bin/jflow.js and skill/scripts/jflow
```
