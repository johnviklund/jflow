# Jev decisions and conflicts

Jev makes seven declared decisions. Each has an authority fixed in the
workflow package:

| Decision | Authority | Asked |
| --- | --- | --- |
| `next-action` | advisory | by `next`, every time |
| `assignment` | advisory | before running stage workers you proposed |
| `lesson-retention` | advisory | before retaining a candidate project lesson |
| `model-selection` | advisory | owned by its own issue |
| `classify` | advisory | owned by its own issue |
| `escalate` | binding | at every human-facing boundary, through `scripts/jflow escalate` |
| `validate` | binding | after a ticket's checks run, through `scripts/jflow ticket validate` |

## Asking

Write an input file outside the project with `taskSummary`, `candidates`
and `excerpts` (each with `source` and `text`), then run
`scripts/jflow decide ask <decision> <input.json>`. Put in only what this
one decision needs: the unit of work, the options, and short excerpts with
their sources. Never paste a whole conversation, repository or secret. The
helper also bounds the packet.

- `decision.kind` is `needs-configuration`: ask the developer the
  `askHuman` question. Do not go on as if Jev had answered.
- `failed`: report the failure. What happens next is the developer's.
- `refused`: the name is not a declared decision. Do not invent one.
- `answered`: read `route`.

Every answer is stored as an envelope under `.jflow/envelopes/`. Quote its
`envelope` id whenever you report the answer.

## Routes

- `act` (binding): the workflow does what Jev answered.
- `weigh` (advisory): weigh the answer alongside your own evidence.
- `ask-human`: the answer is recorded but nothing relies on it. Either its
  confidence is below the threshold or its question wording is not accepted
  yet. Show the developer the answer and your own view, and let them decide.

## Recording the choice

Once the action is chosen, record it:

```
scripts/jflow decide choose <envelope> --action <a> --by workflow|agent|developer \
  [--reason "<why>"] [--evidence "<command, file or record it rests on>"]
```

- The helper checks prerequisites and authorization itself, and it refuses
  an action they do not permit. That holds even when Jev chose the action.
  Jev never grants authorization and never marks work complete.
- To choose something other than Jev's answer yourself (`--by agent`),
  give `--reason` and `--evidence`, on either route. A reason without
  evidence is refused.
- The developer's own decision needs only their words as `--reason`, with
  `--by developer`. Use `--by developer` only for what the developer
  actually said. Claiming it for your own choice skips the evidence check
  and breaks the record.
- On `ask-human` the choice is the developer's. Record it that way.

## Escalating at a boundary

Whenever the workflow could stop and ask the developer, ask `escalate`
first instead of asking on your own judgment. Write a boundary file outside
the project with `kind`, `summary` and `excerpts`, then run
`scripts/jflow escalate <boundary.json>`. The `kind` is one of:

- `next-ticket`: asked for you by `implement next` before starting the
  next ticket under whole-plan authorization; do not ask it yourself.
- `fix-failed`: asked for you by `implement check` when the ticket's fix
  counter reaches its limit; do not ask it yourself for a `not-met`.
- `review-dispute`: asked for you by `review record` when a blocking
  finding is disputed and the evidence does not settle it; do not ask it
  yourself.
- `lesson-conflict`: when a candidate lesson conflicts with a retained one.
- `resume-discrepancy`: when resume finds the records and the work disagree.
- `missing-check`: asked for you by `ticket validate`; do not ask it yourself.
- `other`: any other point where you would ask the developer.

The answer is binding:

- Exit 0, `"ask": false`: proceed within the authority you already have.
  Do not ask the developer. The helper has recorded the choice.
- Exit 1 with `askHuman`: put its reasons to the developer, with your
  recommendation, and wait. Record their answer with
  `scripts/jflow decide choose <envelope> --action proceed|escalate
  --by developer --reason "<their words>"`.
- To proceed past an `escalate` answer yourself, you need evidence that
  the concern is settled. Record it with `decide choose <envelope>
  --action proceed --by agent --reason ... --evidence ...`. A reason
  without evidence is refused. Below the threshold, only the developer
  can decide.

The hard rules are not escalation boundaries: a consequential conflict,
continuing without Jev, and the specification and plan acceptance gates.
Always ask the developer at these. If you pass one of them as the `kind`
(`consequential-conflict`, `continue-without-jev`,
`specification-acceptance`, `plan-acceptance`), the helper returns
`askHuman` without calling Jev. A missing key or a failed Jev call also
asks the developer, because continuing without Jev needs their approval.

## Validating a ticket

After the ticket's checks have run, write an evidence file outside the
project:

```json
{
  "ticketId": "T3",
  "evidence": [
    { "kind": "check", "source": "npm test", "text": "<the output>", "exitCode": 0 },
    { "kind": "claim", "source": "implementer", "text": "<what you did>" }
  ],
  "checks": ["npm test", "npm run typecheck"]
}
```

While implementing, run `scripts/jflow implement check <evidence.json>`
instead (see `actions/implement.md`): it records the evidence and counts a
`not-met` on the ticket's fix counter. Otherwise run
`scripts/jflow ticket validate <evidence.json>`. Evidence is
check output, with the exact command as `source`, or your own claim.
Never put a diff or file contents in it. `checks` lists every check the
ticket has, so the helper can tell which ones have not run yet. Jev judges
each accepted criterion separately. Act on `validation.disposition`:

- `returned-to-fix`: a criterion is not met, or no check covers it and
  `escalate` let you proceed. Fix it or add the missing check, run the
  checks again and validate again.
- `needs-check`: run the commands in `missingChecks`, add their output to
  the evidence and validate again.
- `admitted-to-review`: the ticket goes to review (`actions/review.md`).
- `awaiting-developer` (exit 1): put `askHuman` to the developer and wait.

Only every criterion `met` admits a ticket. Your own claim never does, and
with only a claim Jev is not asked. Output that is a diff is refused.
To set a verdict aside, run `scripts/jflow ticket override <ticket>
--criterion <n> --verdict <v> --by agent --reason "<why>" --evidence
"<what it rests on>"`. `--criterion` counts from 0. A reason without
evidence is refused. If a verdict came from a below-threshold answer, only
the developer can set it aside (`--by developer`, with their words).

## Review findings never go to Jev

A review finding's disposition follows a fixed rule, never a Jev answer.
A requirement, correctness or standard finding blocks the ticket. An
improvement becomes a todo. Never ask `classify` or any other decision
what a finding is. Only a disputed finding that its evidence does not
settle reaches Jev, through `escalate` at `review-dispute`. A dispute that
touches requirements, scope, workflow rules or permissions is a
consequential conflict and goes to the developer. See `actions/review.md`.

## Conflicts never go to Jev

When a disagreement touches requirements, scope, workflow rules or
permissions, it is consequential. Record it with
`scripts/jflow conflict raise <draft.json>`, where the draft holds a
`summary` and the `touches` list. The command exits 1 and returns
`askHuman`. Explain the conflict, recommend a resolution, and wait. Then
record the developer's words with
`scripts/jflow conflict decide <id> --note "<their words>"`.

Settle an ordinary technical disagreement by investigating it: run the
test, read the code, reproduce the behaviour. Then raise it with
`touches: []` and `investigation` (`finding`, `evidence`, `conclusive`).
If the investigation settles it, the helper records the resolution. If it
is inconclusive, the helper asks the developer. When the choice does not
materially affect the outcome, pick one, note why, and do not raise it.
Never ask Jev to settle either kind.
