# status

**When**: the developer asks where things stand ("status", "where are we?",
"how far along is the plan?"), or you need to know which actions could run
before recommending one.

**Run**: `scripts/jflow status` (add `--root <dir>` if the project is not
the current directory).

**Method**: none beyond the helper. `status` reads project files only and
writes nothing.

**Report** the JSON as a short summary:

- `report.project` is `uninitialized`: say jflow has no records here yet and
  that `brainstorm` is the way in.
- `report.project` is `initialized`: say which of specification, plan and
  execution are accepted or authorized (`report.state`), which ticket is
  assigned, and which actions are `eligible` (`report.actions`). For each
  blocked action the developer might care about, give the `reason` of its
  first unmet prerequisite.
  If `report.jev.fallback.status` is not `off`, say so. Either the
  workflow is waiting for approval to continue without Jev, or it is
  continuing without Jev under the recorded scope.
- `report.project` is `malformed`: name `report.path` and `report.problem`.
  Offer no state, no eligible actions and no repair; the developer decides
  what to do with the file.

Do not infer state from the conversation; the record is authoritative.
