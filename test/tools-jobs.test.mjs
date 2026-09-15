import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createJob } from '../src/jobstore.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tools-jobs-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/tools/jobs.mjs?t=' + Date.now() + Math.random())
}

test('job_reply rejects a parent that is not yet terminal', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { jobReplyTool } = await fresh(home)

  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', env })
  // status stays 'queued' — never marked terminal

  const result = await jobReplyTool({ jobId: job.jobId, message: 'follow up' })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'not_terminal')
  assert.equal(result.parentJobId, job.jobId)
})

test('job_reply rejects a terminal parent with no recorded sessionId', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', env })
  updateResult(job.jobId, { status: 'succeeded' }, env)

  const result = await jobReplyTool({ jobId: job.jobId, message: 'follow up' })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'no_session')
})

test('job_reply refuses copilot without spawning anything (copilot has no session resume)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const job = createJob({ agent: 'copilot', model: 'auto', task: 't', cwd: '/tmp', title: 't', mode: 'read', sessionId: 'sess-copilot', env })
  updateResult(job.jobId, { status: 'succeeded' }, env)

  const result = await jobReplyTool({ jobId: job.jobId, message: 'follow up' })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'unsupported')
})

test('job_reply starts a new job carrying the parent sessionId, agent, model and cwd, with a "(reply)" title by default', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-medium',
    task: 't',
    cwd: '/tmp',
    title: 'my plan',
    mode: 'read',
    sessionId: 'sess-parent',
    env,
  })
  updateResult(parent.jobId, { status: 'succeeded' }, env)

  let capturedArgs = null
  const fakeStartJob = (args) => {
    capturedArgs = args
    return { job: { jobId: 'reply-job-1', status: 'running', errorKind: null } }
  }

  const result = await jobReplyTool({ jobId: parent.jobId, message: 'looks good, execute it', startJobFn: fakeStartJob })

  assert.equal(result.jobId, 'reply-job-1')
  assert.equal(result.status, 'running')
  assert.equal(result.parentJobId, parent.jobId)
  assert.equal(capturedArgs.agent, 'agy')
  assert.equal(capturedArgs.model, 'gemini-3.8-flash-medium')
  assert.equal(capturedArgs.cwd, '/tmp')
  assert.equal(capturedArgs.sessionId, 'sess-parent')
  assert.equal(capturedArgs.mode, 'read', 'defaults to the parent job mode')
  assert.equal(capturedArgs.title, 'my plan (reply)')
  assert.equal(capturedArgs.parentJobId, parent.jobId)
  assert.equal(capturedArgs.task, 'looks good, execute it')
})

test('delegate rejects an unknown taskType with a clear error', async () => {
  const home = tmpHome()
  const { delegateTool } = await fresh(home)
  assert.throws(
    () => delegateTool({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', taskType: 'not-a-task' }),
    /unknown taskType: not-a-task/
  )
})

test('job_reply rejects an unknown taskType', async () => {
  const home = tmpHome()
  const { jobReplyTool } = await fresh(home)
  await assert.rejects(
    () => jobReplyTool({ jobId: 'whatever', message: 'x', taskType: 'not-a-task' }),
    /unknown taskType: not-a-task/
  )
})

test('job_reply inherits the parent taskType when omitted and lets it be overridden explicitly', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 'p', mode: 'read', sessionId: 'sess', taskType: 'recon', env })
  updateResult(parent.jobId, { status: 'succeeded' }, env)

  let captured = null
  const fakeStartJob = (args) => {
    captured = args
    return { job: { jobId: 'r', status: 'running', errorKind: null } }
  }

  await jobReplyTool({ jobId: parent.jobId, message: 'go', startJobFn: fakeStartJob })
  assert.equal(captured.taskType, 'recon')

  await jobReplyTool({ jobId: parent.jobId, message: 'go', taskType: 'triage', startJobFn: fakeStartJob })
  assert.equal(captured.taskType, 'triage')
})

test('job_reply reports turnDepth = parent + 1 and warns once the conversation is deep', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)
  const fakeStartJob = () => ({ job: { jobId: 'r', status: 'running', errorKind: null } })

  const shallow = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 'p', mode: 'read', sessionId: 's1', env })
  updateResult(shallow.jobId, { status: 'succeeded' }, env)
  const first = await jobReplyTool({ jobId: shallow.jobId, message: 'go', startJobFn: fakeStartJob })
  assert.equal(first.turnDepth, 1)
  assert.equal(first.warning, null)

  const deep = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 'p', mode: 'read', sessionId: 's2', turnDepth: 4, env })
  updateResult(deep.jobId, { status: 'succeeded' }, env)
  const fifth = await jobReplyTool({ jobId: deep.jobId, message: 'go', startJobFn: fakeStartJob })
  assert.equal(fifth.turnDepth, 5)
  assert.equal(fifth.warning, 'conversation is 5 turns deep; consider a fresh delegate with a short summary')
})

test('job_result adds tail, totalLines and tailTruncated without changing the head fields', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { responsePath } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobResultTool } = await fresh(home)

  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', env })

  fs.writeFileSync(responsePath(job.jobId, env), ['a', 'b', 'c'].join('\n'), 'utf8')
  const short = jobResultTool({ jobId: job.jobId, maxLines: 20, tailLines: 10 })
  assert.equal(short.text, 'a\nb\nc')
  assert.equal(short.totalLines, 3)
  assert.equal(short.tail, '')
  assert.equal(short.tailTruncated, false)

  fs.writeFileSync(responsePath(job.jobId, env), Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n'), 'utf8')
  const long = jobResultTool({ jobId: job.jobId, maxLines: 20, tailLines: 10 })
  assert.equal(long.totalLines, 40)
  assert.equal(long.text, Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n'))
  assert.equal(long.tail, Array.from({ length: 10 }, (_, i) => `L${30 + i}`).join('\n'))
  assert.equal(long.tailTruncated, true)
})

test('job_reply lets mode/title/timeoutS be overridden explicitly (e.g. switching read -> write for the approved-plan turn)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 'plan', mode: 'read', sessionId: 'sess-parent', env })
  updateResult(parent.jobId, { status: 'succeeded' }, env)

  let capturedArgs = null
  const fakeStartJob = (args) => {
    capturedArgs = args
    return { job: { jobId: 'reply-job-2', status: 'running', errorKind: null } }
  }

  await jobReplyTool({ jobId: parent.jobId, message: 'execute the approved plan', mode: 'write', title: 'explicit title', timeoutS: 900, startJobFn: fakeStartJob })

  assert.equal(capturedArgs.mode, 'write')
  assert.equal(capturedArgs.title, 'explicit title')
  assert.equal(capturedArgs.timeoutS, 900)
})

