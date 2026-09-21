import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  acquireWriteLock,
  releaseWriteLock,
  heartbeatWriteLock,
  holdsWriteLock,
  readWriteLock,
} from '../src/worktree.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepoWithSecondaryWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-lease-'))
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-lease-home-'))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('acquire returns a tokenized lease (pid, jobId, token, acquiredAt, heartbeatAt, expiresAt)', () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const env = { AGENT_HUB_HOME: tmpHome() }

  const first = acquireWriteLock({ cwd: secondary, jobId: 'job-1', env })
  assert.equal(first.acquired, true)
  assert.match(first.token, /^[0-9a-f]{16}$/, 'token is random hex')

  const holder = readWriteLock({ cwd: secondary, env })
  assert.equal(holder.jobId, 'job-1')
  assert.equal(holder.pid, process.pid)
  assert.equal(holder.token, first.token)
  assert.ok(holder.acquiredAt, 'acquiredAt set')
  assert.ok(holder.heartbeatAt, 'heartbeatAt set')
  assert.ok(new Date(holder.expiresAt).getTime() > new Date(holder.heartbeatAt).getTime(), 'expiresAt after heartbeatAt')

  assert.equal(releaseWriteLock({ cwd: secondary, token: first.token, env }), true)
})

test('a) old holder cannot release the new holder lock after reclaim', () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const env = { AGENT_HUB_HOME: tmpHome() }

  // Deterministic clock: staleness is judged against the lease's OWN expiresAt
  // (never an assumed 'start + ttl', which drifts by however long acquire took
  // after the test read the clock) so this cannot race suite load.
  const a = acquireWriteLock({ cwd: secondary, jobId: 'job-A', env, ttlMs: 60000 })
  assert.equal(a.acquired, true)
  const expiresAtA = new Date(readWriteLock({ cwd: secondary, env }).expiresAt).getTime()

  // Control: one millisecond before A's real expiry, B is blocked.
  const blocked = acquireWriteLock({ cwd: secondary, jobId: 'job-B', env, nowMs: expiresAtA - 1 })
  assert.equal(blocked.acquired, false)

  // One millisecond after A's real expiry, B reclaims it — no sleeping.
  const b = acquireWriteLock({ cwd: secondary, jobId: 'job-B', env, nowMs: expiresAtA + 1 })
  assert.equal(b.acquired, true, 'expired lease is reclaimed by B')
  assert.notEqual(b.token, a.token)

  // Old holder wakes up: release with the stale token must fail, B keeps the lock.
  assert.equal(releaseWriteLock({ cwd: secondary, token: a.token, env }), false)
  assert.equal(holdsWriteLock({ cwd: secondary, token: a.token, env }), false)
  assert.equal(readWriteLock({ cwd: secondary, env }).token, b.token, 'B still holds the lock')
  assert.equal(readWriteLock({ cwd: secondary, env }).jobId, 'job-B')

  // The legitimate holder is unaffected: heartbeat + release work.
  assert.equal(heartbeatWriteLock({ cwd: secondary, token: b.token, env }), true)
  assert.equal(releaseWriteLock({ cwd: secondary, token: b.token, env }), true)
  assert.equal(readWriteLock({ cwd: secondary, env }), null, 'lock freed after B releases')
})

test('b) heartbeat stops -> lease expires -> new holder acquires -> old write/heartbeat/release fail', () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const env = { AGENT_HUB_HOME: tmpHome() }

  // Deterministic clock: staleness is judged against an injected instant, so
  // this test never races the wall clock under suite load.
  const t0 = Date.now()
  const a = acquireWriteLock({ cwd: secondary, jobId: 'job-A', env, ttlMs: 60000, nowMs: t0 })
  assert.equal(a.acquired, true)

  assert.equal(acquireWriteLock({ cwd: secondary, jobId: 'job-B', env, nowMs: t0 }).acquired, false)

  // A heartbeat extends the lease (from the real clock, ttlMs 60000), so a
  // later judgement inside the new window still sees a live lease.
  assert.equal(heartbeatWriteLock({ cwd: secondary, token: a.token, env, ttlMs: 60000 }), true)
  const extended = readWriteLock({ cwd: secondary, env })
  const stillHeld = acquireWriteLock({ cwd: secondary, jobId: 'job-B', env, nowMs: new Date(extended.expiresAt).getTime() - 1 })
  assert.equal(stillHeld.acquired, false, 'heartbeat extended the lease, B is still blocked')

  // Heartbeat stops: judged one millisecond past the extended expiry, B reclaims it.
  const b = acquireWriteLock({ cwd: secondary, jobId: 'job-B', env, nowMs: new Date(extended.expiresAt).getTime() + 1 })
  assert.equal(b.acquired, true, 'B acquires after A stopped heartbeating')

  // Old holder wakes up: every guarded operation with the stale token fails.
  assert.equal(holdsWriteLock({ cwd: secondary, token: a.token, env }), false, 'old write-guard fails')
  assert.equal(heartbeatWriteLock({ cwd: secondary, token: a.token, env }), false, 'old heartbeat fails')
  assert.equal(releaseWriteLock({ cwd: secondary, token: a.token, env }), false, 'old release fails')
  assert.equal(readWriteLock({ cwd: secondary, env }).token, b.token, 'B still holds the lock')

  assert.equal(releaseWriteLock({ cwd: secondary, token: b.token, env }), true)
})

test('c) compat: release without token but with the same jobId+pid still works (deprecated)', () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const env = { AGENT_HUB_HOME: tmpHome() }

  const a = acquireWriteLock({ cwd: secondary, jobId: 'job-legacy', env })
  assert.equal(a.acquired, true)

  // Legacy release with matching jobId (+ same pid, same process) succeeds.
  assert.equal(releaseWriteLock({ cwd: secondary, jobId: 'job-legacy', env }), true)
  const again = acquireWriteLock({ cwd: secondary, jobId: 'job-next', env })
  assert.equal(again.acquired, true, 'lock is available again after legacy release')

  // Legacy release with a DIFFERENT jobId must not steal the lock.
  assert.equal(releaseWriteLock({ cwd: secondary, jobId: 'job-legacy', env }), false)
  assert.equal(readWriteLock({ cwd: secondary, env }).token, again.token)

  // Fully legacy release (no token, no jobId) still deletes unconditionally.
  assert.equal(releaseWriteLock({ cwd: secondary, env }), true)
  assert.equal(readWriteLock({ cwd: secondary, env }), null)
})

test('heartbeat with a wrong/missing token, or on a missing lock, returns false', () => {
  const { secondary } = makeRepoWithSecondaryWorktree()
  const env = { AGENT_HUB_HOME: tmpHome() }

  assert.equal(heartbeatWriteLock({ cwd: secondary, token: 'deadbeefdeadbeef', env }), false)

  const a = acquireWriteLock({ cwd: secondary, jobId: 'job-A', env })
  assert.equal(heartbeatWriteLock({ cwd: secondary, token: 'deadbeefdeadbeef', env }), false)
  assert.equal(heartbeatWriteLock({ cwd: secondary, env }), false)
  assert.equal(holdsWriteLock({ cwd: secondary, env }), false)
  assert.equal(holdsWriteLock({ cwd: secondary, token: a.token, env }), true)

  assert.equal(releaseWriteLock({ cwd: secondary, token: a.token, env }), true)
})

/** jobrunner integration: a write job holds its lease via heartbeat past the
 * original TTL, and frees it with its own token on completion. */
test('a write job heartbeats its lease while running and releases it when done', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const { startJob } = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { extractLastJsonLine } = await import('../src/adapters/base.mjs?t=' + tag)

  // Runs ~1s: far past the 400ms lease TTL, so without the heartbeat timer
  // the lease would expire mid-job and a concurrent acquirer would steal it.
  const slowSuccess = `setTimeout(() => console.log(JSON.stringify({status:"SUCCESS",response:"PONG"})), 1000)`
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', slowSuccess],
      parseResult: (stdout) => {
        const json = extractLastJsonLine(stdout)
        return { ok: true, text: json.response, tokens: null, sessionId: null }
      },
      classifyError: () => null,
      listModels: () => [],
    },
  }

  const first = startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd: secondary,
    mode: 'write',
    leaseTtlMs: 400,
    adapterFor: (a) => adapters[a],
  })
  assert.equal(first.job.status, 'running')

  await sleep(700) // past the original 400ms TTL — heartbeat must have extended it
  const holder = readWriteLock({ cwd: secondary, env: process.env })
  assert.ok(holder, 'lease still held mid-job')
  assert.ok(new Date(holder.expiresAt).getTime() > Date.now(), 'expiry extended past the original TTL by heartbeats')

  const concurrent = startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd: secondary,
    mode: 'write',
    adapterFor: (a) => adapters[a],
  })
  assert.equal(concurrent.job.status, 'failed')
  assert.equal(concurrent.job.errorKind, 'locked')
  await concurrent.done

  await first.done
  assert.equal(jobstore.readResult(first.job.jobId).status, 'succeeded')
  assert.equal(readWriteLock({ cwd: secondary, env: process.env }), null, 'lease released after the job finished')
})
