# jflow

A JSON-defined workflow package that a primary conversational agent loads to
run one custom development workflow end to end.

See `SPEC.md` for the first-release specification, `TICKETS.md` for the
current ticket breakdown, and `CONTEXT.md` for project vocabulary.

## Status

Foundation slice (issues #1–#7, #14, #16 and #17; TICKETS.md T1–T5 decompose #1 and #2):

- `workflow/jflow.workflow.json` — the single shipped workflow package
  (schema version 2): the action set, per-action roles, delegation limits,
  Git and code-edit rules, prerequisites, the supported configuration
  surface, and the seven declared Jev decisions with their `authority`,
  `basis` and policy thresholds (D37, D43).
- `workflow/questions/` — one question file per declared decision, each
  with a closed answer set and a closed reason-code set. The package checks
  that they resolve and are well-formed. Wording moves from `skeleton` to
  `proposed` to `accepted`, and accepted wording records when and in what
  words the developer accepted it. The developer accepted the wording #17
  proposed for `next-action`, `assignment` and `lesson-retention`. The rest
  are skeletons owned by #25, #26, #28 and #29.
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
  that the same instruction may grant — "looks good" accepts only.
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
  #10). Everything goes through `readOnlyGit` (`status`, `rev-parse`)
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
- `src/actions/todo.ts` and `next.ts` — `todo` records future work in
  `jflow/todos.json`, outside the plan, at any point, and authorizes
  nothing. Promotion records the developer's decision in their words and
  says whether `plan` or `realign` adds the ticket. It never adds the
  ticket itself. `next` reports each action's eligibility with its reasons
  and one recommendation, including what only the developer can grant. It
  writes nothing (issue #14).
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
  - `traces.ts` keeps traces under `.jflow/traces/` (the directory carries
    its own `.gitignore`) until `jflow traces clean`.
- `src/host/` — host capability checks, verified by execution and labelled
  `verified`/`unverified`, never assumed from documentation.
- `src/cli.ts`, `bin/jflow.js` — the helper's command line (`status`, `run`,
  `validate`, `check-host`, `specification`, `plan`, `changes`, `next`,
  `todo`, `decide`, `escalate`, `implement`, `review`, `ticket`, `conflict`, `traces`); one JSON object per command. `npm run build`
  emits `dist/`.
- `skill/` — the `jflow` skill directory in the layout the host documents:
  `SKILL.md`, `actions/<action>.md` method files (`status.md`, `next.md`,
  `todo.md`, `brainstorm.md`, `plan.md`, `implement.md` and `review.md` so far),
  `scripts/jflow` (runs the helper), `references/HOST.md` (what is verified
  on which host).
- `src/testing/` — the project-directory test harness: set up a directory in
  a known workflow state, run a request, assert the resulting files and the
  human-ask events raised. Test scaffolding, not library API.

The other workflow actions, the other four Jev decisions' wording and call
sites, and compound learning are not implemented yet. Nothing has been run
on the ChatGPT desktop app; see `skill/references/HOST.md`.

## Invariants enforced in code

- Review always requires a role that is independent of the implementer; no
  workflow package or configuration can disable that gate. A review by the
  primary agent or a recorded worker is refused, and review is refused
  until `validate` has found every criterion met.
- `troubleshoot` and `review` can never edit code.
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
