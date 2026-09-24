# next

**When**: the developer asks what to do next ("what now?", "what's
next?"), or you need to recommend the next step at the end of an action.
It can run at any point, including in the middle of another action.

**Run**: `scripts/jflow next` (or `scripts/jflow run <their words>`, which
reaches the same report). It writes no project record. It asks Jev's
`next-action` decision, which leaves a local trace and envelope under
`.jflow/`.

**Method**: start from the report's recommendation, which is read from
the records. Do not work out state from the conversation. `jev` holds
Jev's advisory `next-action` answer (see `references/DECISIONS.md`). If its
`route` is `weigh`, weigh it alongside the recommendation. If it is
`ask-human`, show it to the developer but do not rely on it. Where you
recommend something different from either, say why and cite the evidence.

**Report** from `outcome.report`:

- `recommendation.action` and its `reason`, in one sentence.
- If `recommendation.needsDeveloper` is true, what only the developer can
  give. Quote the `reason` and each `unmet` prerequisite's `reason`: an
  acceptance, an authorization, or the decision a parked ticket waits on.
  Present it as their decision. A recommendation
  is not authorization. Asking about it is fine; treating it as given is
  not.
- `jev`: the `answer`, its `reasonCode` and `route`, and the `envelope` id.
  If `kind` is `needs-configuration`, ask the developer the `askHuman`
  question. Jev's answer grants nothing and changes no prerequisite.
- Other `eligible` actions from `actions`, if the developer might want one
  instead.
- `openTodos`, briefly, as future work outside the plan. They are not
  work anyone has authorized. `promotedTodos` are items the developer
  decided to bring into the plan whose ticket does not exist yet: they
  wait on `plan` or, for an accepted plan, on `realign`.
- `project` is `malformed`: name the `path` and `problem`, recommend
  nothing, and change nothing.

After reporting, resume what was under way; asking for `next` does not
end or restart the current action.
