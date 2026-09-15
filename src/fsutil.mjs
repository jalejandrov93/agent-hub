import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Write JSON atomically: serialize to a unique temp file in the same
 * directory as the target, then rename() over it. rename() within one
 * filesystem is atomic on POSIX, so a concurrent reader (the MCP process and
 * the separately running dashboard process both write these files) never
 * observes a partial/truncated file, and a crash mid-write leaves only the
 * orphaned temp file behind, never a corrupted target.
 */
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Read and parse JSON from `file`. Returns a fresh structuredClone of
 * `defaultValue` on ENOENT or a parse error, so callers never get handed the
 * same object reference twice and accidentally cross-mutate their default.
 */
export function readJsonSafe(file, defaultValue) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return structuredClone(defaultValue)
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Synchronous sleep via Atomics.wait — every caller of updateJsonLocked is sync. */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/**
 * Acquire `${file}.lock` (exclusive 'wx' create — atomic, so two concurrent
 * acquirers can never both win), mirroring worktree.mjs's acquireWriteLock
 * pattern. Reclaims a lock held by a dead pid or older than `staleMs`
 * immediately; otherwise sleeps `retryDelayMs` and retries, up to `retries`
 * attempts. Throws when the budget is exhausted.
 */
function acquireLock(file, lockPath, { retries, retryDelayMs, staleMs }) {
  // Ownership token: a holder paused longer than staleMs can have its lock
  // reclaimed by another process, then wake up and run its `finally`. Without
  // a token that release would delete the NEW holder's lock, letting a third
  // process in while the second still believes it holds it. The token is
  // written into the lock JSON so release/reclaim can tell instances apart.
  const token = crypto.randomBytes(8).toString('hex')
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }))
      fs.closeSync(fd)
      return token
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }

    // Snapshot exactly what is at lockPath right now. Reclaiming below must
    // only ever remove THIS exact lock instance — never a fresh one a
    // legitimate holder created in the gap between this snapshot and the
    // eventual rmSync — otherwise we could unlink another process's valid,
    // just-acquired lock and both end up believing we hold it.
    let raw
    try {
      raw = fs.readFileSync(lockPath, 'utf8')
    } catch {
      // Vanished between our failed open() and this read: the previous
      // holder already released it on its own. Retry immediately without
      // touching the filesystem — our own openSync will either win the now
      // -empty slot or correctly EEXIST against whoever grabbed it first.
      continue
    }

    let holder = null
    let stale
    try {
      holder = JSON.parse(raw)
      stale = !isPidAlive(holder.pid) || Date.now() - new Date(holder.acquiredAt).getTime() > staleMs
    } catch {
      // Unreadable/garbled lock file: only counts as stale once it is older
      // than staleMs by mtime — a lock file mid-write by its holder is not
      // yet stale just because we can't parse it this instant.
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs
      } catch {
        continue // vanished while checking mtime — retry immediately, nothing to reclaim
      }
    }

    if (stale) {
      // Re-read immediately before deleting and only delete if the bytes are
      // still exactly what we diagnosed as stale — closes the TOCTOU window
      // where the original holder finished and a new legitimate holder
      // already re-created the lock in between.
      let current
      try {
        current = fs.readFileSync(lockPath, 'utf8')
      } catch {
        continue // already gone — nothing to reclaim, retry
      }
      // Only delete the exact lock instance we diagnosed as stale. When both
      // sides carry a token, require a token match; a legacy lock without one
      // falls back to byte-for-byte equality (strictly stronger than a token).
      let sameInstance = current === raw
      if (holder && holder.token) {
        try {
          sameInstance = JSON.parse(current).token === holder.token
        } catch {
          sameInstance = current === raw
        }
      }
      if (sameInstance) fs.rmSync(lockPath, { force: true })
      continue // retry immediately, does not consume a sleep
    }

    sleepSync(retryDelayMs)
  }

  throw new Error(`lock timeout: ${file}`)
}

/**
 * Atomic, cross-process read-modify-write on a JSON file. Both the MCP
 * process and the separately running dashboard process do read-modify-write
 * on the same state files; writeJsonAtomic alone only makes the final write
 * atomic, not the read-modify-write sequence around it, so a concurrent
 * updater's change can be silently lost. This wraps the whole sequence in a
 * file lock so only one process at a time reads, computes, and writes.
 *
 * `updater(current)` may return the next value, or mutate `current` in place
 * and return undefined (in which case the mutated `current` is what gets
 * written).
 */
export function updateJsonLocked(file, updater, { defaultValue = {}, retries = 200, retryDelayMs = 10, staleMs = 30_000 } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const lockPath = `${file}.lock`

  const token = acquireLock(file, lockPath, { retries, retryDelayMs, staleMs })
  try {
    const current = readJsonSafe(file, defaultValue)
    const updated = updater(current)
    const next = updated === undefined ? current : updated
    writeJsonAtomic(file, next)
    return next
  } finally {
    releaseLock(lockPath, token)
  }
}

/**
 * Release a lock only if it is still the instance this caller acquired. A
 * holder whose lock was reclaimed as stale must not delete the replacement
 * lock a newer holder owns; the ownership token makes that check exact.
 */
function releaseLock(lockPath, token) {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    if (holder.token === token) fs.rmSync(lockPath, { force: true })
  } catch {
    // Already gone, or garbled by another writer: leave whatever is there.
  }
}
