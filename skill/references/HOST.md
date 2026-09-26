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
| `project-files` | the helper writes, reads back and removes a probe file in the project | 2026-09-20, developer's Linux shell (not the desktop app): verified |
| `shell` | the helper runs `git --version` | 2026-09-20, developer's Linux shell: verified |
| `secret-environment` | `JFLOW_JEV_API_KEY` is set (value never recorded) | 2026-09-20, developer's Linux shell: unverified (not set) |
| `secret-host-storage` | an integration wired to `resolveJevApiKey`'s `readHostSecret` returns a value | unverified; no integration exists (#16, #24 probe b) |
| `distinct-agent-context` | a worker run on the host with a context confirmed separate from the conversation | unverified; helper cannot probe (#24 probe a1) |
| `pinned-worker-model` | a worker pinned to a model on the host, with the model that ran confirmed | unverified; helper cannot probe (#24 probe a2) |

**Nothing has been run on the ChatGPT desktop app yet.** #24 is the spike
that does so; its findings replace the rows above.

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
