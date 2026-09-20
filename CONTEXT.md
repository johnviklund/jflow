# jflow

Vocabulary carried forward from the agreed direction in PROJECT-BRIEF.md.

## Language

**Primary agent**:
The reasoning agent responsible for the user's conversation and for coordinating the assigned work.

**Workflow**:
The user's defined process for choosing and carrying out actions, including their prerequisites and stopping conditions.

**Workflow skill**:
A set of instructions supplying the method for a workflow action. jflow ships as one skill whose per-action instruction files the primary agent reads; they are verified by running them on the host, not by unit tests.

**jflow helper**:
The bundled command-line script the skill runs for the exact parts of the workflow: validation, record reads and writes, prerequisite and authorization checks, Jev calls and envelopes, the validate and escalate outcomes, the fix counter, replay, and the local commit. The workflow-action-contract seam tests the helper.

**Workflow orchestration**:
Coordination of workflow actions, supporting skills, and agent assignments through the primary agent as work progresses.

**Stage worker**:
An agent assigned work within a workflow stage using that stage's configured model, under the primary agent's coordination.

**Independent review**:
Assessment by a separate reviewer agent that did not implement the changes. The reviewer may use the same model as the implementer; self-review does not qualify.

**Brainstorm**:
The jflow action for investigating an idea or problem and defining what to build.
_Avoid_: what, as an action name

**Todo item**:
A recorded piece of future work outside the active plan. Capturing it does not authorize implementation or add it to the current assignment.

**Realign**:
The human-invoked jflow action for changing the plan while implementation is in flight. It reconciles the specification, tickets and progress with the new direction and re-enters acceptance; it implements nothing and the agent never runs it unasked.

**Decision authority**:
Whether a declared Jev decision is _binding_ (the workflow acts on the answer directly, subject only to a recorded evidence-based override and the hard rules) or _advisory_ (the primary agent weighs it). Declared per decision in the workflow package; never changes by drift.

**Escalation signal**:
Jev's binding answer, at a human-facing boundary, to whether the human must be asked before proceeding. "Proceed" means continue within existing authority; "escalate" means ask. Hard rules (consequential conflicts, continuing without Jev, acceptance gates) always ask and never reach Jev.

**Human-facing boundary**:
A point in the workflow where the human could be asked before proceeding, such as the next ticket under whole-plan authorization, a failed fix attempt, a disputed finding, a conflicting lesson, or a resume discrepancy.

**Validation**:
Jev's binding, per-criterion judgment of whether a ticket's recorded verification evidence satisfies its accepted acceptance criteria (met, not met, or insufficient evidence). The gate into independent review, never a substitute for it.

**Acceptance criteria**:
The testable conditions a ticket must satisfy, written by plan and accepted with the plan. A ticket without them is not a valid ticket.

**Model selection**:
Jev's advisory recommendation of a model and effort for a stage worker, chosen only from the models the user configured for that stage and their explicit fallbacks.

**Classification**:
Jev's advisory proposal of a class for a piece of workflow content: whether a discovered item is a todo or in scope, which part of the project a lesson applies to, or whether a drafted acceptance criterion is testable. Review finding disposition is not classified; a fixed rule decides it.

**Harness observation**:
A record of how the workflow itself behaved (a low-confidence answer, an override, a repeated escalation). Recorded automatically, applied never; the input to a question-file proposal.

**Question-file proposal**:
A proposed change to a Jev question or policy file, derived from harness observations and project lessons, with linked evidence and a replay report. Takes effect only when the human accepts it.

**Replay**:
Re-running a proposed question or threshold against the stored envelopes for that decision and reporting which answers would change. Gates a proposal; does not evaluate whether Jev is good.

**Compound learning**:
Retention and reuse of project lessons in later work, plus generating question-file proposals. Neither applies a change to workflow logic or Jev questions without human acceptance.

**Project lesson**:
Knowledge learned from work in a project that can inform relevant future tasks in that project.

**Intent**:
What the initiating actor requested, independently of the recommended next action.

**Recommendation**:
The suggested next action based on supplied evidence, judgments, and workflow rules. A recommendation does not grant authorization.

**Execution**:
What the agent actually did and the observed result.

**Decision envelope**:
A record connecting an initiating request and evaluated evidence to judgments, a recommendation, the chosen action, and its observed outcome.
