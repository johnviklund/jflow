# implement

**When**: the developer asked to implement, or `next` recommends it, and
`scripts/jflow run implement` returned `ready`. If it returned `blocked`,
quote each reason and stop. Accepting a plan does not authorize
implementing it: without recorded authorization, ask. If the block is
`git.changesOwned`, follow "Git" in `SKILL.md`.

**Run**, in order:

1. `scripts/jflow implement start` under ticket authorization. Under
   whole-plan authorization, use `scripts/jflow implement start <id>` and
   name the ticket. Before any ticket after the first, ask `escalate` at
   `next-ticket` (`references/DECISIONS.md`). A refusal means the ticket
   does not start. It may be unauthorized, another ticket may be in
   progress, or a dependency may not be done. Quote the reason. Never
   start a different ticket to get around it. The outcome gives the
   ticket's accepted criteria, `delegationLimits`, and the fix counter
   (`fix.attempts` of `fix.limit`).
2. Implement the ticket (Method below).
3. Run every check the ticket has. Write the evidence file outside the
   project, in the shape `references/DECISIONS.md` shows under
   "Validating a ticket". Once the ticket has failed before, also add
   `"recommendation"`: the next step you would suggest to the developer
   if this attempt fails too. The helper refuses the check without one
   when this attempt could reach the limit.
4. `scripts/jflow implement check <evidence.json>`. The helper records the
   evidence under `.jflow/evidence/<ticket>.json`, asks `validate`, and
   counts a `not-met`. Act on `validation.disposition`:
   - `admitted-to-review`: stop implementing. The ticket goes to `review`.
     Report what was done and the evidence.
   - `returned-to-fix`: fix what `criteria` shows as `not-met`, or add the
     check a criterion lacks. Then go back to step 3. `fix.attempts` says
     how many fixes have already failed.
   - `needs-check`: run the commands in `missingChecks`, add their output
     and go back to step 4. This is not a fix attempt.
   - exit 1 with `askHuman` (`awaiting-developer`, the fix limit, or Jev
     unavailable): put its reasons to the developer, with your
     recommendation, and wait. Do not try another fix first.

**Method**

Work on the started ticket only. Anything else you notice goes to
`scripts/jflow todo add`. It does not go into this ticket. Coordinate the
work as the primary agent. Sub-tasks that are independent of each other
may run in parallel, but only while `delegationLimits.allowParallelWithinUnit`
is true, with never more than `delegationLimits.maxParallelWorkers` running
at once. When it is false, work sequentially. Every worker stays inside
this ticket.

The ticket's checks are the commands whose results its acceptance criteria
depend on: the tests named in them, and the project's typecheck and test
suite. Record the output of each check exactly as it ran, with the exact
command as `source` and its exit code. Never record a diff or file
contents. Your own summary goes in as a `claim`. A claim never admits a
ticket.

A failed test is the normal reason to ask the developer during
implementation, but only once the fix counter reaches its limit. The
helper keeps that counter; never count attempts yourself. Do not change a
test or a criterion to make it pass. Setting a verdict aside goes through
`ticket override` with evidence (`references/DECISIONS.md`).

Never commit, and never mark the ticket done. The ticket stays
`in-progress` until it passes review. If the conversation loses the
ticket partway through, start it again and redo it from its definition.

**Report**: which ticket you worked on. Each criterion with its verdict.
The checks you ran and their results. Where the ticket went next (review,
another fix, or a question for the developer). Anything you recorded as a
todo.
