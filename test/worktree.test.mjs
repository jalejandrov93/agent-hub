import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { checkWriteAllowed, acquireWriteLock, releaseWriteLock } from '../src/worktree.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepoWithSecondaryWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-worktree-'))
  const primary = path.join(base, 'primary')
  const secondary = path.join(base, 'secondary')
  fs.mkdirSync(primary)

  git(['init', '-q'], primary)
  git(['config', 'user.email', 'test@test.local'], primary)
  git(['config', 'user.name', 'Test'], primary)
  fs.writeFileSync(path.join(primary, 'a.txt'), 'x')
  git(['add', '-A'], primary)
  git(['commit', '-q', '-m', 'init'], primary)
  git(['worktree', 'add', secondary, '-b', 'wt-branch'], primary)

  return { base, primary, secondary }
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-worktree-home-'))
}

test('write is rejected in the primary worktree', () => {
  const { primary } = makeRepoWithSecondaryWorktree()
  const result = checkWriteAllowed({ cwd: primary })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /primary worktree/i)
})

test('write is allowed in a secondary (linked) git worktree', () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const result = checkWriteAllowed({ cwd: secondary })
  assert.equal(result.allowed, true)
})

test('write is allowed in the primary worktree when explicitly allowlisted', () => {
  const { primary } = makeRepoWithSecondaryWorktree()
  const result = checkWriteAllowed({ cwd: primary, allowlist: [primary] })
  assert.equal(result.allowed, true)
  assert.match(result.reason, /allowlist/i)
})

test('a cwd outside any git repo is rejected unless allowlisted', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-not-a-repo-'))
  assert.equal(checkWriteAllowed({ cwd: outside }).allowed, false)
  assert.equal(checkWriteAllowed({ cwd: outside, allowlist: [outside] }).allowed, true)
})

test('acquireWriteLock succeeds once, then blocks a second writer until released', () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const env = { AGENT_HUB_HOME: tmpHome() }

  const first = acquireWriteLock({ cwd: secondary, jobId: 'job-1', env })
  assert.equal(first.acquired, true)

  const second = acquireWriteLock({ cwd: secondary, jobId: 'job-2', env })
  assert.equal(second.acquired, false)
  assert.match(second.reason, /locked/i)

  releaseWriteLock({ cwd: secondary, env })

  const third = acquireWriteLock({ cwd: secondary, jobId: 'job-3', env })
  assert.equal(third.acquired, true, 'lock is available again after release')
})

test('acquireWriteLock reclaims a stale lock left by a dead pid', async () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { paths } = await import('../src/config.mjs')
  const { locksDir } = paths(env)
  fs.mkdirSync(locksDir, { recursive: true })

  // Forge a lock file as if held by a long-dead pid.
  const crypto = await import('node:crypto')
  const hash = crypto.createHash('sha1').update(path.resolve(secondary)).digest('hex')
  fs.writeFileSync(path.join(locksDir, `${hash}.lock`), JSON.stringify({ pid: 999999, jobId: 'stale', cwd: secondary, acquiredAt: new Date().toISOString() }))

  const result = acquireWriteLock({ cwd: secondary, jobId: 'job-fresh', env })
  assert.equal(result.acquired, true, 'a lock held by a dead pid is reclaimed')
})
