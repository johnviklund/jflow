# brainstorm

**When**: the developer brings an idea or a problem and there is no accepted
specification for it, or `scripts/jflow run brainstorm` returned `ready`.

**Run**, in order:

1. `scripts/jflow run brainstorm` — confirm it is `ready`. It needs no Git
   repository and no prior records.
2. Investigate (Method below), then write the draft to a JSON file and run
   `scripts/jflow specification write <draft.json>`. Every decision lands
   as a proposal; `plan` is refused until the developer accepts. A refusal
   with `issues` means a section is missing or empty: fix the draft, do not
   drop the section. A refusal naming `realign` means the developer is
   changing agreed scope: recommend `realign` and stop.
3. For each decision the developer settles, run
   `scripts/jflow specification confirm <id> --basis "<what they said>"` or
   `scripts/jflow specification reject <id> --basis "<what they said>"`.
   The basis is their words, not your summary; the helper refuses without it.
4. When the developer accepts the specification in words, run
   `scripts/jflow specification accept --note "<their words>"`. If it
   refuses naming proposals, ask about each, record the answer, then accept.

**Method**

Investigate before writing. Read the code, records and any documents the
developer points at; ask the developer what is unclear, one question at a
time, and prefer their answer over your assumption. Then draft:

- `title` — what this is, in a few words.
- `problem` — what is wrong or missing today, for whom, in the developer's
  terms. Not the solution.
- `scenarios` — concrete situations the solution must handle, including the
  awkward ones (empty input, the second user, the retry). Each one a
  sentence a test could be written from.
- `acceptanceCriteria` — the conditions under which the developer will say
  it is done. Observable, each one checkable from evidence; if you cannot
  say what evidence would satisfy it, rewrite it.
- `constraints` — what the solution must respect: dependencies, hosts,
  performance, compatibility, existing decisions.
- `exclusions` — what is deliberately out of scope, so it is not argued
  about later.
- `decisions` — every choice the specification rests on, each with an `id`,
  a `statement` and, where you have one, a `basis`. They are all proposals
  until the developer confirms or rejects each; the helper enforces this.

**Report**: present the draft section by section, then list the proposals
and ask about each, one at a time. When the developer accepts, say so back
to them and that `plan` is now available. Acceptance is the developer's
explicit word; "interesting" or "go on" is not acceptance.
