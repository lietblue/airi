#!/usr/bin/env node
/* eslint-disable no-console */

// Merge a provider preset + agent.json into a single opencode config and
// write it to ~/.config/opencode/opencode.json (or OPENCODE_CONFIG_OUT).
//
// Inputs (env):
//   PROVIDER          — provider id, must match a file under providers/
//   MODEL             — model id (string passed to `opencode -m provider/model`)
//   EXTRA_MODELS      — optional space-separated additional models to register
//   PROVIDERS_DIR     — default: .github/pr-triage/providers
//   AGENT_FILE        — default: .github/pr-triage/agent.json
//   OPENCODE_CONFIG_OUT — default: $HOME/.config/opencode/opencode.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function required(k) {
  const v = process.env[k]
  if (!v)
    throw new Error(`Missing required env: ${k}`)
  return v
}

const PROVIDER = required('PROVIDER')
const MODEL = required('MODEL')
const EXTRA_MODELS = (process.env.EXTRA_MODELS || '').split(/\s+/).filter(Boolean)
const PROVIDERS_DIR = process.env.PROVIDERS_DIR || '.github/pr-triage/providers'
const AGENT_FILE = process.env.AGENT_FILE || '.github/pr-triage/agent.json'
const OUT_PATH = process.env.OPENCODE_CONFIG_OUT || join(homedir(), '.config', 'opencode', 'opencode.json')

const presetPath = join(PROVIDERS_DIR, `${PROVIDER}.json`)
if (!existsSync(presetPath)) {
  console.error(`[render-config] provider preset not found: ${presetPath}`)
  process.exit(2)
}

const preset = JSON.parse(readFileSync(presetPath, 'utf8'))
const agent = existsSync(AGENT_FILE) ? JSON.parse(readFileSync(AGENT_FILE, 'utf8')) : { agent: {} }

// Build the model list. First entry is the requested MODEL, then EXTRA_MODELS,
// then the preset's known_models. Deduplicate while preserving order.
const seen = new Set()
const orderedModels = []
for (const m of [MODEL, ...EXTRA_MODELS, ...(preset.known_models || [])]) {
  if (!m)
    continue
  if (seen.has(m))
    continue
  seen.add(m)
  orderedModels.push(m)
}
const models = Object.fromEntries(orderedModels.map(m => [m, {}]))

// Validate that openai-compatible has a baseURL set via env.
if (preset.options?.baseURL === '{env:LLM_BASE_URL}' && !process.env.LLM_BASE_URL) {
  console.error('[render-config] provider "openai-compatible" requires LLM_BASE_URL env')
  process.exit(2)
}

const config = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    [preset.id]: {
      name: preset.name,
      npm: preset.npm,
      options: preset.options,
      models,
    },
  },
  ...agent,
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, `${JSON.stringify(config, null, 2)}\n`)
console.log(`[render-config] wrote ${OUT_PATH}`)
console.log(`[render-config] opencode -m ${preset.id}/${MODEL}`)
