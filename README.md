# jflow

A JSON-defined workflow package that a primary conversational agent loads to
run one custom development workflow end to end.

See `SPEC.md` for the first-release specification, `TICKETS.md` for the
current ticket breakdown, and `CONTEXT.md` for project vocabulary.

## Status

Foundation slice only (issues #1 and #2; TICKETS.md T1–T5 decompose them):

- `workflow/jflow.workflow.json` — the single shipped workflow package: the
  action set, per-action roles, delegation limits, Git and code-edit rules,
  prerequisites, and the supported configuration surface.
- `src/workflow/` — workflow package types, loading, and validation.
- `src/config/` — configuration validation, defaults, and Jev API key
  resolution.
- `src/actions/` — workflow-action-contract resolution: workflow state in,
  eligible/blocked decision out. `status` is the first action that runs end
  to end, reading the state from project files.
- `src/project/` — walking-skeleton persistence of the workflow state in
  `jflow/state.json` (Git presence is observed from `.git`, never recorded).
  The full record store (plans, tickets, progress, lessons) is issue #3.
- `src/testing/` — the project-directory test harness: set up a directory in
  a known workflow state, run an action, assert the resulting files and the
  human-ask events raised. Test scaffolding, not library API.

The other workflow actions, the Jev client, the full project-record store,
Git/commit behaviour, and compound learning are not implemented yet.

## Invariants enforced in code

- Review always requires a role that is independent of the implementer; no
  workflow package or configuration can disable that gate.
- `troubleshoot` and `review` can never edit code.
- `implement` and `review` require a local Git repository; `brainstorm` and
  `plan` do not. jflow never initializes a repository or absorbs pre-existing
  uncommitted changes.
- Plan acceptance and execution authorization are distinct state flags.
- A stage worker model never falls back implicitly — the fallback must name an
  explicit model, otherwise jflow asks.
- The Jev API key is read from `JFLOW_JEV_API_KEY` or host secret storage, and
  is rejected if found in configuration. A missing key produces a question for
  the human, not a silent fallback.
- Raw traces are kept until explicit local cleanup and stay out of version
  control.

## Development

```sh
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
```
