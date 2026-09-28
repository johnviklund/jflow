# jflow status — 2026-09-28

Where the project stands after the ChatGPT desktop trials, and what comes
next. Read this first in a new session.

## Where the code is

- All work is committed and pushed to the branch **`host-trials`** on
  GitHub. It is 57 commits ahead of `main`, which still holds the state
  before the trials.
- GitHub issues #1–#35 are delivered but still show as open, because their
  commits are not on `main` yet. They close when `host-trials` reaches
  `main`. #24 is closed.
- `npm test` passes (819 tests). `npm run build` must be run after pulling,
  because `dist/` is not in Git.

## The first release: what is done

- Every planned ticket, #1–#31, plus the follow-up plan #32–#35.
- All 14 release demonstrations run as automated tests (the helper side of
  #23).
- In ChatGPT desktop 26.908.70816 on Linux, four trial projects ran end to
  end (`~/Work/jflow-trial`, `-trial2`, `-trial3`, `-trial4`). They showed
  demonstrations 1, 2, 5, 8, 9 and 10 working, and a 244-second check
  through `implement check` (#35's last criterion; see its comment).

## The first release: what is left

The instruction side of #23: these demonstrations have not been seen in
the app.

| Demonstration | How to trigger it |
| --- | --- |
| 3 Parking | Say "park this" when a ticket starts; an independent ticket should go on. |
| 4 Resume | Close the conversation mid-plan; say "resume" in a new one. |
| 6 Jev outage | Remove or rename `~/.config/jflow/jev-key` for one step. |
| 7 Lessons | Ask the agent to record a lesson, then start a related task. |
| 11 Realign | Change your mind about the plan mid-implementation. |
| 12 Question-file proposal | Ask the agent to propose a change from the observations. |
| 13, 14 Binding authority, model selection | Not seen in the app yet. |

Recommended: one short, scripted trial of two or three tickets that does 3,
4, 6 and 7 on purpose. Also untested: macOS and Copilot Desktop.

## Deliberately left for release 2

Whether Jev makes the workflow better at all (RELEASE-SCOPE.md, D36). The
planned way to answer it is a comparison, not yet started:

- **Arms:** A, ChatGPT desktop without the jflow skill; B, with jflow;
  later C, jflow without Jev.
- **Setup:** the same task text word for word, with an exact command-line
  contract; your answers scripted in advance; a new folder and conversation
  per run; 2 tasks × 2 arms × 2 runs.
- **Measures:** tokens summed from the app's session logs
  (`~/.codex/sessions`, main conversation plus sub-agents, by a script that
  prints totals only); a hidden test suite per task; a blind review against
  a fixed checklist; the number of questions to you; wall-clock time.
- **Expectation:** jflow will use more tokens; any gain would be in
  correctness and fewer interruptions.

## What changed during the trials

Recorded in the commits, SPEC.md (D44 and confirmed default 8) and
DISCOVERY.md. In short:

- **Evidence:** the helper runs every check itself (`implement check`,
  `ticket validate`, `resume verify`, `troubleshoot start`) and records the
  real output; agents cannot summarize it. There is a time limit
  (`checks.timeoutMs`), and the whole process group is stopped at it.
- **Criteria:** one condition per criterion; tests named in the criterion's
  own words; how code or tests are built goes in a ticket's `reviewNotes`,
  not in criteria; a criterion holds only its own ticket's work. With these
  rules, validate reached 0.97–1.00 in trial 4.
- **The next-ticket gate:** rules start an ordinary ticket; Jev is asked
  only when a start is unusual (a parked ticket, an independence check, an
  open resume discrepancy, a failed fix attempt, a verdict the agent set
  aside, or no passed review). The next-ticket threshold is 0.90 (proposal
  P-1).
- **Transparency:** every command lists the Jev decisions it asked in
  `jevDecisions`, and the agent reports each one. Every start says
  `startedBy` and why.
- **Setup:** the Jev key is read from `~/.config/jflow/jev-key`. Default
  models live in `~/.config/jflow/config.json`, and a project's
  `jflow/config.json` overrides them. You are asked for models at
  authorization if none are set. Jev is pinned to `jev-1.13.0`.
- **Learning across projects:** workflow problems go to
  `~/.config/jflow/workflow-feedback.md`, in workflow terms only, with
  nothing from the project. Bring it here and decide what changes.
- **Measured:** adding plain-language descriptions to Jev's options made no
  measurable difference (a replay over 93 stored decisions with a control).
  Asking Jev the same thing twice drifts only about 0.02–0.03, so low
  confidence comes from what is sent, not from chance.

## Next steps, in order

1. Decide whether to merge `host-trials` into `main`. That also closes
   issues #1–#35.
2. The scripted trial for demonstrations 3, 4, 6 and 7, if possible on the
   MacBook.
3. The with/without comparison (release 2).
