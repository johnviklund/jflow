# learn

**When**: the developer asks to keep a lesson ("remember that", "we
learned", "record that"), or work has shown something about this project
that later work in the same area should know. Examples: a check that only
passes after a setup step, a module that breaks when used a certain way,
or a fix that worked when the obvious one did not. It can run at any
point, including in the middle of another action.

**Run**:

1. Write a lesson file outside the project:

   ```json
   {
     "statement": "Reset the fixture clock before each parser test.",
     "scope": "src/parser tests",
     "evidence": [
       { "kind": "commit", "reference": "a1b2c3d" },
       { "kind": "check", "reference": "npm test -- parser: 3 failed before, 12 passed after" }
     ],
     "touches": ["L-2"],
     "conflictsWith": []
   }
   ```

   `touches` and `conflictsWith` hold the ids of accepted specification
   decisions (`D1`) or retained lessons (`L-2`). Leave them out when there
   are none. Then run `scripts/jflow learn propose <lesson.json>`. The
   helper records the lesson as a candidate (`L-n`) and asks Jev's
   advisory `lesson-retention` decision. Read `outcome.next`:
   - `decide`: weigh `outcome.advice` and record your decision (step 2).
   - `developer` (exit 1): the lesson conflicts with an accepted decision
     or a retained lesson, and `escalate` asked the developer. Put
     `askHuman` to them and wait. Then record their decision
     with `--by developer --reason "<their words>"`.
   - `decided`: the lesson conflicts, and `escalate` proceeded without
     the developer. The lesson stays a candidate and what it conflicts
     with stands. Nothing more to do, unless the developer later says to
     retain it (`--by developer`).

   If `advice.kind` is `needs-configuration` or `failed` (exit 1 while
   the developer is needed), handle it as `references/DECISIONS.md` says.
   The lesson is already recorded as a candidate.
2. `scripts/jflow learn decide <id> --outcome retained|candidate --by
   agent --reason "<why>" [--evidence "<what it rests on>"]`:
   - `retained` makes the lesson active. `candidate` keeps it recorded but
     never applied.
   - Against Jev's answer (`retain` or `discard`), give `--reason` and
     `--evidence`. A reason without evidence is refused.
   - When the advice's route is `ask-human` or Jev could not answer, you
     may keep the lesson a candidate. To retain it, you need either the
     developer's words (`--by developer`) or your own assessment. Record
     the assessment with `scripts/jflow jev assess` and pass its id as
     `--assessment A-n`.
3. `scripts/jflow learn list` shows every lesson with its advice and
   decision.

**Method**: a lesson is kept only when it meets all three criteria:
- evidence-backed: a commit, a check's output, a file and line, or a
  record shows it, not an impression;
- clearly scoped: it names the part of the project where it applies;
- consistent with what was accepted: it contradicts no accepted decision
  and no retained lesson.

Write the statement so that someone can act on it without this
conversation. Keep the evidence to links: the command and what it
printed, the commit, the path. Put no diff or file contents in it, and
nothing secret.

Seen once, cause unknown, or "probably" is speculative. Keep it a
candidate. If it contradicts an accepted decision, list that decision
in `conflictsWith`, even if you think the lesson is right. The decision
is never changed by `learn`, even when the developer retains the lesson.
If the decision itself should change, that is `realign` (or a new
`brainstorm`), and only the developer can invoke it.

Lessons are project knowledge only. A lesson about the workflow, its
gates, Jev's questions or its policy is refused: such changes come only
through a question-file proposal that the developer accepts. A retained
lesson never lifts a gate, never skips review and never grants
authorization.

**Report**: say what was saved, where (`report.record`), its id, whether
it was retained or kept as a candidate, and its evidence links. Quote the
`lesson-retention` envelope. For a conflict, name the decision that
stays unchanged (`report.unchanged`). Then return to what you were doing,
exactly where you left off.
