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
| `escalate` | binding | owned by its own issue |
| `validate` | binding | owned by its own issue |

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
