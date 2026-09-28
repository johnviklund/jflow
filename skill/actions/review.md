# review

**When**: `implement check` returned `admitted-to-review`, `next`
recommends `review`, or the developer asked for it and
`scripts/jflow run review` returned `ready`. If it returned `blocked`,
quote each reason and stop. A ticket that has not passed `validate` with
every criterion met is never reviewed. Validation is the gate into review
and never replaces it. The integrated review of a whole plan comes once
every ticket is done: `implement next` returns `needs-plan-review`, or
`next` recommends `review` for the plan (Method below).

**Run**, in order:

1. `scripts/jflow review start`. A refusal means the ticket is not
   admitted. Quote the reason and go back to `implement`. The outcome
   gives the ticket and its criteria, the `validation` verdicts, the
   `evidence` file, `implementers` (agents that may not review),
   `stageModel` (the reviewer's model), `previousReview` on a re-review,
   and the fix counter.
2. Run the reviewer (Method below) and collect its findings.
3. Write the review file outside the project:

   ```json
   {
     "ticketId": "T3",
     "reviewer": { "agent": "reviewer-t3-1", "model": "<the model it ran on>" },
     "findings": [
       { "kind": "correctness", "summary": "…", "evidence": ["src/x.ts:42"] },
       { "kind": "improvement", "summary": "…", "evidence": ["src/x.ts:10"] }
     ],
     "recommendation": "<next step for the developer, once the ticket has failed before>"
   }
   ```

   Record every finding the reviewer made, with its own kind. If you
   dispute a blocking one, add a `dispute` to it (see Method). Once the
   ticket has failed before, in validation or review, include
   `recommendation`. The helper refuses a review whose blocking finding
   could reach the fix limit without one.
4. `scripts/jflow review record <review.json>`. Act on `review.disposition`:
   - `passed`: the ticket has passed review. Report it, then complete it
     with `scripts/jflow implement complete` (`actions/implement.md`,
     step 5). Do not commit or mark it done yourself.
   - `returned-to-fix`: go back to `implement` and fix every `blocking`
     finding. The ticket's validation is cleared, so the fix goes through
     `implement check` again before it is re-reviewed. `fix.attempts`
     says how many fixes have already failed.
   - `awaiting-developer`, or exit 1 with `askHuman` (a disputed finding,
     the fix limit, or Jev unavailable): put its reasons to the developer,
     with your recommendation, and wait. Record their decision on each
     disputed finding with `scripts/jflow review decide <ticket> --finding
     <id> --outcome upheld|withdrawn --note "<their words>"`. Add
     `--recommendation` if upholding could reach the fix limit.

**Method**

The reviewer is a different agent from whoever implemented the ticket.
Never review your own implementation, and never reuse or continue a
worker that worked on it. Those are the `implementers`, and the helper
refuses them. Spawn a new sub-agent on `stageModel`, recorded as a
stage worker with role `reviewer` (`SKILL.md`, "Stage workers"). It may
be the implementer's model. Give it a fresh context
that holds only:

- the ticket's title and accepted criteria;
- the ticket's `reviewNotes`, when it has them: how the code or its tests
  must be built, which no check could show and `validate` therefore did
  not judge. The reviewer checks each one in the code, and one that does
  not hold is a `requirement` finding;
- the project's standards (its agent instructions and any documented
  coding standards);
- the ticket's changes, as the reviewer reads them from the working tree
  itself (for example `git diff`);
- the recorded verification evidence and the `validation` verdicts;
- `diagnoses`: each failed check's diagnosis and whether its fix was
  applied;
- on a re-review, `previousReview`'s blocking findings, to check again.

Do not give it the conversation, your reasoning, or your own view of the
changes. Ask it for findings, each with a kind and the evidence it rests
on (file and line, a command and its output, a criterion):

- `requirement`: an accepted criterion or requirement is not met.
- `correctness`: the change is wrong, whatever the criteria say.
- `standard`: a mandatory project standard is broken.
- `improvement`: anything optional. The helper files it as a todo. It
  never blocks the ticket or widens it.

The helper decides each finding's disposition by this fixed rule. Never
ask Jev (`classify` or any other decision) what a finding is, and never
reclassify a reviewer's finding to change its disposition. The reviewer
never edits code. Fixes go through `implement`.

Dispute a blocking finding only when you have a reason. Add
`"dispute": { "reason": "…", "evidence": ["…"] }` to it:

- If your evidence settles it (a test run, a spec line, a reproduction),
  add `"conclusive": true`. The finding is withdrawn, and your evidence is
  recorded. A dispute without evidence is refused.
- If it does not settle it, leave `conclusive` out. The helper asks
  `escalate` at `review-dispute`. A confident `proceed` keeps the finding
  blocking. Otherwise the developer decides.
- If resolving it would change requirements, scope, workflow rules or
  permissions, add `"touches": ["scope"]` (or the areas it touches). This
  is a consequential conflict. The helper records it and asks the
  developer without calling Jev. `review decide` resolves the conflict too.

Once every ticket of a plan with more than one ticket is done or
withdrawn, the plan is not complete until an integrated review passes.
It uses the same steps with `review plan`:

1. `scripts/jflow review plan start`. The outcome gives every ticket with
   its criteria and commit, `planCriteria` (the plan's acceptance
   criteria), `implementers` (every agent that worked on any ticket; none
   of them may review), `stageModel`, and `previousReview`.
2. Spawn a new reviewer on `stageModel`, recorded as a stage worker with
   role `reviewer` and no `ticketId`, distinct from every implementer. Give it the tickets, `planCriteria`, the project's
   standards, and the changes across the plan's commits. Ask it for
   findings in how the tickets work together, and against `planCriteria`,
   not the per-ticket findings already reviewed.
3. Write the review file with `reviewer` and `findings` (no `ticketId`),
   the same kinds and disputes as above. Run `scripts/jflow review plan
   record <review.json>`.
4. `passed`: the plan is complete. Unless `commitOnSuccess` is off, the
   helper also commits the changed records under `jflow/` in one local
   commit (`commit.hash`, `commit.paths`) with a `Jflow-Plan` trailer;
   nothing else is included and nothing is pushed. If Git refused it,
   `askHuman` says why and the records stay uncommitted. `wrap` comes
   next; its `jflow/resume.json` stays uncommitted. `returned-to-fix`:
   a blocking finding holds the plan. Fixing it is new work, which
   `realign` adds. Record that with `scripts/jflow realign recommend
   --source review --summary "<the finding and why it needs new work>"`,
   which starts nothing. Put `askHuman` to the developer with your
   recommendation, and wait. If the developer decides a blocking finding
   is not to be fixed, record their words with `scripts/jflow review plan
   decide --finding <id> --outcome withdrawn --note "<their words>"`.
   `awaiting-developer`: record their decision on each disputed finding
   the same way, with `--outcome upheld|withdrawn`.

A plan review counts only for the tickets it covered. Once `realign`
adds or changes tickets, the plan needs a new integrated review. Until
then, a blocked plan takes no second review.

A plan with one ticket needs no integrated review. `review start` then
returns `scopes: ["ticket", "plan"]` and `planCriteria`. Give the
reviewer both, so its one review covers the ticket and the plan.

**Report**: the ticket or the plan, the reviewer (agent and model), and
each finding with its kind and disposition. Include each todo filed and
each dispute with how it was settled. Say where the work went next: for a
ticket, passed, back to fix (with the fix counter), or a question for the
developer; for the plan, complete, held for new work, or a question for
the developer.
