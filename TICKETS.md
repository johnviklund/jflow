# jflow tickets — foundation slice

Date: 2026-09-19
Source: SPEC.md (draft, human-confirmed defaults 1-8)

**This file decomposes GitHub issues #1 and #2 only.** The authoritative
tickets are GitHub issues #1-#24; this is a working breakdown of two of them,
not a parallel ticket system. T1 and T5 belong to issue #1; T2, T3 and T4 all
belong to issue #2.

**Do not map T-numbers onto issue numbers.** They are different sets and the
numbering does not line up: T4 is configuration validation, whereas issue #4
is action dispatch; T5 is the test harness, whereas issue #5 is `brainstorm`.
A by-number mapping was made once and led to three unstarted issues nearly
being closed as delivered.

Scope of this breakdown: the **foundation slice** only — the JSON workflow
package, its validation, the configuration surface and its validation, and the
workflow-action-contract test harness (the seam named in SPEC.md's Testing
Decisions). Everything else in the first release (action implementations, Jev
client, project-record persistence, Git/commit behaviour, compound learning)
is out of scope here and will be planned separately.

Each ticket is a small, independently testable vertical slice intended to fit
one fresh context window (SPEC.md, "Ticket sizing as compaction mitigation").

## T1 — Project scaffold

**Goal**: a TypeScript + Node project with Vitest, typechecking, and a
`src/` + colocated-test layout, so later tickets have somewhere to land.

**Acceptance**
- `npm run typecheck` and `npm test` both run and pass on an empty suite.
- No runtime dependency is added that the spec does not require.
- Traces/local-only artifacts are gitignored (SPEC.md D23: raw traces stay out
  of version control).

**Depends on**: none.

## T2 — Workflow package definition (JSON)

**Goal**: ship the single JSON workflow package that declares the action set,
per-stage required roles and delegation limits, and the supported
configuration surface.

**Acceptance**
- Declares stage actions `brainstorm`, `plan`, `implement`, `troubleshoot`,
  `review`, `wrap` and always-available actions `status`, `next`, `todo`,
  `learn` (SPEC.md "Action set and semantics", D25).
- Each action declares: required roles, delegation limits, whether it may edit
  code (`troubleshoot`/`review`: no), whether it requires a Git repository
  (`implement`/`review`: yes; `brainstorm`/`plan`: no), and its prerequisites
  (e.g. `plan` requires an accepted specification, `implement` requires an
  accepted plan).
- `review` declares an independent reviewer role that is not satisfiable by
  the implementing agent (D31/D32).
- Declares the configuration surface: stage models, explicit fallbacks,
  delegation limits, retry limits, evidence-sharing controls, commit toggle.

**Depends on**: T1.

## T3 — Workflow package loading and validation

**Goal**: load and validate a workflow package, failing loudly with actionable
errors rather than silently weakening a gate (User story 50, confirmed
default 2).

**Acceptance**
- Valid shipped package loads and exposes actions by name.
- Structural errors (unknown action, missing required role, unknown
  prerequisite reference, duplicate action) produce actionable errors naming
  the offending path.
- A package that removes the independent-reviewer requirement from `review`
  is rejected — the separate-review gate cannot be disabled (D31/D32,
  confirmed default 2).
- `troubleshoot`/`review` declaring `canEditCode: true` is rejected.

**Depends on**: T2.

## T4 — Configuration surface and validation

**Goal**: validate user configuration against the workflow package's declared
surface before any action runs.

**Acceptance**
- Defaults applied: `commitOnSuccess` on (User story 35), Jev retry count 2
  after the initial attempt (confirmed default 3), review fix-retry limit 2
  (D10), traces kept until explicit cleanup (confirmed default 5).
- Jev retry count and review fix-retry limit are independent settings (D10,
  confirmed default 3).
- Per-stage worker models are configurable; the primary/conversational model
  is not switched per stage (D18, D19).
- A stage fallback model must be explicit; there is no implicit fallback
  (D20) — configuration expressing an implicit/automatic fallback is rejected.
- Unknown configuration keys and unknown stage names are rejected with
  actionable errors.
- Configuration that attempts to disable the review gate is rejected.
- The Jev API key is never read from configuration files; it is resolved from
  an environment variable or host secret storage, and a missing key yields a
  "ask the human how to configure it" outcome rather than a silent fallback
  (confirmed default 8).
- Evidence-sharing limits default to excluding credentials and full
  conversation/repository content (D22).

**Depends on**: T3.

## T5 — Workflow action contract test harness

**Goal**: establish the test seam SPEC.md asks for — given a workflow state
and a triggering request, assert the resolved action, its prerequisites, and
its authorization/human-ask behaviour, without testing agent prompt text.

**Acceptance**
- A harness builds a workflow state (accepted spec? accepted plan? execution
  authorization? Git repo present?) and resolves a requested action against
  the validated workflow package.
- Resolution reports: eligible / blocked-with-reason, required roles,
  delegation limits, and whether a human ask is required.
- Always-available actions (`status`, `next`, `todo`, `learn`) resolve as
  eligible in any state (D25).
- Acceptance and execution authorization are distinct state flags; plan
  acceptance alone does not authorize execution (User stories 7, 8).
- `implement` without a Git repository is blocked with an actionable reason
  (confirmed default 1).
- Only observable outcomes are asserted (state in, decision out) — no prompt
  wording (SPEC.md Testing Decisions).

**Depends on**: T4.
