# Host verification

jflow targets the ChatGPT desktop app first (D13) but claims nothing about a
host that has not been shown to work (D11). This file records what has
been checked, how, and on what date. Anything not listed as `verified` is
unverified, whatever the documentation says.

## Skill packaging — from documentation, 2026-09-20

Source: <https://learn.chatgpt.com/docs/build-skills>, read 2026-09-20.

| Claim | Status | Basis |
| --- | --- | --- |
| A skill is a directory with `SKILL.md` plus optional `scripts/`, `references/`, `assets/`, `agents/openai.yaml` | documented | the page states it; this directory follows it |
| `SKILL.md` frontmatter must include `name` and `description` | documented | the page states it |
| Invocation: type `@` in ChatGPT to select a skill; `$` or `/skills` in Codex CLI/IDE | documented | the page states it; **not yet exercised** |
| Which runtimes a bundled script may use, and with what permissions | **not stated** | the page does not say; the helper needs `node` |
| Whether a skill may read/write project files and run shell commands | **not stated** | the page does not say |

"Documented" means the host's page said so when read. It is not
"verified": none of these has been exercised on the desktop app by this
project. The brief's illustrative `/jflow` syntax is not the host's syntax.

The helper shim resolves `../../bin/jflow.js` relative to itself, so the
skill directory works only inside the jflow checkout. Whether the desktop
app copies a skill elsewhere on install is **not stated** and unverified.

## Capabilities — by execution

Run `scripts/jflow check-host` in the project on the host. It probes what
the helper can probe and labels the rest. Record each run here with the
host, date and result.

| Capability | What verifies it | Last recorded |
| --- | --- | --- |
| `project-files` | the helper writes, reads back and removes a probe file in the project | 2026-09-26, ChatGPT desktop app: verified |
| `shell` | the helper runs `git --version` | 2026-09-26, ChatGPT desktop app: verified |
| `secret-environment` | `JFLOW_JEV_API_KEY` is set (value never recorded) | 2026-09-26, ChatGPT desktop app: verified, when the app is started with the variable set after a full quit |
| `secret-host-storage` | an integration wired to `resolveJevApiKey`'s `readHostSecret` returns a value | 2026-09-26, ChatGPT desktop app: unverified; the app exposes no tool for reading its own secret storage |
| `distinct-agent-context` | a worker run on the host with a context confirmed separate from the conversation | 2026-09-26, ChatGPT desktop app: verified by the developer (#24 probe a1) |
| `pinned-worker-model` | a worker pinned to a model on the host, with the model that ran confirmed | 2026-09-26, ChatGPT desktop app: verified by the developer from the app's session log (#24 probe a2) |

### ChatGPT desktop app, 2026-09-26 (#24)

ChatGPT desktop 26.908.70816 on Linux. The developer opened this checkout as
the project, added `skill/` as a skill, and ran each probe from a
conversation on the model Astra.

- **Files and shell.** `scripts/jflow check-host` wrote, read back and
  removed its probe file and ran `git --version`. The app showed no approval
  prompt for any probe in this run.
- **Environment variable.** The first run reported `JFLOW_JEV_API_KEY` not
  set: the app was already running, and a second launch hands off to the
  running instance, which does not have the variable. After a full quit and
  a launch from a shell with the variable set, a command in the project saw
  it. The app did not filter the variable for having `KEY` in its name.
- **Host secret storage.** Asked to read a secret from its own secret
  storage, the app answered that no tool it has gives that access. Nothing
  calls `readHostSecret`, and on this host nothing could supply it.
- **Distinct agent context.** The conversation was told a codeword, then
  started a sub-agent that was told only to say whether it knew a codeword
  and to create a file. The sub-agent did not know the codeword and created
  the file in the project, so it shares the workspace but not the
  conversation. The app showed the sub-agent as its own run in the session.
- **Pinned worker model.** A sub-agent started on `gpt-5.6-sol` at effort
  `low`, from a conversation on Astra. The app's own session log
  (`~/.codex/sessions/<date>/rollout-*.jsonl`, the `turn_context` entry)
  records `{"model": "gpt-5.6-sol", "effort": "low"}` for the sub-agent.
  That record is the app's, not the sub-agent's claim about itself.

## Release demonstrations — instruction side

Each release demonstration (RELEASE-SCOPE.md, issue #23) has a helper side
and an instruction side (D51). The helper side runs as automated tests in
`src/demonstrations/` and passes in the developer's shell. The instruction
side, a primary agent following `SKILL.md` and `actions/` through the
demonstration on a host, is labelled here once a run is recorded.

| Demonstration | Instruction side on a host |
| --- | --- |
| 1–14 | unverified: no host run recorded |

A run is recorded with the host, the date, the model, the transcript's
location and what was checked. Until then no demonstration's instruction
side is claimed to work on any host.
