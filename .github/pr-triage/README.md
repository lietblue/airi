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

## Security model (short)

- `agent` job has `permissions: {}` and no checkout — it cannot reach the repo
  even if it wants to.
- The PR's source code is **never executed**. It enters the pipeline only as
  data inside `pr/changes/*.diff` and `pr/messages/`.
- Asset downloads in `collect.mjs` are restricted to `*.githubusercontent.com`
  and `github.com/user-attachments/*`, capped to 5 MB per file and 50 MB total.
- `apply-labels.mjs` enforces the allowlist on the agent's output before any
  GitHub API call. Anything outside the allowlist is silently dropped.
- The label set is also hard-capped (default 12) so a runaway agent cannot
  spam the PR.
