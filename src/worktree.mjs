import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { paths } from './config.mjs'

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

/**
 * Single-writer lock per cwd: an exclusive file create ('wx') is atomic, so
 * two concurrent acquire attempts can never both succeed. A lock left by a
 * pid that is no longer alive (e.g. the MCP process was killed mid-job) is
 * reclaimed automatically.
 */
export function acquireWriteLock({ cwd, jobId, env = process.env }) {
  const { locksDir } = paths(env)
  fs.mkdirSync(locksDir, { recursive: true })
  const file = lockFilePath(cwd, env)

  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, jobId, cwd: path.resolve(cwd), acquiredAt: new Date().toISOString() }))
    fs.closeSync(fd)
    return { acquired: true, file }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }

  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isPidAlive(holder.pid)) {
      fs.rmSync(file, { force: true })
      return acquireWriteLock({ cwd, jobId, env })
    }
    return { acquired: false, reason: `locked by pid ${holder.pid} (job ${holder.jobId})` }
  } catch {
    return { acquired: false, reason: 'locked' }
  }
}

export function releaseWriteLock({ cwd, env = process.env }) {
  const file = lockFilePath(cwd, env)
  fs.rmSync(file, { force: true })
}
