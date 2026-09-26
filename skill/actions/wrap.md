# wrap

**When**: the developer ends the session ("wrap up", "let's stop here",
"save where we are"), or before you stop in the middle of work for any
reason. Run it even when nothing seems left open. The next session knows
only what the resume record says.

**Run**:

1. Compare the work with the records first (see Method). Then write a
   draft file outside the project:

   ```json
   {
     "summary": "T2's date parsing is half done: ISO dates parse, the timezone test still fails.",
     "nextSteps": [
       "finish T2's timezone handling in src/parser.ts",
       "run npm test -- parser, then implement check"
     ],
     "discrepancies": [
       { "ticketId": "T1", "summary": "npm test -- importer fails on main although T1 is done" }
     ]
   }
   ```

   Leave out `discrepancies` when you found none.
2. `scripts/jflow wrap <draft.json>` writes `jflow/resume.json`. The
   helper adds what the records say: the plan and its authorization,
   every ticket's outcome (with the active ticket's fix attempts,
   validation and review), parked tickets with their blockers, open
   todos, lesson state, a Jev fallback waiting for approval, the paths
   with uncommitted changes, and what `next` recommends. It also compares
   the records with the repository, for example a done ticket whose
   commit is missing, or uncommitted changes that no one owns.
   Discrepancies recorded earlier and still open are carried over. Read
   `outcome`:
   - exit 0: the record is written and nothing disagrees.
   - exit 1 with `ok: true`: the record is written, and
     `outcome.discrepancies` lists where the records and the project
     disagree. Report every one to the developer. Do not fix any of them.
   - `ok: false`: name the record or the problem it gives. Nothing was
     written.
3. `scripts/jflow wrap show` prints the resume record.

**Method**: before you write the draft, compare what actually happened
with the records:
- For each ticket you worked on this session, check that its recorded
  status matches the work. If you ran checks, note in the draft any whose
  result disagrees with a recorded status.
- Open todos, parked tickets and their blockers, and lessons still
  waiting for a decision or for the developer are carried over as they
  are. Do not decide them now to make the record tidy.
- A lesson candidate you meant to decide: decide it with `learn` before
  wrapping, or leave it open.

Write the summary and next steps for someone who has only the records:
name files, commands and ticket ids, and say where you stopped and what
was about to happen. Put nothing secret in them, and no diff or file
contents.

When a discrepancy means the plan itself no longer fits (a requirement
the tickets do not cover, work that turned out unnecessary), also record
`scripts/jflow realign recommend --source resume --summary "…"`. It starts
nothing; the developer decides whether to realign.

A discrepancy is reported, never reconciled. Do not change a ticket's
status, rewrite a record, or discard or commit changes to make the
records and the project agree. That is the developer's to decide, or
the next session's to check when it resumes.

`wrap` never pushes, merges, publishes or deletes anything, and never
cleans up raw traces (`traces clean` runs only when the developer asks).
It makes no commit. Uncommitted work stays as it is, and the resume
record says so.

**Report**: say the resume record was written (`outcome.record`), give
the summary and next steps in two or three lines, and list open todos,
parked tickets, undecided lessons and lessons waiting on the developer by
id. Mention a Jev fallback waiting for approval. Then list
every discrepancy with its source, and say that nothing was reconciled.
Say that `jflow/resume.json` is left uncommitted: the next ticket's commit
includes it, and when no ticket is left, the developer commits it or leaves
it.
