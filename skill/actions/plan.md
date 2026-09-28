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
   `plan write` asks Jev's `classify` (testability) about every criterion
   first and records each answer on its ticket. A refusal with
   `untestable` lists criteria Jev confidently classed untestable. Rewrite
   each one so a check's output can show it met or not met, then write
   again. Only if you have evidence that a criterion can be checked as
   written, set the answer aside: add `"testabilityOverrides":
   [{"ticketId": "T2", "criterion": 1, "reason": "<why>", "evidence":
   ["<what it rests on>"]}]` to the draft (`criterion` counts from 0).
   Never present a breakdown with an untestable criterion. An answer
   below the threshold blocks nothing; mention it when you present the
   breakdown.
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
4. A recorded authorization reports `stageModels`: the model each stage
   it will run sub-agents in uses, from the developer's defaults
   (`~/.config/jflow/config.json`) or this project's `jflow/config.json`,
   which overrides them. Tell the developer which models the work will use,
   and that they can name others for this plan.
   With `missingStageModels` (exit 1, with `askHuman`) a stage has no
   model at all: `implement` (one sub-agent per ticket under whole-plan
   authorization) or `review` (always). Ask the developer which model each
   stage should use, and whether it is for this project only or their
   default for every project. Start nothing until they answer. Write it
   under `stageModels` in `jflow/config.json` or in their defaults file,
   for example
   `{"stageModels": {"implement": {"model": "<model>"}, "review": {"model": "<model>"}}}`,
   keeping anything already in the file, and run `scripts/jflow validate`.
   A model named for this plan only goes into `jflow/config.json`. Never
   pick the models yourself.

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
  satisfy it, rewrite it or drop the ticket. A criterion about
  documentation or other text (a README section, help output, a
  changelog) names the check that proves it, for example "a test asserts
  README.md has sections for usage, JSON fields and exit codes".
  `validate` never sees file contents, so without such a check the
  criterion always comes back unproven and goes to the developer.

  One condition per criterion. `validate` judges each criterion as a
  whole and answers `met` only when it is sure of every part, so a
  criterion listing many conditions ("numbers align right, empty cells
  stay empty, pipes are escaped, …") comes back unsure even when every
  test passes. Write each condition as its own criterion, one a single
  test name or check result can show. A ticket with many conditions has
  many criteria, which is fine; if it has too many to check comfortably,
  split the ticket.

  A criterion states what the software does, never how the code or its
  tests are built: which module a test imports or avoids, whether it goes
  through the public interface, which ticket it can run without, or that
  an error is "useful". No check's output can show such a condition, so
  it always comes back unproven. Put it in the ticket's `reviewNotes`
  instead: the reviewer checks those in the code. Keep criteria to
  behaviour a test name or check result shows.

  A command written in a criterion is the command that proves it. Write
  it exactly as it will run from the project root, and name it only when
  that exact command matters; otherwise name the test or the behaviour
  and leave the command to the ticket's checks.

  A ticket's criteria hold only what that ticket delivers. Never require
  something a later ticket builds (a test, a command, a README section
  about it): its ticket carries that criterion. Read each ticket's
  criteria against its `reviewNotes` and against the tickets that depend
  on it, and move anything that belongs later.
- `dependsOn` — the ticket ids that must be done first. Keep it minimal;
  the helper refuses a cycle.
- `reviewNotes` (optional) — how the code or its tests must be built, one
  note each ("the tests go through the public argument parser", "the
  tests never import the renderer"). The reviewer checks them; they are
  not criteria.

Order tickets so the first delivers something the developer can see. Put
into `summary` how the tickets add up to the specification, and into
`source` where the specification lives.

**Report**: list the tickets with their criteria and dependencies, then
ask for acceptance in a way that leaves the developer free to accept
without authorizing. After recording, say back what was recorded: accepted
or not, and whether execution is authorized and for what.
