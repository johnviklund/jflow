---
name: jflow
description: Run one development workflow end to end — brainstorm, plan, implement, troubleshoot, review, wrap, realign, with status, next, todo and learn available at any point — with precise gates, records and Jev decisions handled by a bundled helper.
---

# jflow

jflow is a workflow you run with your primary agent. This skill carries the
methods; the bundled helper carries the exact parts (validation, project
records, prerequisite and authorization checks, Jev calls, gates). Read the
method for an action in `actions/<action>.md`; run the helper for anything
that must be exact. Never work out a prerequisite, a counter or a record's
contents in your head when the helper can tell you.

## The helper

The helper is `scripts/jflow`. It runs `node` on the built `dist/cli.js`
two directories up, so this skill directory must stay inside the jflow
checkout, built once with `npm run build`. Every command prints one
JSON object on stdout. Exit code 0: the command ran. 1: the developer is
needed (blocked, ambiguous, unknown, invalid configuration). 2: the project
records or the workflow package cannot be read; stop and report the problem.

| Command | Use |
| --- | --- |
| `scripts/jflow status` | Where the project stands and which actions could run now. Always safe. |
| `scripts/jflow next` | One recommended action with its reason, plus what only the developer can grant, and Jev's advisory `next-action` answer. Writes no project record; see `actions/next.md`. |
| `scripts/jflow jev approve\|assess` | Record the developer's approval to continue without Jev for a scope, and your own evidence assessment where Jev's answer was uncertain or missing; see `references/DECISIONS.md`. |
| `scripts/jflow decide ask\|show\|choose` | Ask a declared Jev decision, read its envelope, and record the chosen action; see `references/DECISIONS.md`. |
| `scripts/jflow replay <decision> --question <file> \| --threshold <n> [--kind <k>] \| --authority <a>` | Re-ask Jev over a decision's stored envelopes with a proposed question, or re-route them under a proposed threshold or authority, and report what would change; it decides nothing. See `references/DECISIONS.md`. |
| `scripts/jflow proposal observations\|patterns\|draft\|replay\|accept\|reject\|list\|show` | Read the harness observations and their recurring patterns, draft a question-file proposal from them with its replay report, and record the developer's accept or reject. Only an accepted proposal changes a question or policy file; see `references/DECISIONS.md`. |
| `scripts/jflow escalate <boundary.json>` | Ask the binding `escalate` decision at a human-facing boundary: exit 0 proceeds with no ask, exit 1 returns `askHuman`; see `references/DECISIONS.md`. |
| `scripts/jflow implement start\|check\|complete\|fix\|next\|park\|independence` | Start the one authorized ticket, check it through the `validate` gate and the ticket's fix counter, record a diagnosis's fix, and once review passes, record it done with its local commit. Under whole-plan authorization, move to the next ticket, park a blocked one, and record independence checks; see `actions/implement.md`. |
| `scripts/jflow worker recommend\|assign\|finish` | Ask Jev's advisory `model-selection` for a model and effort from the stage's configured options, record a stage worker before it runs, on its stage's configured model, within the stage's roles and delegation limits, and free its place when it is done; see "Stage workers". |
| `scripts/jflow troubleshoot start\|record` | Record a failed check, then its diagnosis and recommended fix, refused if the working tree changed meanwhile; see `actions/troubleshoot.md`. |
| `scripts/jflow review start\|record\|decide`, `review plan start\|record\|decide` | Open review of a ticket `validate` admitted, record an independent reviewer's findings under the fixed disposition rule, and record the developer's decision on a disputed finding. `review plan` is the integrated review a multi-ticket plan needs before it is complete; see `actions/review.md`. |
| `scripts/jflow ticket validate\|override` | Judge a ticket's recorded evidence against its accepted criteria (binding `validate`) and set one verdict aside with evidence; see `references/DECISIONS.md`. |
| `scripts/jflow conflict raise\|decide` | Record a conflict: consequential ones wait for the developer, technical ones are settled by investigation. Jev is never asked; see `references/DECISIONS.md`. |
| `scripts/jflow todo route\|add\|list\|promote` | Ask whether an item found mid-work is a todo or in scope, record future work outside the plan, and the developer's decision to promote an item; see `actions/todo.md`. |
| `scripts/jflow learn propose\|decide\|list` | Record a candidate project lesson with Jev's advisory `lesson-retention` answer, then retain it or keep it a candidate; a conflict with an accepted decision asks `escalate`. See `actions/learn.md`. |
| `scripts/jflow learn active\|check\|supersede` | List the lessons that may be used, re-check one against the task before each use, and mark a contradicted one superseded with evidence; see `actions/learn.md`. |
| `scripts/jflow realign <draft.json> --note <words>`, `realign recommend\|show` | On the developer's instruction only: re-scope, add, park or withdraw tickets for a changed direction, re-validate completed tickets whose criteria changed, and put the specification and plan back behind acceptance. `realign recommend` records a recommendation and starts nothing; see `actions/realign.md`. |
| `scripts/jflow resume`, `resume verify\|reconcile\|settle` | Start of a fresh conversation on existing work: reconcile the records with the files and evidence before continuing; see "Resuming in a fresh conversation". |
| `scripts/jflow wrap <draft.json>`, `wrap show` | End a session: write the resume record a fresh session continues from, and report where the records and the project disagree without reconciling it. Never pushes, merges, publishes or cleans up; see `actions/wrap.md`. |
| `scripts/jflow run <request…>` | Resolve a request to one action and check its prerequisites; `status` and `next` run, the rest come back `ready` for their method file. |
| `scripts/jflow validate [--config <file>]` | Check the workflow package and a configuration before doing anything. |
| `scripts/jflow check-host` | Which host capabilities are verified by execution, and which are not. Run it before claiming anything about the host. |
| `scripts/jflow specification write\|confirm\|reject\|accept` | Record what `brainstorm` produced and what the developer decided; see `actions/brainstorm.md`. |
| `scripts/jflow plan write\|accept\|authorize` | Record the ticket breakdown, its acceptance, and execution authorization as separate facts; see `actions/plan.md`. |
| `scripts/jflow traces list\|clean` | The local Jev traces under `.jflow/traces/`. `clean` deletes them; run it only when the developer asks. |
| `scripts/jflow changes claim [<path>…] --owner developer\|ticket --note "<words>"` | Record who owns uncommitted changes the helper asked about; see "Git" below. |

Pass `--root <dir>` when the project is not the current directory.

## Resuming in a fresh conversation

When a conversation opens on a project that already has `jflow/`
records, reconcile before you continue anything, even when the developer
only says "carry on". The previous session's chat is gone; the records
are what you have.

1. `scripts/jflow resume` writes nothing. Read `report`:
   - `resume`: what the last session left (`wrap`), if it wrapped:
     summary, next steps, uncommitted paths.
   - `authorization`: from the progress record only. If `needsDeveloper`
     is true, nothing is implemented until the developer authorizes it.
     Never take authorization from the resume record or from memory.
   - `continueWith`: the ticket in progress and its own uncommitted
     edits. Continue it from those edits. Do not restart it, discard the
     edits or redo finished work. Changes that appeared since wrap are
     not in the list; they are discrepancies, not the ticket's work.
   - `unverified`: done tickets that no validation supports. Run their
     checks (`checks` lists the recorded ones; otherwise the ticket's own
     test commands) and record the output with
     `scripts/jflow resume verify <evidence.json>`, the evidence file of
     `ticket validate`. It never changes the ticket's status. Reconcile
     refuses until every one is verified: a claim is checked, never
     trusted.
   - `affected`: the only tickets to look at. Leave the others alone.
   - `recommendation.previous` and `.current`: act on `current`. The old
     one may no longer hold.
2. Compare the files with the records for the affected tickets yourself:
   do the partial edits match where the summary says work stopped, and do
   the checks you ran pass?
3. `scripts/jflow resume reconcile [<draft.json>]` puts every discrepancy
   through `escalate`, the helper's and yours. Your draft lists yours:
   `{ "discrepancies": [{ "ticketId": "T2", "summary": "…", "evidence": ["npm test: 1 failed"] }] }`.
   Mark one `"changesScope": true` when it changes what was agreed (a
   requirement, the plan's scope): the developer is asked without Jev and
   a `realign` recommendation is recorded. Never run realign yourself.
   Exit 1: put each `askHuman` to the developer and wait. Exit 0: continue.
   A discrepancy already waiting on the developer comes back as
   `awaiting` without asking Jev again. When they decide, record it with
   `scripts/jflow resume settle --note "<their words>"`; a settled
   discrepancy is not raised again. Reconcile changes no ticket, edit or
   authorization. Fixing a discrepancy is work for an authorized action,
   or the developer's call.

Report in a few lines: where the last session stopped, the authorization
as recorded, what you will continue, what you verified, and each
discrepancy with its outcome.

## How a request reaches an action

1. If the developer named an action (`implement`, `/review`, "run status"),
   pass that name. If they described what they want ("where are we?",
   "break the spec into tickets") and you are sure which action it is, pass
   the name; if you are not sure, pass their words as they are. Never ask
   the developer to rephrase into a command.
2. Run `scripts/jflow run <name or words>`. The helper resolves the request
   to exactly one action or returns a question; it never guesses.
3. Read `outcome.kind`:
   - `completed` (`status`, `next`): report the result as that action's
     method file says.
   - `ready`: the action is eligible; follow `actions/<action>.md` for
     the method. (Until an action's method file exists, tell the developer
     the action is eligible but not yet available.)
   - `clarify`: the request fits more than one action. Ask the developer
     the `question` verbatim. Never pick one for them.
   - `blocked`: refuse, quoting each `unmet` prerequisite's `reason`. Where
     `needsHuman` is true, the developer decides; do not try to clear it
     yourself. Acceptance of a plan is not authorization to execute it.
   - `unknown-action`: say no jflow action matches and list the actions.
   - `malformed-record`: name the file and the problem; change nothing.
4. `humanAsks` lists every point where the developer must be asked. Ask
   each one; do not continue past it.

## Rules the helper cannot enforce for you

The workflow package and the records enforce the gates; these are the
parts only the agent can honour.

- A bare "looks good" accepts a plan; it does not authorize executing it.
  Whole-plan authorization needs explicit words. Record what was said, not
  what you inferred.
- `review` is never done by the agent that implemented the change, nor by
  a worker that worked on it. The helper refuses the implementers it
  knows about; spawning a fresh reviewer is yours to do.
- `realign` is the developer's to invoke. Recommend it (`realign
  recommend`); never run it unasked.
- A todo item is not work to do now. Recording or listing one never widens
  the current ticket; only the developer's explicit decision promotes it.
- A retained lesson is project knowledge. It never changes the workflow, a
  gate, a Jev question or policy, and never overrides an accepted decision.
  Re-check it against the task every time before applying it.
- Every time you put an `askHuman` to the developer, explain it in plain
  words: what jflow checked, what came back, and why that stops the work
  here. Where Jev answered, give each answer with its confidence against
  the threshold and the evidence it lacked, one line per item (a table
  for several). Then give the options and your recommendation. The
  developer should never have to open a record to know why you ask.
- Secrets never go into project files or the conversation. Never read or
  print the Jev key file. If the helper reports the Jev API key missing,
  show the developer its message and wait, rather than proceeding without
  Jev.
- Evidence for Jev is a bounded packet for one decision: a task summary,
  the candidates and selected excerpts. Never paste a whole conversation or
  repository into it, or anything secret.
- Raw Jev traces stay under `.jflow/traces/`, outside version control.
  Never delete, export or upload them unless the developer asks. Decision
  envelopes stay under `.jflow/envelopes/`, and `traces clean` leaves them.
- A Jev answer is never authorization, and never marks work correct or
  complete. Choosing against it needs a recorded reason and evidence, and
  only within what the workflow already permits. Record `--by developer`
  only for what the developer actually said.

## Stage workers

A stage worker is a sub-agent the primary agent runs within a stage,
whichever stage it is. Each stage declares its roles and delegation
limits, and may have a worker model configured. Before a worker runs,
write an assignment file outside the project with `stage`, `role`,
`agent`, `model` and `ticketId`. Then run `scripts/jflow worker assign
<assignment.json>`:

- The model is the stage's configured model (`stageModel`). The helper
  refuses any other.
- If the host reports that model unavailable, add `"unavailable":
  {"model": "<the configured model>", "reason": "<what the host said>"}`
  and run only the configured fallback. The helper records the
  substitution. Report unavailability only when the host reported it.
- `askHuman` (exit 1): no model is configured, or the model is
  unavailable and there is no fallback, or the fallback is unavailable
  too. Ask the developer which model to use, and start nothing. Their
  answer goes into the configuration (`stageModels`); then assign the
  worker again.
- A role the stage does not declare, or more workers than the stage
  allows at once, is refused. Choose within them.
- Where the stage configures `efforts`, add `"effort"`: one of them.

Before assigning a worker on a stage with more than one option, ask for
a recommendation. Write a draft outside the project with `stage`, `role`,
`ticketId`, `task` (what the worker will do, in a sentence) and
`unavailable` if the host reported the model unavailable. Then run
`scripts/jflow worker recommend <draft.json>`. Read `outcome.kind`:

- `recommended`: weigh the model and effort against the task. Then
  assign with `"selection": {"envelope": "<id>"}`. One envelope answers
  one assignment: the same stage, role and ticket. To choose another
  option, add `"reason"` and `"evidence"` to `selection`. A reason
  without evidence is refused. If the route is `ask-human`, the
  developer chooses: add `"by": "developer"` and their words as
  `reason`.
- `no-recommendation`: choose an option yourself and assign without
  `selection`. If the decision could not be asked, follow
  `references/DECISIONS.md`.
- `single-option`: there is nothing to choose, and Jev was not asked.
  With no `efforts` configured a stage always has one option.
- `rejected`: Jev named something outside the options. The helper
  recorded the rejection, and no worker starts on it. Choose from
  `options` yourself.
- `askHuman` (exit 1): as for `worker assign`.

The limits count within one unit of work, the ticket. Run
`scripts/jflow worker finish <id>` when the worker is done, or if it
stopped without finishing. The helper cannot see which model the host
actually ran, so it records the model you report. You, the
primary agent, are never a stage worker. Your model stays the same across
every stage, and jflow never changes it. Refer to models only by the
names the developer configured. Never name one as required or known to
work.

## Git

`brainstorm` and `plan` need no repository. `implement` and `review` need
one, and the helper blocks them without it. Never run `git init`,
`reset`, `checkout`, `restore`, `clean`, `stash` or `rm` on the developer's
behalf, and never stage or commit their changes. The only commit is
`implement complete`'s: the ticket's own changes and the records. Never
push, publish or merge. Each needs the developer's separate, explicit
authorization. If the developer wants a
repository or a clean tree, they do it.

When `run implement` is blocked on `git.changesOwned`, the working tree
already holds uncommitted changes that no one has claimed. Stop, show the
developer the paths the reason lists, and ask whose they are:

- theirs, left out of the ticket:
  `scripts/jflow changes claim <paths…> --owner developer --note "<their words>"`;
- the assigned ticket's, adopted into it:
  `scripts/jflow changes claim <paths…> --owner ticket --note "<their words>"`;
- to be committed or set aside first: they do that, then run
  `implement` again.

Record only what the developer said. Never pick an owner for them. Write
draft JSON files outside the project, because a draft left in the project is
itself an unclaimed change.

`troubleshoot` and `review` never edit the working tree, even to try out a
fix. A fix goes through an authorized `implement`.

## Layout

- `actions/` — one method file per action: `status.md`, `next.md`,
  `todo.md`, `learn.md`, `wrap.md`, `brainstorm.md`, `plan.md`, `implement.md`, `review.md`,
  `troubleshoot.md` and `realign.md`.
- `references/DECISIONS.md` — asking Jev's declared decisions, what each
  route allows, recording choices and overrides, and handling conflicts.
- `scripts/jflow` — the helper.
