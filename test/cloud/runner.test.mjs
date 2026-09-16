import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startRemoteJob, finishRemoteJob } from '../../src/cloud/runner.mjs'
import { createJob, readResult, updateResult, responsePath } from '../../src/jobstore.mjs'
import * as julesAdapter from '../../src/cloud/jules/adapter.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-runner-'))
}

/** Wraps a real jobstore fn so calls can be inspected without faking persistence. */
function spy(fn) {
  const calls = []
  const wrapped = (...args) => {
    calls.push(args)
    return fn(...args)
  }
  wrapped.calls = calls
  return wrapped
}

test('missing JULES_API_KEY finishes the job immediately as failed(auth), without ever calling createSession', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  let createSessionCalls = 0
  const client = {
    createSession: async () => {
      createSessionCalls++
      return {}
    },
  }

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter })
  assert.equal(job.status, 'failed')
  assert.equal(job.errorKind, 'auth')
  assert.match(job.error, /JULES_API_KEY/)

  await done
  assert.equal(createSessionCalls, 0)
  assert.equal(readResult(job.jobId, env).status, 'failed')
})

test('source inference failure (no explicit source, cwd is not a GitHub repo) fails the job as source_not_found', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const inferSourceFn = async () => {
    throw new Error("no git remote 'origin' in /repo")
  }
  const client = { createSession: async () => ({}) }

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', env, client, adapter: julesAdapter, inferSourceFn })
  await done

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'source_not_found')
  assert.match(result.error, /no git remote/)
})

test('a 429 from createSession fails the job as quota', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const apiError = Object.assign(new Error('Jules API responded 429'), { status: 429 })
  const client = {
    createSession: async () => {
      throw apiError
    },
  }

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter })
  await done

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'quota')
})

test('a 401/403 from createSession fails the job as auth', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'bad-key' }
  const apiError = Object.assign(new Error('Jules API responded 401'), { status: 401 })
  const client = {
    createSession: async () => {
      throw apiError
    },
  }

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter })
  await done

  assert.equal(readResult(job.jobId, env).errorKind, 'auth')
})

test('any other createSession failure falls back to crash', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const apiError = Object.assign(new Error('Jules API responded 500'), { status: 500 })
  const client = {
    createSession: async () => {
      throw apiError
    },
  }

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter })
  await done

  assert.equal(readResult(job.jobId, env).errorKind, 'crash')
})

test('a successful createSession writes the remote block, flips status to running before polling, and forwards the sessionId/apiKey to pollFn', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const session = { name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS', url: 'https://jules.google.com/session/sess-1' }
  const client = { createSession: async () => session }
  let pollArgs = null
  const pollFn = async (args) => {
    pollArgs = args
    return { outcome: 'completed', state: 'COMPLETED', summary: { lines: [], prUrl: null, changeSet: null, lastAgentMessage: null, completed: true, failed: false, failureMessage: null }, session, apiError: null }
  }
  const updateResultFn = spy(updateResult)

  const { job, done } = startRemoteJob({
    task: 't',
    cwd: '/repo',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    env,
    client,
    adapter: julesAdapter,
    pollFn,
    updateResultFn,
  })
  await done

  const runningCall = updateResultFn.calls.find(([, patch]) => patch.status === 'running')
  assert.ok(runningCall, 'expected an update to status:running before polling')
  assert.equal(runningCall[1].remote.provider, 'jules')
  assert.equal(runningCall[1].remote.sessionId, 'sess-1')
  assert.equal(runningCall[1].remote.sessionUrl, 'https://jules.google.com/session/sess-1')
  assert.equal(runningCall[1].remote.source, 'sources/github/acme/widgets')
  assert.equal(runningCall[1].remote.startingBranch, 'main')
  assert.equal(runningCall[1].remote.state, 'IN_PROGRESS')

  assert.equal(pollArgs.sessionId, 'sess-1')
  assert.equal(pollArgs.apiKey, 'key-1')
  assert.equal(pollArgs.jobId, job.jobId)

  assert.equal(readResult(job.jobId, env).status, 'succeeded')
})

test('an explicit source wins over cwd inference — inferSourceFn is never called', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  let inferCalled = false
  const inferSourceFn = async () => {
    inferCalled = true
    return { source: 'sources/github/other/repo', branch: 'dev' }
  }
  let capturedArgs = null
  const client = {
    createSession: async (args) => {
      capturedArgs = args
      return { name: 'sessions/s1', id: 's1', state: 'QUEUED' }
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, inferSourceFn, pollFn })
  await done

  assert.equal(inferCalled, false)
  assert.equal(capturedArgs.source, 'sources/github/acme/widgets')
})

test('when source is inferred and startingBranch is omitted, the inferred branch (possibly null) is used', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const inferSourceFn = async () => ({ source: 'sources/github/acme/widgets', branch: 'feature-x' })
  let capturedArgs = null
  const client = {
    createSession: async (args) => {
      capturedArgs = args
      return { name: 'sessions/s1', id: 's1', state: 'QUEUED' }
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { done } = startRemoteJob({ task: 't', cwd: '/repo', env, client, adapter: julesAdapter, inferSourceFn, pollFn })
  await done

  assert.equal(capturedArgs.source, 'sources/github/acme/widgets')
  assert.equal(capturedArgs.startingBranch, 'feature-x')
})

test('a completed outcome writes response.txt via adapter.buildResponseText and persists remote.state/prUrl', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS' }) }
  const finalSession = { name: 'sessions/sess-1', id: 'sess-1', state: 'COMPLETED', url: 'https://jules.google.com/session/sess-1' }
  const summary = { lines: [], prUrl: 'https://github.com/acme/widgets/pull/7', changeSet: null, lastAgentMessage: 'All done', completed: true, failed: false, failureMessage: null }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary, session: finalSession, apiError: null })

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.remote.state, 'COMPLETED')
  assert.equal(result.remote.prUrl, 'https://github.com/acme/widgets/pull/7')
  const text = fs.readFileSync(responsePath(job.jobId, env), 'utf8')
  assert.match(text, /All done/)
  assert.match(text, /pull\/7/)
})

test('a failed outcome (session FAILED) maps through adapter.classifyError to errorKind remote_failed', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS' }) }
  const finalSession = { name: 'sessions/sess-1', id: 'sess-1', state: 'FAILED' }
  const summary = { lines: [], prUrl: null, changeSet: null, lastAgentMessage: null, completed: false, failed: true, failureMessage: 'Tests failed after 3 attempts' }
  const pollFn = async () => ({ outcome: 'failed', state: 'FAILED', summary, session: finalSession, apiError: null })

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'remote_failed')
  assert.match(result.error, /Tests failed/)
})

test('a timeout outcome maps to errorKind timeout via adapter.classifyError({timedOut:true})', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS' }) }
  const pollFn = async () => ({ outcome: 'timeout', state: null, summary: null, session: null, apiError: null })

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  assert.equal(readResult(job.jobId, env).errorKind, 'timeout')
})

test('a rejected pollFn finishes the job as crash instead of leaving it running forever', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS' }) }
  const pollFn = async () => {
    throw new Error('boom')
  }

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'crash')
})

test('the job record is created with mode:"write" and the effective timeout drives pollFn.timeoutMs', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS' }) }
  let pollArgs = null
  const pollFn = async (args) => {
    pollArgs = args
    return { outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null }
  }

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', timeoutS: 1234, env, client, adapter: julesAdapter, pollFn })
  assert.equal(job.mode, 'write')
  assert.equal(job.timeoutS, 1234)
  await done
  assert.equal(pollArgs.timeoutMs, 1234 * 1000)
})

test('learnings are injected on a root turn (turnDepth 0) but skipped for a deeper turn', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/s', id: 's', state: 'QUEUED' }) }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })
  let selectCalls = 0
  const selectLearningsFn = () => {
    selectCalls++
    return [{ id: 'l-1', text: 'watch out' }]
  }
  const augmentTaskFn = (task, learnings) => (learnings.length ? { task: `NOTE\n\n${task}`, learningIds: ['l-1'] } : { task, learningIds: [] })

  const root = startRemoteJob({ task: 'do it', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn, selectLearningsFn, augmentTaskFn })
  await root.done
  assert.equal(selectCalls, 1)
  assert.deepEqual(readResult(root.job.jobId, env).learningIds, ['l-1'])

  const reply = startRemoteJob({ task: 'follow up', cwd: '/repo', source: 'sources/github/acme/widgets', turnDepth: 1, env, client, adapter: julesAdapter, pollFn, selectLearningsFn, augmentTaskFn })
  await reply.done
  assert.equal(selectCalls, 1, 'learnings must not be selected again for a deeper turn')
  assert.deepEqual(readResult(reply.job.jobId, env).learningIds, [])
})

test('startRemoteJob never touches the local write-mode gate, lock, or read-mode snapshot machinery', async () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../src/cloud/runner.mjs', import.meta.url)), 'utf8')
  for (const forbidden of ['checkWriteAllowed', 'acquireWriteLock', 'releaseWriteLock', 'takeSnapshot', 'diffSnapshots']) {
    assert.ok(!source.includes(forbidden), `runner.mjs must never reference ${forbidden} — a remote Jules session edits a GitHub branch, never this process's cwd`)
  }
})

test('finishRemoteJob bails out when the record is already canceled — cancelJob already finalized it and the remote session keeps running', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', env })
  updateResult(job.jobId, { status: 'canceled', errorKind: 'canceled_by_user' }, env)

  finishRemoteJob({ jobId: job.jobId, outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null, adapter: julesAdapter, env })

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'canceled')
  assert.equal(fs.existsSync(responsePath(job.jobId, env)), false)
})
