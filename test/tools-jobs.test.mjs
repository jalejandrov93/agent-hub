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
