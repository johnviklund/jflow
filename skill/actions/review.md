# review

**When**: `implement check` returned `admitted-to-review`, `next`
recommends `review`, or the developer asked for it and
`scripts/jflow run review` returned `ready`. If it returned `blocked`,
quote each reason and stop. A ticket that has not passed `validate` with
every criterion met is never reviewed. Validation is the gate into review
and never replaces it.

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
refuses them. Spawn a new sub-agent on `stageModel` when one is
configured. It may be the implementer's model. Give it a fresh context
that holds only:

- the ticket's title and accepted criteria;
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

**Report**: the ticket, the reviewer (agent and model), and each finding
with its kind and disposition. Include each todo filed and each dispute
with how it was settled. Say where the ticket went next: passed, back to
fix (with the fix counter), or a question for the developer.
