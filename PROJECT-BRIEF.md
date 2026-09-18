# jflow: project brief

Date: 2026-09-18
Status: direction agreed; requirements and implementation remain to be developed.

Discovery continues in [DISCOVERY.md](DISCOVERY.md). Resolved vocabulary is in
[CONTEXT.md](CONTEXT.md). Read those alongside this starting brief when resuming.
The consolidated first-release handoff is [RELEASE-SCOPE.md](RELEASE-SCOPE.md).

This is the starting brief for an AI Hero `grill-with-docs` session. It preserves
the product direction and prior discussion so a new session can challenge the open
questions without reconstructing the conversation. It is not a finished specification
or an instruction to begin implementation.

## Product idea

jflow is an open-source skill and helper for configurable agent workflows powered
by TypeSafe's Jev. A user describes their process in JSON, including available actions,
decision questions, skill mappings, and policy. Jev supplies typed judgments about
the current situation. The user's primary reasoning agent follows the configured
workflow, performs the work, and records what happened.

The primary agent remains the driver, for example Astra in the user's GPT desktop
app. Astra is illustrative, not a required model; users choose their primary LLM.
Host compatibility must be verified separately. The user stays in one conversation
and can ask:

```text
/jflow implement the next ticket
```

The agent loads jflow, reads the project state, consults Jev where judgment is useful,
selects the relevant skills, and acts within the authorized assignment. It saves the
decision and result, then communicates a next-step recommendation.

Proposed public description:

> Define your workflow in JSON. Jev helps choose the next step, your agent performs
> the work, and jflow records the decisions and results.

The ambition is to support the process or "code factory" a user wants, using native
methods or configured external skills. Initial public claims should name demonstrated
workflows and hosts. "Any workflow" is an ambition to validate, not a current capability.

## Agreed direction

- Create a separate project named `jflow`, intended for an open-source release.
  Take advantage of current interest in Jev with a useful, demonstrable first release.
- Keep the user's primary reasoning agent in charge of the conversation, investigation,
  execution, delegation, integration, and reporting.
- Make `/jflow` a wrapper around the Jev API helper and the skills that perform the work.
  A bundled script or connected tool makes the API call; the skill provides guidance.
- Use reusable, versioned JSON definitions to assemble requests and describe the
  user's workflow. Workflow methods should be replaceable through configuration.
- Record decision envelopes that connect the request, classifications, recommendation,
  chosen action, and observed outcome.
- Allow a human, primary agent, or subagent to initiate a decision request. Preserve
  its origin and scope; an agent's recommendation does not create new authorization.
- Communicate outcomes with a next-step recommendation. Completion may mean that no
  further action is needed. Recommendations do not by themselves start another stage.
- Preserve project state so work can continue in the same or a fresh supported session.
- Use AI Hero's workflow to develop jflow, starting with `grill-with-docs`.

The AI Hero workflow used to build this project and the workflows jflow will support
are separate decisions. Choosing the former does not establish that unmodified AI
Hero skills are already compatible with jflow or settle the default shipped workflow.

## Responsibility boundaries

| Component | Responsibility |
| --- | --- |
| Human | Goals, priorities, consequential choices, and authorization. |
| Primary reasoning agent | Investigate, reason, execute or delegate, reconcile results, and communicate. |
| jflow skill and helper | Assemble context, call Jev, combine judgments with workflow rules, select methods, and preserve records. |
| Jev | Classify, score, and rank supplied candidates through bounded questions. |
| Workflow skills | Supply the methods for the selected action. |
| Host | Provide file access, tools, worker execution, model controls, and permissions where supported. |

The initial concept needs no separate, continuously running orchestration service.
Exact prerequisites, dependency checks, and permissions are not probabilistic decisions.
Jev does not generate arbitrary plans or implementation briefs; jflow assembles guidance
from the selected action, project evidence, skill definitions, and policy.

## What the JSON describes

The configuration has two jobs: describe the desired process and define the judgments
Jev makes within it. Proposed categories are:

| Category | Contents |
| --- | --- |
| Workflow actions | Required inputs, expected outputs, prerequisites, transitions, and stopping conditions. |
| Decision questions | Intent classes, candidate choices, rubrics, relevance questions, and uncertainty handling. |
| Skill registrations | Location and version, supported capabilities, required context, outputs, invocation restrictions, and side effects. |
| Routing policy | User priorities, model and effort preferences, budgets, thresholds, and fallback behavior. |

A proposed jflow workflow format would translate into Jev API requests. The exact
schema and how much control flow belongs in configuration remain open for design.
JSON declarations must lead to checked behavior; declaring a review step does not
prove that a review happened.

Keep full skill instructions in their source files. Populate candidates from actual
tickets, installed skills, and available host capabilities. Reuse stable questions
instead of requiring the agent to invent the classification scheme on every call.

## Decision envelopes and traceability

An envelope keeps three concepts distinct:

- Intent: what the initiating actor requested.
- Recommendation: what Jev's judgments and jflow's rules suggest doing now.
- Execution: what the agent actually did and the resulting evidence.

An explicit command can establish intent directly. Jev can classify a conversational
request. For example, a user may request implementation while the next recommendation
is to resolve a blocker because no ticket is eligible. Preserve the original intent.

The trace should identify the request and actor, task or ticket, evaluated project
state, exact context sent to Jev, question and policy versions, skill catalog version,
resolved model version, raw answers and probabilities, resulting recommendation,
any override and its reason, and links to the observed execution outcome.

Persist the request before the call and the response before interpretation. Retain
failures and fallbacks. Append outcomes without erasing the original decision record.
Reconcile changed state before using an old recommendation. Versioned inputs make
decisions inspectable; they do not guarantee identical output from another API call.

Choose storage and retention deliberately. Keep credentials out of records and
distinguish private request evidence from material intended for a public repository.
The primary agent owns shared task progress; subagents return evidence and proposed
updates rather than independently rewriting shared scope and completion records.

## Candidate Jev decisions

- Interpret ambiguous intent and recommend the next eligible action or ticket.
- Recommend model capability and effort based on task demands, human policy, budget,
  host availability, and measured outcomes.
- Select relevant skills and context; allow rejection of all unsuitable candidates.
- Assess proposed subagent assignments for useful specialization or overlap.
- Flag consequential ambiguity or a missing human decision.
- Assess whether a candidate lesson is useful, novel, applicable, and worth retaining.
- Evaluate individual rubric criteria, reviewer findings, and completion claims.

Use code for exact computations and established prerequisites. If a plan already
determines one next ticket, Jev need not rediscover it. Confidence is an input to
evaluated routing policy, not proof of correctness or permission to act. Independent
review, tests, and evidence inspection remain separate checks.

## Native development workflow discussed so far

These capabilities are the initial native workflow concept, not mandatory stages
for every configured workflow:

| Command | Purpose | Outcome |
| --- | --- | --- |
| `brainstorm` | Explore what to build, an idea, or a capability to improve. Investigate facts and interview until the specification is sufficient. | Specification. |
| `plan` | Turn the specification into testable implementation work. Avoid a repeated routine interview; surface newly discovered consequential choices. | Plan and tickets. |
| `implement` | Implement and verify one selected, ready ticket. | Changes and verification evidence. |
| `troubleshoot` | Explain the current work or diagnose a blocker, without implementing or substituting for review. | Diagnosis and an updated or new ticket when needed. |
| `review` | Independently review a ticket or the integrated result against the agreement and standards. | Findings, a patch plan when needed, and a recommendation. |
| `wrap` | Reconcile completion, preserve useful learning, and perform authorized cleanup. | A recoverable completed cycle and validated lessons. |

`status`, `next`, `todo`, and `learn` are available anytime. Capture decisions and
partial progress throughout the work rather than waiting for wrap-up.

The specification owns the problem, scenarios or user stories, acceptance criteria,
constraints, exclusions, and product decisions. The implementation plan owns how to
deliver them, including dependencies and testing decisions. Each step must be testable.
Small work can use a compact shared record instead of several documents.

## External skills

Candidate AI Hero mappings include `grill-with-docs`, `to-spec`, `to-tickets`,
`implement`, `code-review`, and `diagnosing-bugs`.

Replacement depends on compatible inputs, outputs, invocation rules, and side effects.
Some skills require direct human invocation, commit changes, include their own review,
or leave ticket completion to the caller. Identify and adapt those behaviors before
treating a skill as interchangeable. Validate the actual resulting artifacts.

## Proposed first public release

The original proposal below is retained as discussion context. Discovery decision
D8 supersedes its two-workflow scope: the first release ships one package containing
the user's custom workflow; other workflows are a future enhancement. See
[DISCOVERY.md](DISCOVERY.md) for accepted decisions and remaining questions.

Original proposal:

1. A working jflow skill and Jev helper on one verified host.
2. A documented and validated workflow configuration format.
3. A native development configuration and one adapted external-skill configuration.
4. Stored decision envelopes linked to execution outcomes.
5. A demonstration of the same request producing appropriate behavior under the two
   configurations, without rewriting the jflow entry point.

Evaluate wrong routes, unnecessary delegation, serious misses, user interruptions,
recovery accuracy, elapsed time, and total cost. Compare rules and ordinary agent
judgment with Jev-assisted decisions. A vendor benchmark does not establish jflow's
performance, and a successful demonstration does not establish universal support.

## Questions for the discovery session

- Who is the first user, and which recurring workflow decision is costly or unreliable
  enough that jflow provides a clear improvement?
- What is the smallest runnable release that demonstrates configurable workflows?
  Which host and workflow configurations should establish that claim?
- Does the user edit JSON directly, ask the agent to generate it, or use both?
  What validates a generated or modified workflow before it guides execution?
- How expressive must the first format be: stages, branches, retries, parallel work,
  or only a smaller subset? Which behavior remains in the agent's skill instructions?
- When can the agent proceed under existing authority, and when should a recommendation
  end the turn? How should user overrides affect later decisions?
- What happens when Jev is unavailable, uncertain, or disagrees with the primary agent?
- Which records are authoritative, where do raw envelopes live, and how does a fresh
  session recover without loading the whole history?
- Which external skill is the first compatibility test, and what adaptation is needed?
- What evidence will justify the public claims? Which license, distribution method,
  and GitHub owner should the first publication use?

These are prompts for investigation, not a questionnaire to ask all at once. Carry
forward the agreed direction and distinguish new proposals from user decisions.

## Continue with AI Hero

Start in this project's directory and invoke the installed `grill-with-docs` skill
with this brief. Its guide identifies `grilling` and `domain-modeling` as dependencies.
Resolved vocabulary belongs in `CONTEXT.md`; consequential decisions may warrant ADRs.
Keep the conversation for the subsequent `to-spec` step, and preserve other accepted
decisions in this brief or a linked decision record if the session must be interrupted.

Suggested opening prompt:

```text
/grill-with-docs Read PROJECT-BRIEF.md as the starting context for jflow.
Help me define a small, useful first open-source release. Carry forward the agreed
direction, challenge unsupported assumptions and the proposed release scope, and
resolve the open product decisions one at a time. Investigate facts before asking
me questions. Preserve accepted decisions as we go so this work can resume in a
fresh session. We will use AI Hero's workflow to turn the outcome into a spec and
tickets before implementing.
```

## References

- [AI Hero: grill-with-docs](https://www.aihero.dev/skills-grill-with-docs)
- [AI Hero skill catalog](https://www.aihero.dev/skills)
- [AI Hero implementation behavior](https://www.aihero.dev/skills-implement)
- [TypeSafe introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe API](https://docs.typesafe.ai/api)
- [TypeSafe questions](https://docs.typesafe.ai/primitives)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)
- [TypeSafe skill-selection example](https://docs.typesafe.ai/cookbooks/skill_suggestion)
- [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
