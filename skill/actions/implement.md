# implement

**When**: the developer asked to implement, or `next` recommends it, and
`scripts/jflow run implement` returned `ready`. If it returned `blocked`,
quote each reason and stop. Accepting a plan does not authorize
implementing it: without recorded authorization, ask. If the block is
`git.changesOwned`, follow "Git" in `SKILL.md`.

**Run**, in order:

1. `scripts/jflow implement start` under ticket authorization. Under
   whole-plan authorization, use `scripts/jflow implement next` (Method
   below). A refusal means the ticket does not
   start. It may be unauthorized, another ticket may be in progress, a
   dependency may not be done, or a parked ticket may need an
   independence check first. Quote the reason. Never start a different
   ticket to get around it. The outcome gives the ticket's accepted
   criteria, `delegationLimits`, and the fix counter (`fix.attempts` of
   `fix.limit`).
2. Implement the ticket (Method below). When the outcome says
   `ticketWorker: true`, a fresh sub-agent does steps 2 and 3 (see
   "One sub-agent per ticket" below).
3. Run every check the ticket has. Write the evidence file outside the
   project, in the shape `references/DECISIONS.md` shows under
   "Validating a ticket". Once the ticket has failed before, also add
   `"recommendation"`: the next step you would suggest to the developer
   if this attempt fails too. The helper refuses the check without one
   when this attempt could reach the limit.
4. `scripts/jflow implement check <evidence.json>`. The helper records the
   evidence under `.jflow/evidence/<ticket>.json`, asks `validate`, and
   counts a `not-met`. Act on `validation.disposition`:
   - `admitted-to-review`: stop implementing. The ticket goes to `review`
     (`actions/review.md`). Report what was done and the evidence.
   - `returned-to-fix`: fix what `criteria` shows as `not-met`, or add the
     check a criterion lacks. Then go back to step 3. `fix.attempts` says
     how many fixes have already failed. If the cause of a failed check is
     not clear, diagnose it first with `troubleshoot`
     (`actions/troubleshoot.md`). Once its fix is made, record it with
     `scripts/jflow implement fix <id>` before checking again.
   - `needs-check`: run the commands in `missingChecks`, add their output
     and go back to step 4. This is not a fix attempt.
   - exit 1 with `askHuman` (`awaiting-developer`, the fix limit, or Jev
     unavailable): put its reasons to the developer, with your
     recommendation, and wait. Do not try another fix first.
5. Once `review` has passed the ticket (`actions/review.md`), run
   `scripts/jflow implement complete`. The helper refuses a ticket that has
   not passed `validate` and review. Otherwise it records the ticket
   `done`. Unless `commitOnSuccess` is off, it also makes one local commit
   of the ticket's changes and the records under `jflow/`.
   - `commit.paths` is what went in. `leftOut` is what stayed out: the
     developer's changes, and any another ticket adopted.
   - If the ticket had to edit a file the developer owns, ask the
     developer before completing. Their file is left out whole.
   - `authorization` is `ended` when the next ticket needs the developer's
     authorization, and `continues` under whole-plan authorization.
   - If Git refuses the commit (a failing hook, say), the ticket is not
     complete. Quote the reason, fix the cause, and run `complete` again.

**Method**

Work on the started ticket only. Anything else you notice goes to
`scripts/jflow todo add`. It does not go into this ticket. Coordinate the
work as the primary agent. List every sub-agent that worked on the ticket
under `"workers"` in the evidence file. None of them, and not you, may
review it. Sub-tasks that are independent of each other
may run in parallel, but only while `delegationLimits.allowParallelWithinUnit`
is true, with never more than `delegationLimits.maxParallelWorkers` running
at once. When it is false, work sequentially. Every worker stays inside
this ticket. Record each worker before it runs, as `SKILL.md` says under
"Stage workers", and finish it when it is done.

**One sub-agent per ticket**

`ticketWorker: true` means execution is authorized for the whole plan and
`implement.ticketWorker` is on (the default). Start one new sub-agent for
the ticket, with role `implementer`, and record it first, as `SKILL.md`
says under "Stage workers". Give it only what the ticket needs: the ticket
id, title and accepted criteria, the parts of the specification they rest
on, the test-naming rule below, and where the evidence file goes. It
implements the ticket, runs the checks, writes the evidence file, and
returns the files it changed and a few lines on what it did. It runs no
`scripts/jflow` command and never commits. You run steps 4 and 5, and the
review, from its report. If the ticket comes back `returned-to-fix`, start
a new sub-agent with the criteria not met or the blocking findings. List
every sub-agent under `"workers"` in the evidence file. None of them may
review the ticket.

The ticket's checks are the commands whose results its acceptance criteria
depend on: the tests named in them, and the project's typecheck and test
suite. Record the output of each check exactly as it ran, with the exact
command as `source` and its exit code. Never record a diff or file
contents. Your own summary goes in as a `claim`. A claim never admits a
ticket.

`validate` sees only that output, so make each criterion visible in it.
Write one test per condition a criterion names, and name the test after
the condition: "missing argument exits nonzero", "unreadable file exits
nonzero", "invalid UTF-8 exits nonzero", not one "reports input errors"
test for all three. Run the tests with a reporter that prints each test's
name. A condition no test name shows reads as unproven, and the verdict
comes back unsure and goes to the developer.

A failed test is the normal reason to ask the developer during
implementation, but only once the fix counter reaches its limit. The
helper keeps that counter; never count attempts yourself. Do not change a
test or a criterion to make it pass. Setting a verdict aside goes through
`ticket override` with evidence (`references/DECISIONS.md`).

Never commit yourself, and never mark the ticket done; `implement
complete` does both after review. Never push, publish or merge. Each needs
the developer's separate, explicit authorization, and a passed review or a
local commit is not one. The ticket stays `in-progress` until it passes
review. When review returns it to fix, fix every blocking finding, then go
through step 3 again. If the conversation loses the ticket partway
through, start it again and redo it from its definition.

Under whole-plan authorization, once a ticket is complete, run
`scripts/jflow implement next`. Act on `kind`:

- `started`: `escalate` let the next ticket start without asking. Work on
  it from step 2.
- `ask` (exit 1): put `askHuman` to the developer and wait. Without
  whole-plan authorization this is always the answer: each ticket needs
  the developer's authorization, and Jev is not asked. With an
  `escalation` envelope, record their answer with `scripts/jflow decide
  choose <envelope> --action proceed|escalate --by developer --reason
  "<their words>"`. On proceed, run `scripts/jflow implement next
  --escalation <envelope>`, which starts the ticket without asking Jev
  again. Plain `implement next` would ask Jev anew.
- `needs-independence-check`: a ticket is parked, and `candidates` could
  start beside it once checked. Do the check below.
- `waiting` (exit 1): nothing can safely proceed. Report each of
  `reasons` to the developer and wait. Start nothing.
- `needs-plan-review`: every ticket is done, and the plan waits for its
  integrated review (`actions/review.md`).
- `finished`: every ticket is done or withdrawn, and the plan's review
  has passed. `wrap` comes next.

Park a ticket when something outside it blocks it: a question only the
developer can answer, a missing dependency, or an unresolved conflict. A
failed test is not a blocker; it goes through the fix counter. Report the
blocker, and ask any question it needs. Then run `scripts/jflow implement
park <id> --blocker "<what blocks it>"`. The ticket stays incomplete and
keeps its uncommitted changes as its partial edits. Parking never widens
authorization: under one-ticket authorization, nothing else starts.

The independence check comes before any ticket starts beside a parked
one. Check three things against every parked ticket:

- dependencies: the parked tickets are not among its dependencies, direct
  or indirect. The helper refuses a ticket that depends on one;
- unresolved decisions: what the parked tickets wait on does not change
  what this ticket must do;
- partial edits: the parked tickets' uncommitted paths
  (`parked[].partialEdits`) are not ones this ticket reads or changes.

If any of them fails, the ticket is not independent. Do not record a
check for it. Otherwise write the check file outside the project, with
`ticketId`, `dependencies`, `decisions` and `partialEdits`, each saying
what you checked and what you found. Run `scripts/jflow implement
independence <check.json>`, then `implement next` again. A check covers
the tickets parked when it was made. Parking another ticket needs a new
check.

**Report**: which ticket you worked on. Each criterion with its verdict.
Any ticket you parked, with its blocker, and any independence check you
recorded. The checks you ran and their results. On completion, the commit hash and
what it left out. Where the ticket went next (review,
another fix, or a question for the developer). Anything you recorded as a
todo.
