import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { paths } from './config.mjs'
import { getDb, upsertLease, deleteLease } from './storage/index.mjs'

function gitDirs(cwd) {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' }).trim()
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim()
    return { gitDir: path.resolve(cwd, gitDir), commonDir: path.resolve(cwd, commonDir) }
  } catch {
    return null
  }
}

/**
 * A linked worktree (created with `git worktree add`) has its own --git-dir
 * (<common>/worktrees/<name>) distinct from --git-common-dir. The primary
 * checkout has them equal.
 */
export function isSecondaryWorktree(cwd) {
  const dirs = gitDirs(cwd)
  if (!dirs) return false
  return dirs.gitDir !== dirs.commonDir
}

function isAllowlisted(resolved, allowlist) {
  return allowlist.some((allowed) => {
    const abs = path.resolve(allowed)
    return resolved === abs || resolved.startsWith(abs + path.sep)
  })
}

/**
 * Write mode gate: cwd must be a secondary git worktree, or explicitly
 * allowlisted. Never allows writes straight into a primary checkout.
 */
export function checkWriteAllowed({ cwd, allowlist = [] }) {
  const resolved = path.resolve(cwd)

  if (isAllowlisted(resolved, allowlist)) {
    return { allowed: true, reason: 'allowlisted path' }
  }

  const dirs = gitDirs(resolved)
  if (!dirs) {
    return { allowed: false, reason: 'not a git worktree, and not allowlisted' }
  }
  if (dirs.gitDir === dirs.commonDir) {
    return { allowed: false, reason: 'primary worktree: write mode requires a secondary `git worktree add` checkout, or an allowlisted path' }
  }
  return { allowed: true, reason: 'secondary git worktree' }
}

/**
 * Default lease TTL: a write lock expires this long after its last heartbeat
 * unless refreshed. A job that dies without releasing (killed MCP process,
 * crash between acquire and the done.finally) therefore stops blocking the
 * cwd on its own; another holder can reclaim it. Override per-acquire with
 * `ttlMs`, or globally with AGENT_HUB_LEASE_TTL_MS (read by jobrunner).
 */
export const LEASE_TTL_MS_DEFAULT = 120_000

function lockFilePath(cwd, env) {
  const { locksDir } = paths(env)
  const hash = crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex')
  return path.join(locksDir, `${hash}.lock`)
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function normalizeTtlMs(ttlMs) {
  const n = Number(ttlMs)
  return Number.isFinite(n) && n > 0 ? n : LEASE_TTL_MS_DEFAULT
}

/** A parsed lock holder is stale when its pid is dead or its lease expired.
 * `nowMs` is injectable so a caller (or a test) can judge staleness against a
 * chosen instant instead of wall-clock; it defaults to the real clock. */
function isHolderStale(holder, nowMs = Date.now()) {
  if (!isPidAlive(holder.pid)) return true
  if (holder.expiresAt) return nowMs >= new Date(holder.expiresAt).getTime()
  return false
}

/** Atomic write of the lock JSON (temp file + rename), so a concurrent
 * reader never observes a partial file mid-heartbeat. */
function writeHolderAtomic(file, holder) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(holder), 'utf8')
  fs.renameSync(tmp, file)
}

function mirrorLeaseAcquire({ jobId, token, expiresAt, env = process.env }) {
  try {
    const ctx = getDb(env)
    if (!ctx || ctx.backend !== 'sqlite' || !ctx.db) return
    upsertLease(ctx, {
      job_id: jobId ?? token,
      owner: token,
      expires_at: expiresAt,
    })
  } catch {
    // Best-effort: file lock is authoritative until C1
  }
}

function mirrorLeaseHeartbeat({ jobId, token, expiresAt, env = process.env }) {
  try {
    const ctx = getDb(env)
    if (!ctx || ctx.backend !== 'sqlite' || !ctx.db) return
    upsertLease(ctx, {
      job_id: jobId ?? token,
      owner: token,
      expires_at: expiresAt,
    })
  } catch {
    // Best-effort
  }
}

function mirrorLeaseRelease({ jobId, token, env = process.env }) {
  try {
    const ctx = getDb(env)
    if (!ctx || ctx.backend !== 'sqlite' || !ctx.db) return
    if (jobId) deleteLease(ctx, jobId)
    if (token && token !== jobId) deleteLease(ctx, token)
  } catch {
    // Best-effort
  }
}

/**
 * Lease record stored in the lock file: { pid, jobId, token, cwd,
 * acquiredAt, heartbeatAt, expiresAt }. The random `token` is the ownership
 * identity (same pattern as fsutil.mjs's updateJsonLocked): a holder whose
 * lease was reclaimed while it was paused can wake up and run its `finally`,
 * but its stale token no longer matches, so it can neither release nor
 * refresh the NEW holder's lease.
 *
 * Single-writer per cwd: the exclusive file create ('wx') is atomic, so two
 * concurrent acquire attempts can never both succeed. A lease whose pid is
 * dead OR whose expiresAt passed is reclaimed automatically by the next
 * acquirer.
 */
export function acquireWriteLock({ cwd, jobId, env = process.env, ttlMs = LEASE_TTL_MS_DEFAULT, nowMs = Date.now() }) {
  const { locksDir } = paths(env)
  fs.mkdirSync(locksDir, { recursive: true })
  const file = lockFilePath(cwd, env)
  const ttl = normalizeTtlMs(ttlMs)
  const now = new Date()
  const token = crypto.randomBytes(8).toString('hex')
  const lease = {
    pid: process.pid,
    jobId,
    token,
    cwd: path.resolve(cwd),
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  }

  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, JSON.stringify(lease))
    fs.closeSync(fd)
    mirrorLeaseAcquire({ jobId, token, expiresAt: lease.expiresAt, env })
    return { acquired: true, file, token }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }

  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    // Vanished between our failed open() and this read — retry (fresh token).
    return acquireWriteLock({ cwd, jobId, env, ttlMs: ttl, nowMs })
  }

  let holder = null
  let stale = false
  try {
    holder = JSON.parse(raw)
    stale = isHolderStale(holder, nowMs)
  } catch {
    // Unreadable/garbled lock file: only counts as stale once it is older
    // than the ttl by mtime — a lock mid-write by its holder is not stale
    // just because we can't parse it this instant.
    try {
      stale = nowMs - fs.statSync(file).mtimeMs > ttl
    } catch {
      return acquireWriteLock({ cwd, jobId, env, ttlMs: ttl, nowMs }) // vanished — retry
    }
  }

  if (stale) {
    // Re-read immediately before deleting and only delete the exact lease
    // instance diagnosed as stale — never a fresh lease a legitimate holder
    // created in the gap (same TOCTOU guard as fsutil.mjs).
    let current
    try {
      current = fs.readFileSync(file, 'utf8')
    } catch {
      return acquireWriteLock({ cwd, jobId, env, ttlMs: ttl, nowMs }) // already gone — retry
    }
    let sameInstance = current === raw
    if (holder && holder.token) {
      try {
        sameInstance = JSON.parse(current).token === holder.token
      } catch {
        sameInstance = current === raw
      }
    }
    if (sameInstance) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // Lost the race — retry below regardless.
      }
    }
    return acquireWriteLock({ cwd, jobId, env, ttlMs: ttl, nowMs })
  }

  if (holder) return { acquired: false, reason: `locked by pid ${holder.pid} (job ${holder.jobId})` }
  return { acquired: false, reason: 'locked' }
}

/**
 * Refresh heartbeatAt + expiresAt, extending the lease by `ttlMs` from now.
 * Only succeeds when `token` still matches the current holder — a stale
 * holder whose lease was reclaimed gets `false` and must NOT write. Returns
 * false as well when the lock file is missing or held by someone else.
 * A heartbeat always requires a token: legacy locks written without one can
 * never be refreshed and must be re-acquired as a lease first.
 */
export function heartbeatWriteLock({ cwd, token, env = process.env, ttlMs = LEASE_TTL_MS_DEFAULT }) {
  if (!token) return false
  const file = lockFilePath(cwd, env)
  let holder
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  if (holder.token !== token) return false
  const ttl = normalizeTtlMs(ttlMs)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttl).toISOString()
  try {
    writeHolderAtomic(file, {
      ...holder,
      heartbeatAt: now.toISOString(),
      expiresAt,
    })
    mirrorLeaseHeartbeat({ jobId: holder.jobId, token, expiresAt, env })
  } catch {
    return false
  }
  return true
}

/**
 * Whether `token` is still the current holder of the cwd lease — the
 * write-guard check. A holder that returns false here woke up after its
 * lease expired (or was reclaimed via dead pid) and must not write.
 */
export function holdsWriteLock({ cwd, token, env = process.env }) {
  if (!token) return false
  try {
    const holder = JSON.parse(fs.readFileSync(lockFilePath(cwd, env), 'utf8'))
    return holder.token === token
  } catch {
    return false
  }
}

/** Current lease record for `cwd`, or null when unlocked/unreadable. */
export function readWriteLock({ cwd, env = process.env }) {
  try {
    return JSON.parse(fs.readFileSync(lockFilePath(cwd, env), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Adopt an existing reservation lock as an execution lease for a new jobId.
 * Succeeds only if the lock exists, token matches, and lease has not expired.
 * Never steals from another holder.
 */
export function adoptWriteLock({ cwd, token, jobId, env = process.env, ttlMs = LEASE_TTL_MS_DEFAULT }) {
  if (!token) return { adopted: false, reason: 'missing reservation token' }
  const file = lockFilePath(cwd, env)
  let holder
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { adopted: false, reason: 'lock file unreadable or missing' }
  }
  if (holder.token !== token) {
    return { adopted: false, reason: 'reservation token mismatch or reclaimed' }
  }
  if (isHolderStale(holder)) {
    return { adopted: false, reason: 'reservation expired' }
  }
  const ttl = normalizeTtlMs(ttlMs)
  const now = new Date()
  const updatedHolder = {
    ...holder,
    jobId: jobId ?? holder.jobId,
    pid: process.pid,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  }
  try {
    writeHolderAtomic(file, updatedHolder)
    mirrorLeaseAcquire({ jobId: updatedHolder.jobId, token, expiresAt: updatedHolder.expiresAt, env })
    return { adopted: true, token, file }
  } catch (error) {
    return { adopted: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Release the cwd lease, but ONLY when the caller still owns it.
 *
 * - Token path (current): `token` must match the holder's token. A stale
 *   holder whose lease was reclaimed gets `false` and the new holder's lease
 *   is left untouched. Returns true when the lock was released (or was
 *   already gone).
 * - Legacy path (DEPRECATED): `token` omitted + `jobId` given requires
 *   holder.jobId === jobId && holder.pid === process.pid, else false.
 * - Fully legacy (DEPRECATED): neither `token` nor `jobId` deletes
 *   unconditionally, as before — kept only so old callers keep working.
 *   New code must always pass the `token` returned by acquireWriteLock.
 */
export function releaseWriteLock({ cwd, token, jobId, env = process.env }) {
  const file = lockFilePath(cwd, env)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    mirrorLeaseRelease({ jobId, token, env })
    return true // already gone — nothing to release
  }

  if (token !== undefined && token !== null) {
    let holder
    try {
      holder = JSON.parse(raw)
    } catch {
      return false // garbled: cannot prove ownership — leave it alone
    }
    if (holder.token !== token) return false
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // Vanished under us — the outcome (no lock) is what we wanted.
    }
    mirrorLeaseRelease({ jobId: holder.jobId ?? jobId, token, env })
    return true
  }

  if (jobId !== undefined && jobId !== null) {
    let holder
    try {
      holder = JSON.parse(raw)
    } catch {
      fs.rmSync(file, { force: true })
      mirrorLeaseRelease({ jobId, token, env })
      return true
    }
    if (holder.jobId !== jobId || holder.pid !== process.pid) return false
    fs.rmSync(file, { force: true })
    mirrorLeaseRelease({ jobId, token: holder.token ?? token, env })
    return true
  }

  // DEPRECATED fully-legacy path: unconditional delete.
  fs.rmSync(file, { force: true })
  mirrorLeaseRelease({ jobId, token, env })
  return true
}

export function isWorktreeClean(cwd, { exec = execFileSync } = {}) {
  // Fail closed: exec with cwd undefined inherits process.cwd(), which would
  // silently report the cleanliness of whatever repo the hub runs from.
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { clean: false, reason: 'missing-cwd' }
  }
  try {
    const output = exec('git', ['status', '--porcelain=v1'], { cwd, encoding: 'utf8' })
    const lines = output.split('\n').filter((line) => line.trim().length > 0)

    if (lines.length === 0) {
      return { clean: true, dirtyPaths: [] }
    }

    const dirtyPaths = lines.map((line) => {
      // porcelain v1 output is 3 characters of status (e.g., ' M ', '?? ') followed by the path
      return line.slice(3).trim()
    })

    return { clean: false, dirtyPaths }
  } catch {
    return { clean: false, reason: 'not-a-git-worktree' }
  }
}
