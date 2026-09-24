import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runCommand as defaultRunCommand } from './process.mjs'

/** Per-file list cap on a computed diff stats result (see computeDiffStats). */
export const DEFAULT_MAX_FILES = 200

const DEFAULT_TIMEOUT_MS = 5000

/** `env` merged with GIT_OPTIONAL_LOCKS=0 — every git call this module makes is
 * read-only, but the lockfile itself is still writable by default; disabling
 * it keeps a stats read from ever contending with (or blocking behind) a
 * concurrent git operation in the same worktree. */
function gitEnv(env = process.env) {
  return { ...env, GIT_OPTIONAL_LOCKS: '0' }
}

/**
 * Capture HEAD as the diff baseline for a write-mode job, synchronously,
 * before its CLI spawns (see jobrunner.mjs's startJob). Returns null —
 * never throws — when `cwd` is not inside a git work tree, the repo has no
 * commits yet, or git itself is unavailable: per the feature's constraints,
 * "no baseline" is a silent, ordinary outcome, not an error.
 */
export function captureDiffBase({ cwd, env = process.env, execFn = execFileSync, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const opts = { cwd, encoding: 'utf8', timeout: timeoutMs, env: gitEnv(env) }
  try {
    const inside = execFn('git', ['rev-parse', '--is-inside-work-tree'], opts).trim()
    if (inside !== 'true') return null
    const head = execFn('git', ['rev-parse', 'HEAD'], opts).trim()
    return head || null
  } catch {
    return null
  }
}

/**
 * Capture the git repo a job's cwd lives in, synchronously, for ANY job mode
 * (unlike captureDiffBase, which is write-mode only) — this is purely
 * informational for the dashboard's "Project" column, not a diff baseline.
 * Returns `{ root, name, branch }` or null — never throws — when `cwd` is
 * not inside a git work tree or git itself is unavailable.
 *
 * `branch` resolution: `git rev-parse --abbrev-ref HEAD` normally; on a
 * detached HEAD that prints the literal string "HEAD", so fall back to the
 * short commit SHA (`git rev-parse --short HEAD`). On a fresh repo with no
 * commits yet, `--abbrev-ref HEAD` itself fails (HEAD doesn't resolve to any
 * commit) — fall back to `git symbolic-ref --short HEAD` (works pre-first-
 * commit too); if that also fails, `branch` is null while `root`/`name`
 * still resolve.
 */
export function captureRepoInfo({ cwd, env = process.env, execFn = execFileSync, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const opts = { cwd, encoding: 'utf8', timeout: timeoutMs, env: gitEnv(env) }
  try {
    const root = execFn('git', ['rev-parse', '--show-toplevel'], opts).trim()
    if (!root) return null
    const name = path.basename(root)

    let branch = null
    try {
      const abbrev = execFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim()
      branch = abbrev === 'HEAD' ? execFn('git', ['rev-parse', '--short', 'HEAD'], opts).trim() || null : abbrev || null
    } catch {
      try {
        branch = execFn('git', ['symbolic-ref', '--short', 'HEAD'], opts).trim() || null
      } catch {
        branch = null
      }
    }

    return { root, name, branch }
  } catch {
    return null
  }
}

/** `-\t-\t<path>` (numstat's own marker) or a numeric add/del pair. */
function parseNumstatLine(line) {
  const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/)
  if (!match) return null
  const [, add, del, filePath] = match
  const binary = add === '-' || del === '-'
  return {
    path: filePath,
    additions: binary ? 0 : Number(add),
    deletions: binary ? 0 : Number(del),
    binary,
  }
}

/** Heuristic binary sniff for an untracked file numstat never reported on:
 * a NUL byte in the first chunk is git's own rule of thumb too. */
function isBinaryBuffer(buf) {
  return buf.subarray(0, 8000).includes(0)
}

/** Line count for an untracked file, treated entirely as additions. A
 * trailing final newline is not itself counted as an extra empty line. */
function countLinesAsAdditions(buf) {
  if (buf.length === 0) return 0
  const parts = buf.toString('utf8').split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

function summarizeStderr(stderr) {
  if (!stderr) return ''
  return String(stderr).trim().slice(0, 300)
}

function degraded(baseCommit, computedAt, reason) {
  return {
    baseCommit,
    additions: null,
    deletions: null,
    filesChanged: null,
    files: [],
    truncated: false,
    computedAt,
    error: reason,
  }
}

/**
 * Compute diff stats for a job's cwd against its recorded baseline commit:
 * tracked changes via `git diff --numstat <base>` (working tree vs base, so
 * commits the agent itself made are included) plus untracked, non-ignored
 * files via `git ls-files --others --exclude-standard`. Pure and injectable
 * (runner/readFileFn) so tests never depend on process.mjs's real spawn path;
 * production code defaults to process.mjs's bounded runCommand.
 *
 * Read-only: never runs a git command that can write to the index or working
 * tree, and always passes GIT_OPTIONAL_LOCKS=0.
 *
 * Returns null when there is no baseline to diff against (the caller's "no
 * stats, no error" case). On a git failure (missing binary, timeout, a
 * baseCommit that no longer resolves) returns a degraded object with every
 * numeric field null and `error` set — this function itself never throws,
 * so a stats failure can never fail the job it was computed for.
 */
export async function computeDiffStats({
  cwd,
  baseCommit,
  runner = defaultRunCommand,
  maxFiles = DEFAULT_MAX_FILES,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  readFileFn = fs.readFileSync,
}) {
  if (!baseCommit) return null

  const computedAt = new Date().toISOString()
  const runnerEnv = gitEnv(env)

  let numstatOut
  try {
    const result = await runner('git', ['diff', '--numstat', baseCommit], { cwd, env: runnerEnv, timeoutMs })
    if (result.timedOut) return degraded(baseCommit, computedAt, 'git diff --numstat timed out')
    if (result.code !== 0) return degraded(baseCommit, computedAt, `git diff --numstat exited ${result.code}: ${summarizeStderr(result.stderr)}`)
    numstatOut = result.stdout ?? ''
  } catch (error) {
    return degraded(baseCommit, computedAt, String(error?.message ?? error))
  }

  let untrackedOut = ''
  try {
    const result = await runner('git', ['ls-files', '--others', '--exclude-standard'], { cwd, env: runnerEnv, timeoutMs })
    if (!result.timedOut && result.code === 0) untrackedOut = result.stdout ?? ''
  } catch {
    // Untracked listing is best-effort: the tracked stats above are still valid on their own.
  }

  const entries = []
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue
    const entry = parseNumstatLine(line)
    if (entry) entries.push(entry)
  }

  for (const rel of untrackedOut.split('\n')) {
    const filePath = rel.trim()
    if (!filePath) continue
    try {
      const buf = readFileFn(path.join(cwd, filePath))
      entries.push(
        isBinaryBuffer(buf)
          ? { path: filePath, additions: 0, deletions: 0, binary: true }
          : { path: filePath, additions: countLinesAsAdditions(buf), deletions: 0, binary: false }
      )
    } catch {
      // Vanished between ls-files and read — skip it rather than fail the whole computation.
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))

  let additions = 0
  let deletions = 0
  for (const entry of entries) {
    additions += entry.additions
    deletions += entry.deletions
  }

  const truncated = entries.length > maxFiles
  const files = truncated ? entries.slice(0, maxFiles) : entries

  return {
    baseCommit,
    additions,
    deletions,
    filesChanged: entries.length,
    files,
    truncated,
    computedAt,
    error: null,
  }
}

/**
 * Informational-only comparison between a handoff's self-reported
 * `changedFiles` and the measured diff file set. Returns null when nothing
 * was declared — there is nothing to compare a measurement against.
 */
export function computeChangedFilesMismatch({ declaredFiles = [], measuredFiles = [] } = {}) {
  if (!Array.isArray(declaredFiles) || declaredFiles.length === 0) return null
  const measuredSet = new Set(measuredFiles)
  const declaredSet = new Set(declaredFiles)
  const onlyDeclared = declaredFiles.filter((f) => !measuredSet.has(f))
  const onlyMeasured = measuredFiles.filter((f) => !declaredSet.has(f))
  return { matches: onlyDeclared.length === 0 && onlyMeasured.length === 0, onlyDeclared, onlyMeasured }
}

/**
 * Tiny TTL cache for live diff stats (GET /api/jobs/:id/diff-stats on a
 * still-running write job): a few seconds is enough to stop a fast dashboard
 * poll loop from re-shelling out to git on every render, without staling a
 * genuinely progressing job for long.
 */
export function createDiffStatsCache({ ttlMs = 4000 } = {}) {
  const store = new Map()
  return {
    get(key) {
      const hit = store.get(key)
      if (!hit) return undefined
      if (Date.now() - hit.at > ttlMs) {
        store.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key, value) {
      store.set(key, { value, at: Date.now() })
    },
  }
}
