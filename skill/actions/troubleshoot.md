# troubleshoot

**When**: a check failed and its cause is not clear, whether during
`implement` or when the developer asks. `scripts/jflow run troubleshoot`
returns `ready` at any point. Troubleshoot diagnoses and recommends. It
never edits code, not even to try out a fix.

**Run**, in order:

1. Write the failure file outside the project:

   ```json
   {
     "check": { "source": "npm test -- parser" }
   }
   ```

   `source` is the exact command that failed, as it runs from the project
   root. Never put its output in the file; jflow runs it again itself. The
   ticket in progress is used unless you add `"ticketId"`.
2. `scripts/jflow troubleshoot start <failure.json>`. The helper runs the
   check, records its output and exit code as a diagnosis (`DIAG-1`,
   `DIAG-2`, …) and snapshots the working tree. A refusal means the check
   passed when jflow ran it, the file held output, it names no ticket in
   the plan, or it could not be recorded.
3. Diagnose it (Method below).
4. Write the diagnosis file outside the project:

   ```json
   {
     "id": "DIAG-1",
     "finding": "<what fails, and why>",
     "evidence": ["src/parser.ts:3", "<command>: <the output line that shows it>"],
     "recommendation": "<the fix you recommend>"
   }
   ```

5. `scripts/jflow troubleshoot record <diagnosis.json>`. The helper checks
   the working tree against the snapshot. If anything changed, it refuses
   and names the paths. Tell the developer exactly what changed. Do not
   undo it yourself. The developer decides what happens to it. With no Git
   repository the check cannot be made, so `treeCheck` is `unverified`.
   Say so.

**Method**

Investigate by reading and running, never by changing:

- Read the failing output closely: the first error, not the last.
- Read the code and the tests involved, and the ticket's criteria.
- Rerun the failing check, or a narrower one, to reproduce the failure. A
  run that writes only ignored build or cache output is fine. Anything
  that shows up as a change is not.
- Narrow the cause until you can name the line or condition responsible.

Each piece of evidence is a file and line, or a command with the output
line that shows the cause. Recommend one fix, stated so `implement` can
make it. If the cause touches requirements, scope, workflow rules or
permissions, say so. Changing those is the developer's decision
(`references/DECISIONS.md`, "Conflicts").

The fix is made only by `implement`, under the developer's authorization.
Once the fix is made, and before checking it, run `scripts/jflow implement
fix <id> --note "<what you changed>"`. The helper refuses without
recorded authorization, and for a diagnosis made for another ticket. Then
check the fix as `actions/implement.md` says. The ticket's review gets its
diagnoses as evidence.

**Report**: the failed check, the finding with its evidence, and the
recommended fix. Say whether the working tree was confirmed unchanged.
Say what happens next: the fix goes through `implement`, or authorization
is needed first.
