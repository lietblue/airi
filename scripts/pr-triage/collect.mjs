#!/usr/bin/env node
/* eslint-disable no-console */

// Collect a PR's metadata, files, commits, comments, and inline attachments
// into a curated bundle that the agent job can read without any GitHub access.
//
// Inputs (env):
//   GITHUB_TOKEN        — repo:read PAT or workflow token (required)
//   GITHUB_REPOSITORY   — "owner/repo" (required)
//   PR_NUMBER           — PR number (required)
//   OUT_DIR             — output directory (default: ./pr)
//   CONFIG_FILE         — path to config.yml (default: .github/pr-triage/config.yml)
//   PROMPT_FILE         — default: .github/pr-triage/prompt.md
//   LABELS_FILE         — default: .github/pr-triage/labels.allowlist.json
//   GITHUB_OUTPUT       — optional, when set, writes job outputs (provider/model/extra_models/pr_number)

import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import yaml from 'js-yaml'

import { Octokit } from '@octokit/rest'
import { extension as mimeExt } from 'mime-types'

function required(k) {
  const v = process.env[k]
  if (!v)
    throw new Error(`Missing required env: ${k}`)
  return v
}

const TOKEN = required('GITHUB_TOKEN')
const REPO_FULL = required('GITHUB_REPOSITORY')
const [OWNER, REPO] = REPO_FULL.split('/')
const PR_NUMBER = Number.parseInt(required('PR_NUMBER'), 10)
const OUT_DIR = resolve(process.env.OUT_DIR || './pr')
const CONFIG_FILE = process.env.CONFIG_FILE || '.github/pr-triage/config.yml'
const PROMPT_FILE = process.env.PROMPT_FILE || '.github/pr-triage/prompt.md'
const LABELS_FILE = process.env.LABELS_FILE || '.github/pr-triage/labels.allowlist.json'

// Limits
const MAX_DIFF_BYTES = 1 * 1024 * 1024 // 1 MB per file
const MAX_ASSET_BYTES = 5 * 1024 * 1024 // 5 MB per asset
const MAX_TOTAL_ASSET_BYTES = 50 * 1024 * 1024 // 50 MB total
const MAX_FILES_LISTED = 500
const MAX_COMMITS_LISTED = 500

// Allowed asset hosts for inline image/file downloads.
// All other URLs are kept as-is (not downloaded) — the agent sees the raw URL but cannot fetch it.
const ASSET_HOSTS = new Set([
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'github.com', // for /user-attachments/files/* and /user-attachments/assets/*
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
])

const octokit = new Octokit({ auth: TOKEN, userAgent: 'airi-pr-triage/1.0' })

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(join(OUT_DIR, 'changes'), { recursive: true })
mkdirSync(join(OUT_DIR, 'messages'), { recursive: true })

const warnings = []
function warn(msg) {
  console.warn(`[collect] WARN: ${msg}`)
  warnings.push(msg)
}

function shortHash(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

// Convert a repo-relative file path into a flat filename safe for changes/.
function safeDiffName(filePath) {
  const flat = filePath.replace(/[\\/]+/g, '__').replace(/[^\w.-]/g, '_')
  const trimmed = flat.length > 180 ? `${flat.slice(0, 120)}_${shortHash(filePath)}` : flat
  return `${trimmed}.diff`
}

// ---------------------------------------------------------------------------
// Fetch PR data
// ---------------------------------------------------------------------------

async function getPR() {
  const { data } = await octokit.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR_NUMBER })
  return data
}

async function listFiles() {
  const out = []
  for await (const page of octokit.paginate.iterator(octokit.pulls.listFiles, {
    owner: OWNER,
    repo: REPO,
    pull_number: PR_NUMBER,
    per_page: 100,
  })) {
    for (const f of page.data) {
      out.push(f)
      if (out.length >= MAX_FILES_LISTED)
        return out
    }
  }
  return out
}

async function listCommits() {
  const out = []
  for await (const page of octokit.paginate.iterator(octokit.pulls.listCommits, {
    owner: OWNER,
    repo: REPO,
    pull_number: PR_NUMBER,
    per_page: 100,
  })) {
    for (const c of page.data) {
      out.push(c)
      if (out.length >= MAX_COMMITS_LISTED)
        return out
    }
  }
  return out
}

async function listIssueComments() {
  return await octokit.paginate(octokit.issues.listComments, {
    owner: OWNER,
    repo: REPO,
    issue_number: PR_NUMBER,
    per_page: 100,
  })
}

async function listReviews() {
  return await octokit.paginate(octokit.pulls.listReviews, {
    owner: OWNER,
    repo: REPO,
    pull_number: PR_NUMBER,
    per_page: 100,
  })
}

async function listReviewComments() {
  return await octokit.paginate(octokit.pulls.listReviewComments, {
    owner: OWNER,
    repo: REPO,
    pull_number: PR_NUMBER,
    per_page: 100,
  })
}

// ---------------------------------------------------------------------------
// Asset downloader: scans markdown for image/file links to known GH hosts,
// downloads them under OUT_DIR/messages/<hash>-<name>, returns a URL→localPath map.
// ---------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s)\]>]+/gi
let totalAssetBytes = 0
const assetCache = new Map() // url -> localPath (relative to OUT_DIR)

async function downloadAsset(url) {
  if (assetCache.has(url))
    return assetCache.get(url)
  let host
  try { host = new URL(url).host }
  catch { return null }
  if (!ASSET_HOSTS.has(host))
    return null
  if (host === 'github.com') {
    // Only download user-attachments/* paths from github.com to avoid pulling whole repo trees.
    const path = new URL(url).pathname
    if (!/^\/user-attachments\/(files|assets)\//.test(path))
      return null
  }
  if (totalAssetBytes >= MAX_TOTAL_ASSET_BYTES) {
    warn(`Asset budget exceeded, skipping ${url}`)
    return null
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'airi-pr-triage/1.0' },
    })
    if (!res.ok) {
      warn(`Failed to download ${url}: HTTP ${res.status}`)
      return null
    }
    const contentLength = Number.parseInt(res.headers.get('content-length') || '0', 10)
    if (contentLength && contentLength > MAX_ASSET_BYTES) {
      warn(`Asset too large (${contentLength} bytes), skipping ${url}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_ASSET_BYTES) {
      warn(`Asset too large after download (${buf.byteLength} bytes), skipping ${url}`)
      return null
    }
    if (totalAssetBytes + buf.byteLength > MAX_TOTAL_ASSET_BYTES) {
      warn(`Total asset budget would be exceeded, skipping ${url}`)
      return null
    }
    totalAssetBytes += buf.byteLength

    // Derive a filename: prefer the URL's last segment, else use hash + extension from MIME.
    const urlPath = new URL(url).pathname
    const segs = urlPath.split('/').filter(Boolean)
    let baseName = segs.at(-1) || `asset-${shortHash(url)}`
    baseName = baseName.replace(/[^\w.-]/g, '_').slice(0, 80) || `asset-${shortHash(url)}`
    if (!/\.[A-Z0-9]+$/i.test(baseName)) {
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
      const ext = ct ? mimeExt(ct) : null
      if (ext)
        baseName += `.${ext}`
    }
    const localName = `${shortHash(url)}-${baseName}`
    const absPath = join(OUT_DIR, 'messages', localName)
    writeFileSync(absPath, buf)
    const relPath = `messages/${localName}`
    assetCache.set(url, relPath)
    return relPath
  }
  catch (err) {
    warn(`Asset download error for ${url}: ${err.message}`)
    return null
  }
}

// Scan markdown text, download recognized assets, and return rewritten text +
// the list of (url, localPath) pairs found.
async function rewriteAssetsInMarkdown(text) {
  if (!text)
    return { text: '', assets: [] }
  const matches = Array.from(text.matchAll(URL_REGEX), m => m[0])
  const unique = [...new Set(matches)]
  const assets = []
  let result = text
  for (const url of unique) {
    const local = await downloadAsset(url)
    if (!local)
      continue
    assets.push({ url, local })
    // Replace all occurrences of the URL with the local path (preceded by ./).
    // Use split/join to avoid regex escape pitfalls with special characters in URLs.
    result = result.split(url).join(`./${local}`)
  }
  return { text: result, assets }
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function writeChangesIndex(files) {
  const lines = ['# Changed files', '']
  for (const f of files) {
    lines.push(`- \`${f.filename}\` — status: ${f.status}, +${f.additions} / -${f.deletions} (changes: ${f.changes})`)
  }
  if (files.length === 0)
    lines.push('_No files changed._')
  if (files.length >= MAX_FILES_LISTED)
    lines.push('', `_... truncated to first ${MAX_FILES_LISTED} files._`)
  writeFileSync(join(OUT_DIR, 'changes.md'), `${lines.join('\n')}\n`)
}

function writePerFileDiffs(files) {
  for (const f of files) {
    if (!f.patch)
      continue // binary or no patch
    const name = safeDiffName(f.filename)
    let patch = f.patch
    if (Buffer.byteLength(patch, 'utf8') > MAX_DIFF_BYTES) {
      patch = `${patch.slice(0, MAX_DIFF_BYTES)}\n... [truncated, original was larger than ${MAX_DIFF_BYTES} bytes]\n`
    }
    const header = `# ${f.filename}\n# status: ${f.status}, +${f.additions} / -${f.deletions}\n\n`
    writeFileSync(join(OUT_DIR, 'changes', name), header + patch)
  }
}

function writeCommitsMd(commits) {
  const lines = ['# Commits', '']
  for (const c of commits) {
    const sha = c.sha?.slice(0, 7) || '???????'
    const author = c.commit?.author?.name || c.author?.login || 'unknown'
    const email = c.commit?.author?.email || ''
    const msg = (c.commit?.message || '').trim()
    lines.push(`## ${sha} — ${author}${email ? ` <${email}>` : ''}`, '', '```', msg, '```', '')
  }
  if (commits.length === 0)
    lines.push('_No commits._')
  if (commits.length >= MAX_COMMITS_LISTED)
    lines.push('', `_... truncated to first ${MAX_COMMITS_LISTED} commits._`)
  writeFileSync(join(OUT_DIR, 'commits.md'), `${lines.join('\n')}\n`)
}

async function buildMessagesJson(pr, issueComments, reviews, reviewComments) {
  // Title + body
  const bodyOut = await rewriteAssetsInMarkdown(pr.body || '')

  const commentsOut = []
  for (const c of issueComments) {
    const r = await rewriteAssetsInMarkdown(c.body || '')
    commentsOut.push({
      kind: 'issue_comment',
      id: c.id,
      author: c.user?.login || 'unknown',
      author_association: c.author_association || null,
      created_at: c.created_at,
      body: r.text,
      assets: r.assets,
    })
  }

  const reviewsOut = []
  for (const r of reviews) {
    const rw = await rewriteAssetsInMarkdown(r.body || '')
    reviewsOut.push({
      kind: 'review',
      id: r.id,
      author: r.user?.login || 'unknown',
      state: r.state,
      submitted_at: r.submitted_at,
      body: rw.text,
      assets: rw.assets,
    })
  }

  const reviewCommentsOut = []
  for (const c of reviewComments) {
    const r = await rewriteAssetsInMarkdown(c.body || '')
    reviewCommentsOut.push({
      kind: 'review_comment',
      id: c.id,
      author: c.user?.login || 'unknown',
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      created_at: c.created_at,
      body: r.text,
      assets: r.assets,
    })
  }

  return {
    repository: REPO_FULL,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    author: pr.user?.login || 'unknown',
    author_association: pr.author_association || null,
    base: { ref: pr.base?.ref, sha: pr.base?.sha, repo: pr.base?.repo?.full_name },
    head: { ref: pr.head?.ref, sha: pr.head?.sha, repo: pr.head?.repo?.full_name },
    labels: (pr.labels || []).map(l => l.name),
    body: bodyOut.text,
    body_assets: bodyOut.assets,
    comments: commentsOut,
    reviews: reviewsOut,
    review_comments: reviewCommentsOut,
    collected_at: new Date().toISOString(),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Config + outputs
// ---------------------------------------------------------------------------

function readConfig() {
  if (!existsSync(CONFIG_FILE))
    return { provider: 'deepseek', model: 'deepseek-chat', extra_models: [] }
  const raw = readFileSync(CONFIG_FILE, 'utf8')
  const parsed = yaml.load(raw) || {}
  return {
    provider: parsed.provider || 'deepseek',
    model: parsed.model || '',
    extra_models: Array.isArray(parsed.extra_models) ? parsed.extra_models : [],
  }
}

function emitOutput(key, value) {
  console.log(`[collect] output ${key}=${value}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
}

function copyStaticFiles() {
  if (existsSync(PROMPT_FILE))
    copyFileSync(PROMPT_FILE, join(OUT_DIR, '..', 'prompt.md'))
  else warn(`prompt file missing: ${PROMPT_FILE}`)
  if (existsSync(LABELS_FILE))
    copyFileSync(LABELS_FILE, join(OUT_DIR, '..', 'labels.allowlist.json'))
  else warn(`labels file missing: ${LABELS_FILE}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[collect] PR #${PR_NUMBER} of ${REPO_FULL} → ${OUT_DIR}`)

  const [pr, files, commits, issueComments, reviews, reviewComments] = await Promise.all([
    getPR().catch((e) => { warn(`pulls.get failed: ${e.message}`); return null }),
    listFiles().catch((e) => { warn(`pulls.listFiles failed: ${e.message}`); return [] }),
    listCommits().catch((e) => { warn(`pulls.listCommits failed: ${e.message}`); return [] }),
    listIssueComments().catch((e) => { warn(`issues.listComments failed: ${e.message}`); return [] }),
    listReviews().catch((e) => { warn(`pulls.listReviews failed: ${e.message}`); return [] }),
    listReviewComments().catch((e) => { warn(`pulls.listReviewComments failed: ${e.message}`); return [] }),
  ])

  if (!pr) {
    // Write minimal stubs and exit gracefully so the agent job can still run and report missing data.
    writeFileSync(join(OUT_DIR, 'changes.md'), '# Changed files\n\n_PR metadata fetch failed._\n')
    writeFileSync(join(OUT_DIR, 'commits.md'), '# Commits\n\n_PR metadata fetch failed._\n')
    writeFileSync(join(OUT_DIR, 'messages.json'), JSON.stringify({ error: 'pr_fetch_failed', warnings }, null, 2))
  }
  else {
    writeChangesIndex(files)
    writePerFileDiffs(files)
    writeCommitsMd(commits)
    const messages = await buildMessagesJson(pr, issueComments, reviews, reviewComments)
    writeFileSync(join(OUT_DIR, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`)
  }

  copyStaticFiles()

  const cfg = readConfig()
  emitOutput('pr_number', String(PR_NUMBER))
  emitOutput('provider', cfg.provider)
  emitOutput('model', cfg.model)
  emitOutput('extra_models', cfg.extra_models.join(' '))

  console.log(`[collect] done (${files.length} files, ${commits.length} commits, ${issueComments.length}+${reviews.length}+${reviewComments.length} comments, ${assetCache.size} assets, ${warnings.length} warnings)`)
}

main().catch((err) => {
  console.error('[collect] fatal:', err)
  process.exit(1)
})
