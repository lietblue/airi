#!/usr/bin/env node
/* eslint-disable no-console */

// Validate the agent's labels.json against the allowlist and sync it to the PR.
//
// Inputs (env):
//   GITHUB_TOKEN       — pull-requests:write token (required)
//   GITHUB_REPOSITORY  — "owner/repo" (required)
//   PR_NUMBER          — PR number (required)
//   LABELS_JSON        — path to labels.json from the agent (default: ./labels.json)
//   ALLOWLIST_FILE     — default: .github/pr-triage/labels.allowlist.json
//   GITHUB_STEP_SUMMARY — optional, when set, writes a summary table

import { appendFileSync, existsSync, readFileSync } from 'node:fs'

import { Octokit } from '@octokit/rest'

function required(k) {
  const v = process.env[k]
  if (!v)
    throw new Error(`Missing required env: ${k}`)
  return v
}

const TOKEN = required('GITHUB_TOKEN')
const [OWNER, REPO] = required('GITHUB_REPOSITORY').split('/')
const PR_NUMBER = Number.parseInt(required('PR_NUMBER'), 10)
const LABELS_JSON = process.env.LABELS_JSON || './labels.json'
const ALLOWLIST_FILE = process.env.ALLOWLIST_FILE || '.github/pr-triage/labels.allowlist.json'

const octokit = new Octokit({ auth: TOKEN, userAgent: 'airi-pr-triage/1.0' })

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'))
  const labels = raw.labels && typeof raw.labels === 'object' ? Object.keys(raw.labels) : []
  return { max: Number(raw.max) || 12, set: new Set(labels) }
}

function loadAgentLabels() {
  if (!existsSync(LABELS_JSON)) {
    console.warn(`[apply] ${LABELS_JSON} not found; treating as empty.`)
    return []
  }
  let parsed
  try { parsed = JSON.parse(readFileSync(LABELS_JSON, 'utf8')) }
  catch (e) {
    console.warn(`[apply] ${LABELS_JSON} is not valid JSON: ${e.message}; treating as empty.`)
    return []
  }
  if (!parsed || !Array.isArray(parsed.labels)) {
    console.warn(`[apply] ${LABELS_JSON} missing "labels" array; treating as empty.`)
    return []
  }
  if (parsed._placeholder === true) {
    // collect.mjs writes a sentinel placeholder so the agent has something to
    // overwrite. If we see it here, the agent silently failed to update the
    // file — treat as "no managed labels" rather than crashing the workflow.
    console.warn(`[apply] ${LABELS_JSON} still contains the _placeholder sentinel; agent did not update it. Treating as empty.`)
    return []
  }
  return parsed.labels.filter(l => typeof l === 'string')
}

async function getCurrentLabels() {
  const { data } = await octokit.issues.get({ owner: OWNER, repo: REPO, issue_number: PR_NUMBER })
  return (data.labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean)
}

async function addLabel(name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await octokit.issues.addLabels({ owner: OWNER, repo: REPO, issue_number: PR_NUMBER, labels: [name] })
      return true
    }
    catch (e) {
      console.warn(`[apply] addLabel(${name}) attempt ${attempt + 1} failed: ${e.message}`)
      if (attempt === 1)
        return false
    }
  }
  return false
}

async function removeLabel(name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await octokit.issues.removeLabel({ owner: OWNER, repo: REPO, issue_number: PR_NUMBER, name })
      return true
    }
    catch (e) {
      // 404 means the label is already absent — count that as success.
      if (e.status === 404)
        return true
      console.warn(`[apply] removeLabel(${name}) attempt ${attempt + 1} failed: ${e.message}`)
      if (attempt === 1)
        return false
    }
  }
  return false
}

function writeSummary(lines) {
  console.log(lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
}

async function main() {
  const allowlist = loadAllowlist()
  const raw = loadAgentLabels()

  // Filter + dedupe + cap to allowlist.max.
  const dropped = raw.filter(l => !allowlist.set.has(l))
  const seen = new Set()
  const desired = []
  for (const l of raw) {
    if (!allowlist.set.has(l))
      continue
    if (seen.has(l))
      continue
    seen.add(l)
    desired.push(l)
    if (desired.length >= allowlist.max)
      break
  }

  const current = await getCurrentLabels()
  const currentManaged = current.filter(l => allowlist.set.has(l))

  const desiredSet = new Set(desired)
  const currentManagedSet = new Set(currentManaged)
  const toAdd = desired.filter(l => !currentManagedSet.has(l))
  const toRemove = currentManaged.filter(l => !desiredSet.has(l))

  console.log(`[apply] PR #${PR_NUMBER}: desired=${JSON.stringify(desired)}, current_managed=${JSON.stringify(currentManaged)}`)
  console.log(`[apply] to_add=${JSON.stringify(toAdd)}, to_remove=${JSON.stringify(toRemove)}`)

  const addResults = []
  for (const l of toAdd) addResults.push([l, await addLabel(l)])
  const removeResults = []
  for (const l of toRemove) removeResults.push([l, await removeLabel(l)])

  const summary = ['## PR Triage', '']
  summary.push(`PR: #${PR_NUMBER}`)
  summary.push('')
  summary.push('| Action | Label | OK |')
  summary.push('| --- | --- | --- |')
  for (const [l, ok] of addResults) summary.push(`| add | \`${l}\` | ${ok ? 'yes' : 'no'} |`)
  for (const [l, ok] of removeResults) summary.push(`| remove | \`${l}\` | ${ok ? 'yes' : 'no'} |`)
  if (addResults.length === 0 && removeResults.length === 0)
    summary.push('| _no changes_ | — | — |')
  if (dropped.length) {
    summary.push('', `**Dropped (not in allowlist):** ${dropped.map(l => `\`${l}\``).join(', ')}`)
  }
  if (raw.length > allowlist.max) {
    summary.push('', `**Truncated** to first ${allowlist.max} allowed labels (agent proposed ${raw.length}).`)
  }
  summary.push('', `**Final managed labels:** ${desired.length ? desired.map(l => `\`${l}\``).join(', ') : '_(none)_'}`)
  writeSummary(summary)

  const failed = [...addResults, ...removeResults].filter(([, ok]) => !ok)
  if (failed.length > 0) {
    console.error(`[apply] ${failed.length} label op(s) failed`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[apply] fatal:', err)
  process.exit(1)
})
