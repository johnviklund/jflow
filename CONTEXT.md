# jflow

Vocabulary carried forward from the agreed direction in PROJECT-BRIEF.md.

## Language

**Primary agent**:
The reasoning agent responsible for the user's conversation and for coordinating the assigned work.

**Workflow**:
The user's defined process for choosing and carrying out actions, including their prerequisites and stopping conditions.

**Workflow skill**:
A set of instructions supplying the method for a workflow action.

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

**Compound learning**:
Retention and reuse of project lessons in later work. It does not include changes to workflow logic.

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
