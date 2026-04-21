# PR Triage

Self-contained PR labeling pipeline. Replaces the previous gh-aw / Copilot CLI
machinery with three plain GitHub Actions jobs and two Node scripts.

## How it works

```
pull_request_target / workflow_dispatch
        │
        ▼
┌──────────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────────┐
│ collect                  │ →  │ agent                    │ →  │ apply                    │
│ permissions:             │    │ permissions: {}          │    │ permissions:             │
│   contents:read          │    │ secrets: LLM_API_KEY     │    │   pull-requests:write    │
│   pull-requests:read     │    │ runs opencode → labels   │    │ validates against        │
│ writes ./pr/* bundle     │    │ uploads labels.json      │    │ allowlist, syncs PR      │
└──────────────────────────┘    └──────────────────────────┘    └──────────────────────────┘
```

The `agent` job has **zero GitHub access**. Even if a malicious PR injects
prompts into its body, comments, or diff, the agent has no `GITHUB_TOKEN` to
abuse and no write path back to the repo. The only thing it produces is a
`labels.json` file, which the `apply` job filters against
[`labels.allowlist.json`](./labels.allowlist.json) before pushing.

## One-time setup

Add a single repository secret:

| Secret | Value | Where |
| --- | --- | --- |
| `LLM_API_KEY` | API key for the chosen provider (DeepSeek by default) | Settings → Secrets and variables → Actions → New repository secret |

For the `openai-compatible` provider, also set a repo variable:

| Variable | Value |
| --- | --- |
| `LLM_BASE_URL` | e.g. `https://api.together.xyz/v1` (or override per-run via dispatch input) |

## Customizing

| Want to change... | Edit |
| --- | --- |
| Classification rules / prompt | [`prompt.md`](./prompt.md) |
| Allowed labels | [`labels.allowlist.json`](./labels.allowlist.json) |
| Default provider / model | [`config.yml`](./config.yml) |
| Add a new provider | drop a JSON into [`providers/`](./providers/) |
| Agent tool whitelist (read/write/bash/etc.) | [`agent.json`](./agent.json) |

`pull_request_target` always uses the defaults from `config.yml`.
`workflow_dispatch` can override `provider`, `model`, and `base_url` per-run
from the Actions tab.

## Built-in providers

| Preset | npm driver | Notes |
| --- | --- | --- |
| `deepseek` | `@ai-sdk/openai-compatible` | Cheap default. `LLM_API_KEY` = DeepSeek key. |
| `openai` | `@ai-sdk/openai` | `LLM_API_KEY` = OpenAI key. |
| `openrouter` | `@openrouter/ai-sdk-provider` | `LLM_API_KEY` = OpenRouter key. |
| `anthropic` | `@ai-sdk/anthropic` | `LLM_API_KEY` = Anthropic key. |
| `openai-compatible` | `@ai-sdk/openai-compatible` | Bring your own `LLM_BASE_URL` (Together, Groq, local LM Studio, etc.). |

## Manual run

Actions tab → "PR Triage" → "Run workflow" → fill `pr` (required) and
optionally `provider`, `model`, `base_url`.

## Why the agent gets a pre-created `labels.json`

`collect.mjs` writes a sentinel placeholder `{ "_placeholder": true, "labels": [] }`
into the bundle before the agent runs. This is a deliberate workaround for a
small-model failure mode: cheap models (notably DeepSeek's `deepseek-chat`)
frequently refuse to call the `write` tool to *create* a new file and instead
just print the JSON to chat, where the apply step never sees it. With the
placeholder already on disk, the agent can take the much more familiar
Read → Edit path, which is reliable across providers.

`apply-labels.mjs` recognizes the `_placeholder` sentinel: if it's still present
when the apply step runs, the agent silently failed to update the file and the
PR ends up with no managed-label changes (rather than crashing CI).

## Security model (short)

- `agent` job has `permissions: {}` and no `GITHUB_TOKEN` — it cannot reach the
  repo via the API even if it wants to. It does a sparse `actions/checkout` of
  its own scripts with `persist-credentials: false` so even `git push` has no
  credential to use.
- The PR's source code is **never executed**. It enters the pipeline only as
  data inside `pr/changes/*.diff` and `pr/messages/`.
- Asset downloads in `collect.mjs` are restricted to `*.githubusercontent.com`
  and `github.com/user-attachments/*`, capped to 5 MB per file and 50 MB total.
- `apply-labels.mjs` enforces the allowlist on the agent's output before any
  GitHub API call. Anything outside the allowlist is silently dropped.
- The label set is also hard-capped (default 12) so a runaway agent cannot
  spam the PR.

### Supply-chain hardening

- Two **physically separated dependency islands** with their own pinned
  `pnpm-lock.yaml`:
  - [`scripts/pr-triage/`](../../scripts/pr-triage) — `@octokit/rest`,
    `js-yaml`, `mime-types`. Loaded by `collect` + `apply` jobs (which hold
    `GITHUB_TOKEN`). Ships zero LLM SDKs.
  - [`scripts/pr-triage-agent/`](../../scripts/pr-triage-agent) —
    `opencode-ai`. Loaded by the `agent` job (which holds `LLM_API_KEY`).
    Ships zero GitHub SDKs.
  Compromise of one tree cannot reach the other secret.
- All three jobs install with
  `pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace --prod`:
  - `--frozen-lockfile`: any version drift vs the committed lockfile fails CI.
  - `--ignore-scripts`: no `postinstall` / `prepare` script from any dep can
    execute on the runner. (This is the most common supply-chain attack vector;
    none of these deps actually need lifecycle scripts.)
  - `--ignore-workspace`: the triage installs are standalone, not affected by
    the monorepo root's `catalog:` / `overrides:` / patches.
- The `opencode` CLI is run from the local `node_modules/.bin/`, never via
  `npm i -g opencode-ai@latest` or `npx`. The exact version executed is
  whatever `scripts/pr-triage-agent/pnpm-lock.yaml` says.

To upgrade either island:

```bash
cd scripts/pr-triage          # or scripts/pr-triage-agent
pnpm update --ignore-workspace --latest
# review the new pnpm-lock.yaml diff carefully, then commit it
```
