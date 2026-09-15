import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobstore-'))
}

async function freshJobstore(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/jobstore.mjs?t=' + Date.now() + Math.random())
}

test('createJob allocates a unique jobId and writes prompt.txt + initial result.json', async () => {
  const home = tmpHome()
  const { createJob, readResult } = await freshJobstore(home)

  const job = createJob({ agent: 'agy', model: 'gemini-3.8-flash-low', task: 'Reply exactly: PONG', cwd: '/tmp', title: 't' })
  assert.ok(job.jobId)
  assert.equal(job.status, 'queued')

  const dir = path.join(home, 'runs', job.jobId)
  assert.ok(fs.existsSync(path.join(dir, 'prompt.txt')))
  assert.equal(fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'), 'Reply exactly: PONG')

  const result = readResult(job.jobId)
  assert.equal(result.status, 'queued')
  assert.equal(result.agent, 'agy')
})

test('createJob persists variant, sessionId and parentJobId (needed by job_reply to resume a conversation)', async () => {
  const home = tmpHome()
  const { createJob, readResult } = await freshJobstore(home)

  const job = createJob({
    agent: 'opencode',
    model: 'opencode/muse-spark-1.3-contributor-free',
    task: 'do it',
    cwd: '/tmp',
    title: 't',
    variant: 'high',
    sessionId: 'ses_abc123',
    parentJobId: '2026-parent-job',
  })

  const result = readResult(job.jobId)
  assert.equal(result.variant, 'high')
  assert.equal(result.sessionId, 'ses_abc123')
  assert.equal(result.parentJobId, '2026-parent-job')
})

test('createJob defaults variant, sessionId and parentJobId to null when omitted', async () => {
  const home = tmpHome()
  const { createJob, readResult } = await freshJobstore(home)
  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't' })
  const result = readResult(job.jobId)
  assert.equal(result.variant, null)
  assert.equal(result.sessionId, null)
  assert.equal(result.parentJobId, null)
})

test('createJob persists the v2 record fields: taskType, turnDepth, timeoutSource and learningIds', async () => {
  const home = tmpHome()
  const { createJob, readResult } = await freshJobstore(home)

  const job = createJob({
    agent: 'agy',
    model: 'x',
    task: 't',
    cwd: '/tmp',
    title: 't',
    taskType: 'recon',
    turnDepth: 2,
    timeoutS: 600,
    timeoutSource: 'adaptive',
    learningIds: ['l-1', 'l-2'],
  })

  const result = readResult(job.jobId)
  assert.equal(result.taskType, 'recon')
  assert.equal(result.turnDepth, 2)
  assert.equal(result.timeoutS, 600)
  assert.equal(result.timeoutSource, 'adaptive')
  assert.deepEqual(result.learningIds, ['l-1', 'l-2'])
})

test('createJob defaults taskType to null, turnDepth to 0, timeoutSource to "default" and learningIds to []', async () => {
  const home = tmpHome()
  const { createJob, readResult } = await freshJobstore(home)

  const result = readResult(createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't' }).jobId)
  assert.equal(result.taskType, null)
  assert.equal(result.turnDepth, 0)
  assert.equal(result.timeoutSource, 'default')
  assert.deepEqual(result.learningIds, [])
})

test('two createJob calls never collide on jobId', async () => {
  const home = tmpHome()
  const { createJob } = await freshJobstore(home)
  const ids = new Set()
  for (let i = 0; i < 50; i++) {
    ids.add(createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: `j${i}` }).jobId)
  }
  assert.equal(ids.size, 50)
})

test('updateResult merges fields and persists across reads', async () => {
  const home = tmpHome()
  const { createJob, updateResult, readResult } = await freshJobstore(home)
  const job = createJob({ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', task: 't', cwd: '/tmp', title: 't' })

  updateResult(job.jobId, { status: 'running', pid: 1234, pgid: 1234 })
  let result = readResult(job.jobId)
  assert.equal(result.status, 'running')
  assert.equal(result.pid, 1234)

  updateResult(job.jobId, { status: 'succeeded', tokens: 42 })
  result = readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.tokens, 42)
  assert.equal(result.pid, 1234, 'earlier fields survive a partial update')
})

test('listJobs returns all known jobs sorted newest first', async () => {
  const home = tmpHome()
  const { createJob, listJobs } = await freshJobstore(home)
  const j1 = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 'first' })
  await new Promise((r) => setTimeout(r, 5))
  const j2 = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 'second' })

  const jobs = listJobs()
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].jobId, j2.jobId)
  assert.equal(jobs[1].jobId, j1.jobId)
})

test('readResult throws a clear error for an unknown jobId', async () => {
  const home = tmpHome()
  const { readResult } = await freshJobstore(home)
  assert.throws(() => readResult('does-not-exist'), /not found/i)
})

test('reconcileOrphans marks running jobs with a dead pid as failed/orphaned', async () => {
  const home = tmpHome()
  const { createJob, updateResult, readResult, reconcileOrphans } = await freshJobstore(home)

  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't' })
  // A pid that is essentially guaranteed to be dead/unused.
  const deadPid = 999999
  updateResult(job.jobId, { status: 'running', pid: deadPid, pgid: deadPid })

  const changed = reconcileOrphans()
  assert.deepEqual(changed, [job.jobId])

  const result = readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'orphaned')
})

test('reconcileOrphans leaves running jobs with a live pid untouched', async () => {
  const home = tmpHome()
  const { createJob, updateResult, readResult, reconcileOrphans } = await freshJobstore(home)

  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't' })
  updateResult(job.jobId, { status: 'running', pid: process.pid, pgid: process.pid })

  const changed = reconcileOrphans()
  assert.deepEqual(changed, [])
  assert.equal(readResult(job.jobId).status, 'running')
})

test('updateResult never overwrites a canceled job with a late succeeded/failed status', async () => {
  const home = tmpHome()
  const { createJob, updateResult, readResult } = await freshJobstore(home)
  const job = createJob({ agent: 'opencode', model: 'x', task: 't', cwd: '/tmp', title: 't' })

  updateResult(job.jobId, { status: 'canceled', errorKind: 'canceled_by_user', error: 'canceled by user' })
  // A late finishJob (the MCP process) reports success from a record it read
  // before the cancel landed; it may still contribute tokens/sessionId.
  updateResult(job.jobId, { status: 'succeeded', tokens: 99, sessionId: 'ses_late' })

  const result = readResult(job.jobId)
  assert.equal(result.status, 'canceled')
  assert.equal(result.errorKind, 'canceled_by_user')
  assert.equal(result.error, 'canceled by user')
  assert.equal(result.tokens, 99, 'non-status fields still merge')
  assert.equal(result.sessionId, 'ses_late')
})

test('appendStdout writes to stdout.log and stdoutPath reports the file', async () => {
  const home = tmpHome()
  const { createJob, appendStdout, stdoutPath } = await freshJobstore(home)
  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't' })

  appendStdout(job.jobId, 'line one\n')
  appendStdout(job.jobId, 'line two\n')

  const content = fs.readFileSync(stdoutPath(job.jobId), 'utf8')
  assert.equal(content, 'line one\nline two\n')
})

test('updateResult throws "job not found" for an unknown jobId', async () => {
  const home = tmpHome()
  const { updateResult } = await freshJobstore(home)
  assert.throws(() => updateResult('does-not-exist', { status: 'running' }), /job not found: does-not-exist/)
})

test('every jobId-taking function rejects path-traversal and malformed ids with "job not found"', async () => {
  const home = tmpHome()
  const { createJob, readResult, updateResult, responsePath, stdoutPath, promptPath, appendStdout } = await freshJobstore(home)

  const badIds = ['..', '../evil', '../../x', 'a/../b', 'a..b', 'x/y', '', '.hidden', 'a b']
  for (const id of badIds) {
    assert.throws(() => readResult(id), new RegExp(`job not found: ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `readResult(${JSON.stringify(id)})`)
    assert.throws(() => updateResult(id, { status: 'running' }), /job not found:/, `updateResult(${JSON.stringify(id)})`)
    assert.throws(() => responsePath(id), /job not found:/, `responsePath(${JSON.stringify(id)})`)
    assert.throws(() => stdoutPath(id), /job not found:/, `stdoutPath(${JSON.stringify(id)})`)
    assert.throws(() => promptPath(id), /job not found:/, `promptPath(${JSON.stringify(id)})`)
    assert.throws(() => appendStdout(id, 'x'), /job not found:/, `appendStdout(${JSON.stringify(id)})`)
  }
})

test('generated job ids stay valid across every jobId-taking function', async () => {
  const home = tmpHome()
  const { createJob, readResult, updateResult, responsePath, stdoutPath, promptPath, appendStdout } = await freshJobstore(home)
  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't' })

  assert.equal(readResult(job.jobId).jobId, job.jobId)
  assert.ok(responsePath(job.jobId).endsWith(path.join(job.jobId, 'response.txt')))
  assert.ok(stdoutPath(job.jobId).endsWith(path.join(job.jobId, 'stdout.log')))
  assert.ok(promptPath(job.jobId).endsWith(path.join(job.jobId, 'prompt.txt')))
  appendStdout(job.jobId, 'ok\n')
  updateResult(job.jobId, { status: 'running' })
  assert.equal(readResult(job.jobId).status, 'running')
})

test('updateResult leaves no .lock file behind after a successful update', async () => {
  const home = tmpHome()
  const { createJob, updateResult } = await freshJobstore(home)
  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't' })

  updateResult(job.jobId, { status: 'running', pid: 1234 })

  const dir = path.join(home, 'runs', job.jobId)
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.lock'))
  assert.deepEqual(leftovers, [])
})
