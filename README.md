# jflow

A JSON-defined workflow package that a primary conversational agent loads to
run one custom development workflow end to end.

See `SPEC.md` for the first-release specification, `TICKETS.md` for the
current ticket breakdown, and `CONTEXT.md` for project vocabulary.

## Status

Foundation slice (issues #1–#3; TICKETS.md T1–T5 decompose #1 and #2):

- `workflow/jflow.workflow.json` — the single shipped workflow package
  (schema version 2): the action set, per-action roles, delegation limits,
  Git and code-edit rules, prerequisites, the supported configuration
  surface, and the seven declared Jev decisions with their `authority`,
  `basis` and policy thresholds (D37, D43).
- `workflow/questions/` — one question file per declared decision. These are
  versioned skeletons: the package validates that they resolve and are
  well-formed; the wording of each is proposed for acceptance by the issue
  that owns the decision (#17, #25, #26, #28, #29).
- `src/workflow/` — workflow package types, loading, and validation;
  `policy.ts` routes an answer above or below a declared threshold without
  any code or test treating the number itself as correct.
- `src/config/` — configuration validation, defaults, and Jev API key
  resolution.
- `src/actions/` — workflow-action-contract resolution: workflow state in,
  eligible/blocked decision out. `status` is the first action that runs end
  to end, reading the state from project files.
- `src/project/` — the authoritative record store (issue #3): one JSON file
  per record kind under `jflow/` — `plan`, `tickets`, `progress`, `lessons`,
  `jev` (fallback status: off, awaiting approval with the pending decision
  kept, or approved for a recorded scope) and `resume` — read and written
  through `readRecord`/`writeRecord`. Schemas are closed, so a raw Jev trace
  has no field of its own; a credential-looking key or value is refused on
  write; each write goes through a temporary file and rename; a malformed
  record is reported with the offending paths and never read as empty. `state.ts` derives the resolver's `WorkflowState`
  from the `progress` record (Git presence is observed from `.git`, never
  recorded).
- `src/validation.ts` and `src/secrets.ts` — the shared issue collector and
  field validators, and the one definition of what counts as a credential,
  used by the package loader, configuration and the record store.
- `src/testing/` — the project-directory test harness: set up a directory in
  a known workflow state, run an action, assert the resulting files and the
  human-ask events raised. Test scaffolding, not library API.

The other workflow actions, the Jev client, Git/commit behaviour, and
compound learning are not implemented yet.

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
  control; project records carry trace references only.
- A superseded lesson must name its successor and the evidence; an approved
  Jev fallback and an authorized execution must record their scope; a parked
  ticket must record why.
- Every declared decision carries an `authority` and a `basis`, and every
  policy entry a `basis`; a version-1 package carrying `decisions` or
  `policy` is rejected rather than widened. No test asserts a threshold's
  value.

## Development

```sh
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
```
