# realign

**When**: the developer changes their mind about an accepted plan while
work is in flight ("change the plan", "new direction", "drop that, do this
instead"), and tells you to realign. Only the developer starts it. When
you, resume, or a review find a reason the plan should change, recommend
it instead (see Method) and wait. Never run realign on your own
judgment, and never treat a recommendation as the instruction.

**Run**:

1. Take in the new direction (see Method), then write a draft file
   outside the project:

   ```json
   {
     "direction": "Drop the date column; imports must also report skipped rows.",
     "changes": [
       { "action": "rescope", "ticketId": "T1", "acceptanceCriteria": ["a CSV file imports", "skipped rows are listed"] },
       { "action": "rescope", "ticketId": "T2", "title": "Import without dates" },
       { "action": "add", "ticketId": "T6", "title": "Skipped-row report", "acceptanceCriteria": ["the import lists skipped rows"], "dependsOn": ["T1"] },
       { "action": "park", "ticketId": "T4", "reason": "held until the export format is settled" },
       { "action": "withdraw", "ticketId": "T3", "reason": "the date column is dropped" }
     ],
     "recommendations": ["R-1"]
   }
   ```

   Name only the tickets the direction affects. Give `specification` (a
   whole revised specification draft, as for `brainstorm`) only when the
   direction changes it, and `plan` (`title`, `summary`) only when those
   change. `recommendations` lists the open recommendations this
   addresses.
2. `scripts/jflow realign <draft.json> --note "<the developer's words>"`.
   `--note` is their instruction to realign, as they said it. Read the
   result:
   - exit 0: the realign is recorded. `outcome.revalidated` lists each
     completed ticket whose criteria changed, with the `validate`
     disposition on its recorded evidence. Each is reopened (`ready`) and
     its review cleared, since the review covered the old criteria: an
     `admitted-to-review` one goes straight to review once work resumes,
     a `returned-to-fix` one needs fixing first.
   - exit 1 with `ok: true` and `askHuman`: recorded, but a re-validation
     waits on the developer. Put `askHuman` to them.
   - exit 1 with `ok: false` and `askHuman`: a completed ticket could not
     be re-validated (Jev unavailable, for example). Nothing was
     realigned. Put `askHuman` to them.
   - `ok: false` with `untestable`: `classify` confidently classed a new
     or changed criterion untestable, as `plan write` does. Rewrite it, or
     set it aside in `testabilityOverrides` with a reason and evidence.
     Nothing was written.
   - `ok: false` otherwise: a change did not fit its ticket. Fix the
     draft. A done ticket cannot be withdrawn, since its work is
     committed: add a ticket that undoes it.
3. The specification and the plan now await acceptance again, and the
   execution authorization has ended. Present both (see Report). Then
   record the developer's words in order:
   `scripts/jflow specification accept --note "…"`, then
   `scripts/jflow plan accept --note "…"`, and an authorization only when
   they give one (`--authorize`, or `plan authorize`). `implement` stays
   refused until then. If they want more changes first, run realign again
   on the realigned breakdown; `plan write` cannot replace it.
4. `scripts/jflow realign show` prints the recommendations and every
   realign so far.

**Method**: restate the new direction in one or two sentences and check
it with the developer before drafting. Then go through the breakdown
ticket by ticket (`scripts/jflow status`, `jflow/tickets.json`):
- Unaffected tickets are left out of the draft entirely. Their records
  stay as they are.
- A changed requirement is a re-scope: new criteria, title or
  dependencies. Criteria must stay testable, as in `plan`.
- New work is an added ticket; work that no longer belongs is withdrawn;
  work that should wait is parked with the reason.
- For a done ticket, change its criteria only when the direction really
  changes what it had to do. That re-validates it and reopens it for
  review, and possibly for a fix.

Realign edits no code and marks no ticket done. It does not start,
implement or review anything.

To recommend a realign rather than run it, when the records or a review
suggest the plan no longer fits, run
`scripts/jflow realign recommend --source resume|review|agent --summary "<what and why>" --evidence "<what it rests on>"`.
It records the recommendation (`R-n`) and changes nothing else. Tell the
developer what you recommend and why, and let them decide.

**Report**: give the direction, then each change by ticket id (re-scoped,
added, parked, withdrawn), each re-validated ticket with its outcome,
and the tickets left untouched. Say that the prior authorization ended
(quote it from `realignment.priorAuthorization`). Then ask the developer
to accept the specification and the plan, and whether to authorize
execution, and for which scope.
