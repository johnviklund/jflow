# plan

**When**: the specification is accepted and there is no accepted plan, or
`scripts/jflow run plan` returned `ready`. If it returned `blocked` on
`specification.accepted`, say so and go back to `brainstorm`; do not draft
tickets against an unaccepted specification.

**Run**, in order:

1. `scripts/jflow run plan` — confirm it is `ready`.
2. Draft the breakdown (Method below), write it to a JSON file outside
   the project's working tree (a temporary directory) and run
   `scripts/jflow plan write <draft.json>`. A draft left in the project is
   an uncommitted change with no owner, and `implement` will stop to ask
   about it. It lands as
   `awaiting-acceptance` with every ticket `ready`. A refusal naming
   `tickets[n].acceptanceCriteria` means that ticket has no criteria: write
   them or merge the ticket away; never present a breakdown the helper
   refused. A refusal naming `realign` means the plan is already accepted
   and the developer is changing it: recommend `realign` and stop.
3. Present the breakdown and ask for acceptance. Then record exactly what
   the developer said:
   - "looks good", "accepted", "fine" and the like:
     `scripts/jflow plan accept --note "<their words>"`. This accepts and
     authorizes nothing; `implement` will ask.
   - "approved, implement the whole plan":
     `scripts/jflow plan accept --note "<their words>" --authorize plan`.
   - "approved, implement ticket 1":
     `scripts/jflow plan accept --note "<their words>" --authorize ticket --ticket T1`.
   - Authorization given later, after a bare acceptance:
     `scripts/jflow plan authorize --scope plan|ticket [--ticket <id>] --note "<their words>"`.
   Record only what was said; `--note` is stored as the authorization's
   basis. If you cannot tell whether they authorized, ask; do not pick the
   wider reading.

**Method**

Each ticket is a vertical slice: it cuts through every layer the feature
needs (data, logic, interface, test) so that it is independently
verifiable on its own, not a single layer that only means something once
the other layers land. Size each one to fit comfortably in a fresh context
window; if a session is lost mid-ticket, redoing it from its definition
should be cheap. A ticket that "looks small" can still blow out; err
smaller.

For each ticket give:

- `id` — short and stable (`T1`, `T2`…).
- `title` — what the developer gets when it is done.
- `acceptanceCriteria` — one or more conditions that `validate` can judge
  from recorded evidence (a test result, a check's output, a file that
  exists). "Works correctly" is not a criterion; "`npm test` passes with
  the new `export.test.ts` green" is. If you cannot say what evidence would
  satisfy it, rewrite it or drop the ticket.
- `dependsOn` — the ticket ids that must be done first. Keep it minimal;
  the helper refuses a cycle.

Order tickets so the first delivers something the developer can see. Put
into `summary` how the tickets add up to the specification, and into
`source` where the specification lives.

**Report**: list the tickets with their criteria and dependencies, then
ask for acceptance in a way that leaves the developer free to accept
without authorizing. After recording, say back what was recorded: accepted
or not, and whether execution is authorized and for what.
