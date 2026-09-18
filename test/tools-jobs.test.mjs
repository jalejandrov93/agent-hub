import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createJob } from '../src/jobstore.mjs'
import { NO_KEY_MESSAGE } from '../src/cloud/credentials.mjs'

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

test('job_reply for a jules parent calls client.sendMessage (default action) and spawns nothing, keeping the same jobId', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'jules task', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-1', state: 'IN_PROGRESS' } }, env)

  let startJobCalls = 0
  const startJobFn = () => {
    startJobCalls++
    return { job: { jobId: 'should-not-happen', status: 'running', errorKind: null } }
  }
  let sendMessageArgs = null
  const client = {
    sendMessage: async (args) => {
      sendMessageArgs = args
      return {}
    },
    approvePlan: async () => {
      throw new Error('must not be called')
    },
  }

  const result = await jobReplyTool({ jobId: parent.jobId, message: 'please also add a changelog entry', startJobFn, client, env })

  assert.equal(startJobCalls, 0, 'a jules reply must never spawn a new local job')
  assert.equal(sendMessageArgs.sessionId, 'sess-1')
  assert.equal(sendMessageArgs.prompt, 'please also add a changelog entry')
  assert.equal(sendMessageArgs.apiKey, 'key-env')
  assert.equal(result.jobId, parent.jobId)
  assert.equal(result.status, 'running')
  assert.equal(result.errorKind, null)
})

// The real failure: keys now live in accounts.json and there is no
// JULES_API_KEY in the environment, but julesReply read env only and sent the
// request unkeyed — "Jules API responded 401 on /sessions/<id>:sendMessage".
test('job_reply on a jules job uses the key of the account that started it, with no JULES_API_KEY in env', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { createAccount } = await import('../src/accounts.mjs?t=' + Date.now())
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', accountId: account.id, sessionId: 'sess-acct' } }, env)

  let sendMessageArgs = null
  const client = {
    sendMessage: async (args) => {
      sendMessageArgs = args
      return {}
    },
  }

  const result = await jobReplyTool({ jobId: parent.jobId, message: 'keep going', client, env })

  assert.equal(sendMessageArgs.apiKey, 'key-aaa')
  assert.equal(sendMessageArgs.sessionId, 'sess-acct')
  assert.equal(result.errorKind, null)
})

test('job_reply on a jules job with no key anywhere returns auth and never calls the client', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-nokey' } }, env)

  let called = false
  const client = {
    sendMessage: async () => {
      called = true
    },
    approvePlan: async () => {
      called = true
    },
  }

  const result = await jobReplyTool({ jobId: parent.jobId, message: 'go', client, env })

  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'auth')
  assert.equal(result.error, NO_KEY_MESSAGE)
  assert.equal(called, false, 'never send a request without a key')
})

test('job_reply for a jules parent defaults to approve_plan when remote.state is AWAITING_PLAN_APPROVAL and no message is given', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-2', state: 'AWAITING_PLAN_APPROVAL' } }, env)

  let approveCalled = false
  const client = {
    sendMessage: async () => {
      throw new Error('must not be called')
    },
    approvePlan: async (args) => {
      approveCalled = true
      assert.equal(args.sessionId, 'sess-2')
    },
  }

  const result = await jobReplyTool({ jobId: parent.jobId, client, env })
  assert.equal(approveCalled, true)
  assert.equal(result.errorKind, null)
})

test('job_reply for a jules parent honors an explicit action override', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-3', state: 'AWAITING_PLAN_APPROVAL' } }, env)

  let approveCalled = false
  let sendCalled = false
  const client = {
    sendMessage: async () => {
      sendCalled = true
    },
    approvePlan: async () => {
      approveCalled = true
    },
  }

  // Even though remote.state is AWAITING_PLAN_APPROVAL, an explicit action wins.
  await jobReplyTool({ jobId: parent.jobId, message: 'hold on, one more thing', action: 'message', client, env })
  assert.equal(sendCalled, true)
  assert.equal(approveCalled, false)
})

test('job_reply accepts a RUNNING jules parent (not just a terminal one) — that is exactly when a reply is useful', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-4' } }, env)

  const client = { sendMessage: async () => ({}), approvePlan: async () => ({}) }
  const result = await jobReplyTool({ jobId: parent.jobId, message: 'go', client, env })
  assert.notEqual(result.errorKind, 'not_terminal')
})

test('job_reply rejects a jules parent that is neither running nor terminal (e.g. still queued)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  // status stays 'queued'

  const result = await jobReplyTool({ jobId: parent.jobId, message: 'go', env })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'not_terminal')
})

test('job_reply rejects a jules parent with no remote.sessionId', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running' }, env) // no remote block at all

  const result = await jobReplyTool({ jobId: parent.jobId, message: 'go', env })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'no_session')
})

test('job_reply reports a jules client failure as errorKind crash (any other status), carrying the error message through', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-5' } }, env)

  const client = {
    sendMessage: async () => {
      throw Object.assign(new Error('Jules API responded 500'), { status: 500 })
    },
  }
  const result = await jobReplyTool({ jobId: parent.jobId, message: 'go', client, env })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'crash')
  assert.match(result.error, /500/)
})

test('job_reply maps a 429 jules client failure to errorKind quota, carrying the error message through', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-6' } }, env)

  const client = {
    sendMessage: async () => {
      throw Object.assign(new Error('Jules API responded 429'), { status: 429 })
    },
  }
  const result = await jobReplyTool({ jobId: parent.jobId, message: 'go', client, env })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'quota')
  assert.match(result.error, /429/)
})

test('job_reply maps a 401/403 jules client failure to errorKind auth, carrying the error message through', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent401 = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent401.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-7' } }, env)
  const client401 = {
    sendMessage: async () => {
      throw Object.assign(new Error('Jules API responded 401'), { status: 401 })
    },
  }
  const result401 = await jobReplyTool({ jobId: parent401.jobId, message: 'go', client: client401, env })
  assert.equal(result401.errorKind, 'auth')
  assert.match(result401.error, /401/)

  const parent403 = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent403.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-8' } }, env)
  const client403 = {
    sendMessage: async () => {
      throw Object.assign(new Error('Jules API responded 403'), { status: 403 })
    },
  }
  const result403 = await jobReplyTool({ jobId: parent403.jobId, message: 'go', client: client403, env })
  assert.equal(result403.errorKind, 'auth')
  assert.match(result403.error, /403/)
})

test('job_reply rejects a jules "message" action with no message text, without ever calling client.sendMessage', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-9' } }, env)

  let sendCalled = false
  const client = {
    sendMessage: async () => {
      sendCalled = true
    },
  }

  const missing = await jobReplyTool({ jobId: parent.jobId, client, env })
  assert.equal(missing.status, 'failed')
  assert.equal(missing.errorKind, 'invalid')
  assert.match(missing.error, /message text or action:"approve_plan"/)

  const blank = await jobReplyTool({ jobId: parent.jobId, message: '   ', client, env })
  assert.equal(blank.status, 'failed')
  assert.equal(blank.errorKind, 'invalid')

  assert.equal(sendCalled, false)
})

test('job_reply still allows action:"approve_plan" with no message text at all', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 'p', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-10' } }, env)

  let approveCalled = false
  const client = { approvePlan: async () => { approveCalled = true } }

  const result = await jobReplyTool({ jobId: parent.jobId, action: 'approve_plan', client, env })
  assert.equal(approveCalled, true)
  assert.equal(result.errorKind, null)
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

test('job_reply rejects a missing message for an agy parent instead of spawning with an undefined prompt', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 'p', mode: 'read', sessionId: 'sess-agy', env })
  updateResult(parent.jobId, { status: 'succeeded' }, env)

  let startJobCalls = 0
  const startJobFn = () => {
    startJobCalls++
    return { job: { jobId: 'r', status: 'running', errorKind: null } }
  }

  const missing = await jobReplyTool({ jobId: parent.jobId, startJobFn })
  assert.equal(missing.status, 'failed')
  assert.equal(missing.errorKind, 'invalid')
  assert.match(missing.error, /requires message text/)

  const blank = await jobReplyTool({ jobId: parent.jobId, message: '   ', startJobFn })
  assert.equal(blank.status, 'failed')
  assert.equal(blank.errorKind, 'invalid')

  assert.equal(startJobCalls, 0, 'a message-less reply must never spawn a local CLI')
})

test('job_reply rejects a missing message for an opencode parent instead of spawning with an undefined prompt', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'opencode', model: 'x', task: 't', cwd: '/tmp', title: 'p', mode: 'read', sessionId: 'sess-oc', env })
  updateResult(parent.jobId, { status: 'succeeded' }, env)

  let startJobCalls = 0
  const startJobFn = () => {
    startJobCalls++
    return { job: { jobId: 'r', status: 'running', errorKind: null } }
  }

  const missing = await jobReplyTool({ jobId: parent.jobId, startJobFn })
  assert.equal(missing.status, 'failed')
  assert.equal(missing.errorKind, 'invalid')
  assert.match(missing.error, /requires message text/)

  const blank = await jobReplyTool({ jobId: parent.jobId, message: '   ', startJobFn })
  assert.equal(blank.status, 'failed')
  assert.equal(blank.errorKind, 'invalid')

  assert.equal(startJobCalls, 0, 'a message-less reply must never spawn a local CLI')
})


test('job_wait returns done immediately on a terminal job', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { jobWaitTool } = await fresh(home)
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())

  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', env })
  updateResult(job.jobId, { status: 'succeeded' }, env)

  const res = await jobWaitTool({ jobId: job.jobId, timeoutS: 5 })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.done, true)
  assert.equal(res.waiting, false)
  assert.equal(res.timedOut, false)
})

test('job_wait returns done+waiting with attention fields when the remote session waits for interaction', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { jobWaitTool } = await fresh(home)
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now() + 1)

  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: null, title: 't', mode: 'write', env })
  updateResult(job.jobId, { status: 'running', remote_state: 'AWAITING_USER_FEEDBACK', remote: { provider: 'jules', sessionId: 's1', state: 'AWAITING_USER_FEEDBACK' } }, env)

  const res = await jobWaitTool({ jobId: job.jobId, timeoutS: 5 })
  assert.equal(res.status, 'running')
  assert.equal(res.done, true)
  assert.equal(res.waiting, true)
  assert.equal(res.timedOut, false)
  assert.equal(res.attentionRequired, true)
  assert.equal(res.attentionReason, 'user_feedback')
  assert.equal(res.recommendedAction, 'send_message')
})

test('job_wait returns timedOut when the budget elapses on a still-working job', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { jobWaitTool } = await fresh(home)
  const { updateResult } = await import('../src/jobstore.mjs?t=' + Date.now() + 2)

  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', env })
  updateResult(job.jobId, { status: 'running' }, env)

  const res = await jobWaitTool({ jobId: job.jobId, timeoutS: 1 })
  assert.equal(res.status, 'running')
  assert.equal(res.done, false)
  assert.equal(res.waiting, false)
  assert.equal(res.timedOut, true)
})

test('job_reply on a jules parent shares bookkeeping with jules_interact (split counters, no turnDepth bump)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, JULES_API_KEY: 'key-env' }
  const { updateResult, readResult } = await import('../src/jobstore.mjs?t=' + Date.now() + 100)
  const { jobReplyTool } = await fresh(home)

  const parent = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', env })
  updateResult(parent.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-9', state: 'AWAITING_USER_FEEDBACK' } }, env)

  const client = { sendMessage: async () => ({}), approvePlan: async () => ({}) }
  const result = await jobReplyTool({ jobId: parent.jobId, message: 'go on', client, env })
  assert.equal(result.errorKind, null)

  const record = readResult(parent.jobId, env)
  assert.equal(record.remote.interventionCount, 1)
  assert.equal(record.remote.autoReplyCount, 1)
  assert.equal(record.remote.planApprovalCount ?? 0, 0)
  assert.equal(record.turnDepth, 0, 'a jules reply must not consume conversation depth')
})
