---
name: jflow
description: Run one development workflow end to end — brainstorm, plan, implement, troubleshoot, review, wrap, realign, with status, next, todo and learn available at any point — with precise gates, records and Jev decisions handled by a bundled helper.
---

# jflow

jflow is a workflow you run with your primary agent. This skill carries the
methods; the bundled helper carries the exact parts (validation, project
records, prerequisite and authorization checks, Jev calls, gates). Read the
method for an action in `actions/<action>.md`; run the helper for anything
that must be exact. Never work out a prerequisite, a counter or a record's
contents in your head when the helper can tell you.

## The helper

The helper is `scripts/jflow`. It runs `node` on the built `dist/cli.js`
two directories up, so this skill directory must stay inside the jflow
checkout, built once with `npm run build`. Every command prints one
JSON object on stdout. Exit code 0: the command ran. 1: the developer is
needed (blocked, ambiguous, unknown, invalid configuration). 2: the project
records or the workflow package cannot be read; stop and report the problem.

| Command | Use |
| --- | --- |
| `scripts/jflow status` | Where the project stands and which actions could run now. Always safe. |
| `scripts/jflow run <request…>` | Resolve a request to one action, check its prerequisites, run it if an executor exists. |
| `scripts/jflow validate [--config <file>]` | Check the workflow package and a configuration before doing anything. |
| `scripts/jflow check-host` | Which host capabilities are verified by execution, and which are not. |

Pass `--root <dir>` when the project is not the current directory.

## How a request reaches an action

1. If the developer named an action (`implement`, `/review`, "run status"),
   pass that name. If they described what they want ("where are we?",
   "break the spec into tickets") and you are sure which action it is, pass
   the name; if you are not sure, pass their words as they are. Never ask
   the developer to rephrase into a command.
2. Run `scripts/jflow run <name or words>`. The helper resolves the request
   to exactly one action or returns a question; it never guesses.
3. Read `outcome.kind`:
   - `completed`: report the result from the method file for that action.
   - `not-implemented`: the action is eligible; follow `actions/<action>.md`
     for the method. (Until an action's method file exists, tell the
     developer the action is eligible but not yet available.)
   - `clarify`: the request fits more than one action. Ask the developer
     the `question` verbatim. Never pick one for them.
   - `blocked`: refuse, quoting each `unmet` prerequisite's `reason`. Where
     `needsHuman` is true, the developer decides; do not try to clear it
     yourself. Acceptance of a plan is not authorization to execute it.
   - `unknown-action`: say no jflow action matches and list the actions.
   - `malformed-record`: name the file and the problem; change nothing.
4. `humanAsks` lists every point where the developer must be asked. Ask
   each one; do not continue past it.

## Rules the helper cannot enforce for you

The workflow package and the records enforce the gates; these are the
parts only the agent can honour.

- A bare "looks good" accepts a plan; it does not authorize executing it.
  Whole-plan authorization needs explicit words. Record what was said, not
  what you inferred.
- `review` is never done by the agent that implemented the change.
- `realign` is the developer's to invoke. Recommend it; never run it unasked.
- Secrets never go into project files or the conversation. If the helper
  reports the Jev API key missing, ask how to configure it rather than
  proceeding without Jev.

## Layout

- `actions/` — one method file per action. `status.md` exists; the others
  are filled in by the issue that owns each action.
- `references/HOST.md` — what has been verified on which host, and what has
  not. Consult it before claiming anything about the host.
- `scripts/jflow` — the helper.
