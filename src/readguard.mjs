import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readguardIgnoredEnabled } from './config.mjs'

const MAX_ENTRIES = 5000
const MAX_LISTED_PATHS = 50
const MAX_MESSAGE_PATHS = 10

/**
 * `git status --porcelain=v1 -z` separates records with NUL instead of
 * newlines so paths with spaces/newlines round-trip safely. A rename/copy
 * record carries an extra NUL-separated token (the original path) right
 * after the record's own token, e.g. `R  new\0old\0` — that second token
 * must be consumed as part of the same record, not treated as its own.
 */
function parsePorcelainZ(output) {
  const tokens = output.split('\0').filter((token) => token.length > 0)
  const records = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const status = token.slice(0, 2)
    const recordPath = token.slice(3)
    let origPath = null
    if (status[0] === 'R' || status[0] === 'C') {
      origPath = tokens[++i] ?? null
    }
    records.push({ status, path: recordPath, origPath })
  }
  return records
}

/**
 * A fingerprint changes whenever the file is touched again, even if the git
 * status code stays the same (e.g. a file already dirty before the job gets
 * modified further during the job — same 'M ' code, different size/mtime).
 */
function fingerprint(root, relPath, statusCode) {
  try {
    const stat = fs.statSync(path.join(root, relPath))
    return `${statusCode}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `${statusCode}:deleted`
  }
}

/**
 * Snapshot the git-visible state of a working tree before/after a job runs.
 * Returns null when cwd isn't inside a git work tree (or git fails outright)
 * so callers can treat "not git" as unverifiable rather than a violation.
 */
export function takeSnapshot(cwd, { exec = execFileSync, env = process.env } = {}) {
  let root
  try {
    root = exec('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return null
  }

  let head = null
  try {
    head = exec('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    head = null
  }

  // When AGENT_HUB_READGUARD_IGNORED === '1', opt-in to including ignored files via
  // `--ignored=matching`. We keep the snapshot cheap: status-based listing without
  // recursive deep directory walking or full-file hashing of ignored build output.
  // Residual limits:
  // - In-place modifications to existing files inside an already-ignored directory
  //   (e.g. build/bundle.js modified without altering directory mtime/entry count)
  //   may not be detected because git status reports only the directory entry `!! build/`
  //   and we do not recurse or hash ignored directories.
  // - Individual ignored files matching patterns (e.g. .env, /ignored.txt) and additions/
  //   deletions that alter directory timestamps/entries are captured.
  const ignoredFlag = readguardIgnoredEnabled(env) ? '--ignored=matching' : '--ignored=no'

  let statusOutput
  try {
    statusOutput = exec(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', ignoredFlag],
      { cwd, encoding: 'utf8' },
    )
  } catch {
    return null
  }

  const records = parsePorcelainZ(statusOutput)

  // Bound the cost of large/dirty repos: skip per-file stat()s and fall back
  // to a coarse count + head comparison once there are too many entries.
  if (records.length > MAX_ENTRIES) {
    return { root, head, entries: { truncated: true, count: records.length } }
  }

  const entries = new Map()
  for (const record of records) {
    entries.set(record.path, fingerprint(root, record.path, record.status))
    if (record.origPath) {
      entries.set(record.origPath, fingerprint(root, record.origPath, 'D_'))
    }
  }

  return { root, head, entries }
}

function entryCount(entries) {
  return entries.truncated ? entries.count : entries.size
}

/**
 * Compare two snapshots taken before/after a "read" job. `unverifiable` marks
 * the case where we have no git-based evidence at all (not a repo, or git
 * failed) — callers should not treat that as proof of a clean run.
 */
export function diffSnapshots(before, after) {
  if (!before || !after) {
    return { changed: false, headChanged: false, paths: [], unverifiable: true }
  }

  const headChanged = before.head !== after.head

  if (before.entries.truncated || after.entries.truncated) {
    const changed = headChanged || entryCount(before.entries) !== entryCount(after.entries)
    return { changed, headChanged, paths: [] }
  }

  const changedPaths = new Set()
  for (const [entryPath, fp] of after.entries) {
    if (before.entries.get(entryPath) !== fp) changedPaths.add(entryPath)
  }
  for (const entryPath of before.entries.keys()) {
    if (!after.entries.has(entryPath)) changedPaths.add(entryPath)
  }

  const paths = [...changedPaths].sort().slice(0, MAX_LISTED_PATHS)
  return { changed: headChanged || changedPaths.size > 0, headChanged, paths }
}

/**
 * Human-readable one-liner for the job-failure message surfaced to callers.
 */
export function formatViolation(diff) {
  const { paths, headChanged } = diff
  const shown = paths.slice(0, MAX_MESSAGE_PATHS)
  const list = shown.join(', ') + (paths.length > MAX_MESSAGE_PATHS ? ', …' : '')
  let message = `read-mode job modified ${paths.length} path(s): ${list}`
  if (headChanged) message += ' and moved HEAD'
  return message
}
