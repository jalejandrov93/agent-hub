import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startRemoteJob, finishRemoteJob, resumeRemoteJobs } from '../../src/cloud/runner.mjs'
import { createJob, readResult, updateResult, responsePath } from '../../src/jobstore.mjs'
import { createAccount, setPolicy, listAccounts } from '../../src/accounts.mjs'
import { refreshSources } from '../../src/cloud/sources.mjs'
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

/** Polls a predicate until true; fails loudly instead of hanging a test. */
async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitFor: condition was not met before the timeout')
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

test('a createSession response that already carries a pull request records remote.branch and remote.prUrl at start', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const session = {
    name: 'sessions/sess-1',
    id: 'sess-1',
    state: 'IN_PROGRESS',
    url: 'https://jules.google.com/session/sess-1',
    outputs: [{ pullRequest: { url: 'https://github.com/acme/widgets/pull/7', headRef: 'jules/fix-paginate' } }],
  }
  const client = { createSession: async () => session }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session, apiError: null })
  const updateResultFn = spy(updateResult)

  const { job, done } = startRemoteJob({
    task: 't',
    cwd: '/repo',
    source: 'sources/github/acme/widgets',
    env,
    client,
    adapter: julesAdapter,
    pollFn,
    updateResultFn,
  })
  await done

  const runningCall = updateResultFn.calls.find(([, patch]) => patch.status === 'running')
  assert.ok(runningCall, 'expected an update to status:running before polling')
  assert.equal(runningCall[1].remote.branch, 'jules/fix-paginate')
  assert.equal(runningCall[1].remote.prUrl, 'https://github.com/acme/widgets/pull/7')
  assert.equal(readResult(job.jobId, env).remote.branch, 'jules/fix-paginate')
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

// THE INVARIANT: a remote job becomes terminal only from the remote session's
// own state. Anything this process concludes on its own — a local deadline, a
// rejected key, a run of transient API errors, a crash in the poller — can
// stop the polling, but it can never make the job failed. Violating this
// failed three healthy Jules sessions on one day, three different ways
// (orphaned, auth, timeout), while every one kept running on Google's side.
async function startWith(pollFn) {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS' }) }
  const events = []
  const { job, done } = startRemoteJob({
    task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn,
    appendEventFn: (e) => events.push(e),
  })
  await done
  return { result: readResult(job.jobId, env), events }
}

function assertDetached({ result, events }, reason) {
  assert.equal(result.status, 'running')
  assert.equal(result.errorKind ?? null, null)
  assert.equal(result.remote.pollingStoppedReason, reason)
  assert.match(String(result.remote.pollingStoppedAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(events.some((e) => e.kind === 'job.failed'), false)
}

test('a local deadline stops polling but leaves the job running, because the session may still be working', async () => {
  const outcome = await startWith(async () => ({ outcome: 'timeout', state: null, summary: null, session: null, apiError: null }))
  assertDetached(outcome, 'local_deadline')
})

test('a rejected key during polling stops polling but does not fail a session that is still running', async () => {
  const apiError = Object.assign(new Error('Jules API responded 401'), { status: 401 })
  const outcome = await startWith(async () => ({ outcome: 'failed', state: null, summary: null, session: null, apiError }))
  assertDetached(outcome, 'auth')
})

test('an exhausted budget of transient API errors stops polling but does not fail the job', async () => {
  const apiError = Object.assign(new Error('Jules API responded 503'), { status: 503 })
  const outcome = await startWith(async () => ({ outcome: 'failed', state: null, summary: null, session: null, apiError }))
  assertDetached(outcome, 'api_errors')
})

test('a crash in the poller after the session exists stops polling but does not fail the job', async () => {
  const outcome = await startWith(async () => {
    throw new Error('boom')
  })
  assertDetached(outcome, 'poller_error')
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

test('a canceled job emits no contradicting job.failed event when the poll later errors', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const client = { createSession: async () => ({ name: 'sessions/sess-1', id: 'sess-1', state: 'IN_PROGRESS' }) }
  const events = []
  const appendEventFn = (event) => events.push(event)
  const jobRef = {}
  const pollFn = async () => {
    // job_cancel lands while the poll is in flight, then the poll errors.
    updateResult(jobRef.jobId, { status: 'canceled', errorKind: 'canceled_by_user' }, env)
    throw new Error('poll blew up after cancel')
  }

  const { job, done } = startRemoteJob({
    task: 't',
    cwd: '/repo',
    source: 'sources/github/acme/widgets',
    env,
    client,
    adapter: julesAdapter,
    pollFn,
    appendEventFn,
  })
  jobRef.jobId = job.jobId
  await done

  assert.equal(readResult(job.jobId, env).status, 'canceled')
  assert.equal(events.some((e) => e.kind === 'job.failed'), false)
})

// Observed for real: after a Claude Code restart, the MCP server had no key
// configured and this path marked three live Jules jobs failed(auth). A missing
// credential in THIS process says nothing about the session on Google's side,
// which kept running. Failing the job destroyed correct state; leaving it
// running lets jules_check finalize it as soon as a key is configured.
test('resumeRemoteJobs leaves a remote job running when no key is available, and never polls or fails it', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', env })
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-1', state: 'IN_PROGRESS' } }, env)

  let pollCalls = 0
  const pollFn = async () => {
    pollCalls++
    return {}
  }
  const events = []

  const res = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn, appendEventFn: (e) => events.push(e) })

  assert.deepEqual(res.unkeyed, [job.jobId])
  assert.deepEqual(res.failed, [])
  assert.deepEqual(res.resumed, [])
  assert.equal(pollCalls, 0)
  assert.equal(events.some((e) => e.kind === 'job.failed'), false)

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'running')
  assert.equal(result.errorKind ?? null, null)
})

test('resumeRemoteJobs, when the deadline already elapsed, still polls once and finalizes a COMPLETED session as succeeded with its prUrl', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', timeoutS: 10, env })
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-c', state: 'IN_PROGRESS' } }, env)

  const session = { name: 'sessions/sess-c', id: 'sess-c', state: 'COMPLETED', url: 'https://jules.google.com/session/sess-c' }
  const summary = { lines: [], prUrl: 'https://github.com/acme/widgets/pull/42', changeSet: null, lastAgentMessage: 'done', completed: true, failed: false, failureMessage: null }
  let pollArgs = null
  const pollFn = async (args) => {
    pollArgs = args
    return { outcome: 'completed', state: 'COMPLETED', summary, session, apiError: null }
  }

  const res = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn, nowFn: () => Date.now() + 20000, finalTickTimeoutMs: 1234 })

  assert.deepEqual(res.resumed, [job.jobId])
  await waitFor(() => readResult(job.jobId, env).status === 'succeeded')
  assert.equal(pollArgs.sessionId, 'sess-c')
  assert.equal(pollArgs.timeoutMs, 1234, 'the deadline-elapsed path must poll with the small finalTickTimeoutMs budget')

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.remote.state, 'COMPLETED')
  assert.equal(result.remote.prUrl, 'https://github.com/acme/widgets/pull/42')

  // The in-process guard must be released once the background finalize settles.
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-c', state: 'IN_PROGRESS' } }, env)
  const again = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn, nowFn: () => Date.now() + 20000 })
  assert.deepEqual(again.resumed, [job.jobId], 'the guard must be released after a completed finalize')
  await waitFor(() => readResult(job.jobId, env).status === 'succeeded')
})

// Observed for real: two Jules sessions created at 05:24 passed their 6-hour
// local deadline at 11:24 while working normally, and the next MCP startup
// failed both as timeout even though the final read showed them IN_PROGRESS.
test('resumeRemoteJobs, when the deadline already elapsed and the session is still IN_PROGRESS, leaves the job running with polling stopped', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', timeoutS: 10, env })
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-r', state: 'IN_PROGRESS' } }, env)

  let pollArgs = null
  const pollFn = async (args) => {
    pollArgs = args
    return { outcome: 'timeout', state: null, summary: null, session: null, apiError: null }
  }

  const res = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn, nowFn: () => Date.now() + 20000, finalTickTimeoutMs: 500 })

  assert.deepEqual(res.resumed, [job.jobId])
  await waitFor(() => readResult(job.jobId, env).remote?.pollingStoppedReason === 'local_deadline')
  assert.equal(pollArgs.timeoutMs, 500)

  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'running')
  assert.equal(result.errorKind ?? null, null)
  // Nothing says the session stopped, so its last known state stays live.
  assert.equal(result.remote.state, 'IN_PROGRESS')

  // The in-process guard must be released once the background work settles,
  // and a later resume that sees the session finish must finalize it for real.
  const again = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn: async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null }), nowFn: () => Date.now() + 20000 })
  assert.deepEqual(again.resumed, [job.jobId], 'the guard must be released after polling stops')
  await waitFor(() => readResult(job.jobId, env).status === 'succeeded')
})

test('resumeRemoteJobs starts a poll with the remaining deadline and hands the result to finishRemoteJob', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', timeoutS: 100, env })
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-3', state: 'IN_PROGRESS' } }, env)

  let pollArgs = null
  const pollFn = async (args) => {
    pollArgs = args
    return { outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null }
  }
  const res = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn })

  assert.deepEqual(res.resumed, [job.jobId])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pollArgs.sessionId, 'sess-3')
  assert.equal(pollArgs.apiKey, 'key-1')
  assert.ok(pollArgs.timeoutMs > 0 && pollArgs.timeoutMs <= 100000, `remaining timeout ${pollArgs.timeoutMs}`)
  assert.equal(readResult(job.jobId, env).status, 'succeeded')
})

test('resumeRemoteJobs never double-polls a job already being polled in this process', () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', timeoutS: 100, env })
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-4', state: 'IN_PROGRESS' } }, env)

  let pollCalls = 0
  const pollFn = () => {
    pollCalls++
    return new Promise(() => {})
  }

  const first = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn })
  const second = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn })

  assert.deepEqual(first.resumed, [job.jobId])
  assert.deepEqual(second.skipped, [job.jobId])
  assert.equal(pollCalls, 1)
})

test('resumeRemoteJobs ignores local running jobs and remote jobs that are not running', () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-1' }
  const local = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', env })
  updateResult(local.jobId, { status: 'running', pid: 123 }, env)
  const finished = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', env })
  updateResult(finished.jobId, { status: 'succeeded', remote: { provider: 'jules', sessionId: 'sess-5' } }, env)

  let pollCalls = 0
  const res = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn: async () => { pollCalls++; return {} } })
  assert.deepEqual(res.resumed, [])
  assert.deepEqual(res.failed, [])
  assert.deepEqual(res.skipped, [])
  assert.equal(pollCalls, 0)
})

// --- multi-account selection, env fallback and 429 failover ---

function accountsEnv() {
  return { AGENT_HUB_HOME: tmpHome() }
}

test('with no accounts configured, startRemoteJob falls back to env.JULES_API_KEY as the implicit account "env"', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-env' }
  let captured = null
  const client = {
    createSession: async (args) => {
      captured = args
      return { id: 's1', state: 'QUEUED' }
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  assert.equal(captured.apiKey, 'key-env')
  assert.equal(readResult(job.jobId, env).remote.accountId, 'env')
})

test('with accounts configured the job uses a stored account key and persists remote.accountId', async () => {
  const env = accountsEnv()
  const account = createAccount({ label: 'pro', apiKey: 'key-aaa' }, env)
  let captured = null
  const client = {
    createSession: async (args) => {
      captured = args
      return { id: 's1', state: 'QUEUED' }
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  assert.equal(captured.apiKey, 'key-aaa')
  const result = readResult(job.jobId, env)
  assert.equal(result.remote.accountId, account.id)
  assert.ok(listAccounts(env)[0].lastUsedAt, 'markAccountUsed must stamp the account that ran the job')
})

test('an explicit account id wins over the policy', async () => {
  const env = accountsEnv()
  createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  const b = createAccount({ label: 'b', apiKey: 'key-bbb' }, env)
  let captured = null
  const client = {
    createSession: async (args) => {
      captured = args
      return { id: 's1', state: 'QUEUED' }
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', account: b.id, env, client, adapter: julesAdapter, pollFn })
  await done

  assert.equal(captured.apiKey, 'key-bbb')
})

test('a 429 from createSession fails over to the next eligible account instead of failing the job', async () => {
  const env = accountsEnv()
  createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  const b = createAccount({ label: 'b', apiKey: 'key-bbb' }, env)
  setPolicy('priority', env)

  const tried = []
  const client = {
    createSession: async (args) => {
      tried.push(args.apiKey)
      if (args.apiKey === 'key-aaa') throw Object.assign(new Error('Jules API responded 429'), { status: 429 })
      return { id: 's1', state: 'QUEUED' }
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  assert.deepEqual(tried, ['key-aaa', 'key-bbb'], 'the exhausted account is retried with the next one')
  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.remote.accountId, b.id)
})

test('when every account 429s, the job fails with errorKind quota naming how many accounts were tried', async () => {
  const env = accountsEnv()
  createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  createAccount({ label: 'b', apiKey: 'key-bbb' }, env)
  createAccount({ label: 'c', apiKey: 'key-ccc' }, env)
  setPolicy('priority', env)

  let calls = 0
  const client = {
    createSession: async () => {
      calls++
      throw Object.assign(new Error('Jules API responded 429'), { status: 429 })
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn })
  await done

  const result = readResult(job.jobId, env)
  assert.equal(calls, 3, 'at most three accounts are tried in total')
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'quota')
  assert.match(result.error, /3 account/)
})

test('a non-429 createSession failure is not retried on another account', async () => {
  const env = accountsEnv()
  createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  createAccount({ label: 'b', apiKey: 'key-bbb' }, env)
  setPolicy('priority', env)

  let calls = 0
  const client = {
    createSession: async () => {
      calls++
      throw Object.assign(new Error('Jules API responded 401'), { status: 401 })
    },
  }
  const { job, done } = startRemoteJob({ task: 't', cwd: '/repo', source: 'sources/github/acme/widgets', env, client, adapter: julesAdapter, pollFn: async () => ({}) })
  await done

  assert.equal(calls, 1, 'an auth failure is the account\'s problem, not a quota failover trigger')
  assert.equal(readResult(job.jobId, env).errorKind, 'auth')
})

// --- stale sources cache recovery (source_unavailable on the first attempt) ---

test('a stale sources cache lacking the target source triggers one refresh, then selection succeeds', async () => {
  const env = accountsEnv()
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  // Cache is 'ok' but lists only another source — stale, exactly as pagination
  // stopping early (the bug T1 fixes) would leave it.
  await refreshSources({
    accountId: account.id,
    env,
    apiKey: 'key-aaa',
    client: { listSources: async () => ({ sources: [{ name: 'sources/github/acme/other' }] }) },
  })

  let refreshCalls = 0
  const refreshSourcesFn = async ({ accountId, apiKey }) => {
    refreshCalls++
    return refreshSources({
      accountId,
      env,
      apiKey,
      client: {
        listSources: async () => ({
          sources: [{ name: 'sources/github/acme/other' }, { name: 'sources/github/acme/widgets' }],
        }),
      },
    })
  }

  let captured = null
  const client = {
    createSession: async (args) => {
      captured = args
      return { id: 's1', state: 'QUEUED' }
    },
  }
  const pollFn = async () => ({ outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null })

  const { job, done } = startRemoteJob({
    task: 't',
    cwd: '/repo',
    source: 'sources/github/acme/widgets',
    env,
    client,
    adapter: julesAdapter,
    pollFn,
    refreshSourcesFn,
  })
  await done

  assert.equal(refreshCalls, 1, 'refresh runs exactly once for the stale-cache recovery')
  assert.equal(captured.apiKey, 'key-aaa')
  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.remote.accountId, account.id)
})

test('when refresh does not resolve a stale cache, delegation still fails with the existing message and refresh runs at most once', async () => {
  const env = accountsEnv()
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  await refreshSources({
    accountId: account.id,
    env,
    apiKey: 'key-aaa',
    client: { listSources: async () => ({ sources: [{ name: 'sources/github/acme/other' }] }) },
  })

  let refreshCalls = 0
  const refreshSourcesFn = async ({ accountId, apiKey }) => {
    refreshCalls++
    return refreshSources({
      accountId,
      env,
      apiKey,
      client: { listSources: async () => ({ sources: [{ name: 'sources/github/acme/other' }] }) },
    })
  }

  const client = {
    createSession: async () => {
      throw new Error('createSession must never be called with no eligible account')
    },
  }

  const { job, done } = startRemoteJob({
    task: 't',
    cwd: '/repo',
    source: 'sources/github/acme/widgets',
    env,
    client,
    adapter: julesAdapter,
    refreshSourcesFn,
  })
  await done

  assert.equal(refreshCalls, 1, 'refresh must not be retried once it has already run')
  const result = readResult(job.jobId, env)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'quota')
  assert.match(result.error, /no Jules account available: source_unavailable/)
})

test('resumeRemoteJobs polls a job with the key of its OWN remote.accountId, not the env key', async () => {
  const env = accountsEnv()
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', timeoutS: 100, env })
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', accountId: account.id, sessionId: 'sess-9', state: 'IN_PROGRESS' } }, env)

  let pollArgs = null
  const pollFn = async (args) => {
    pollArgs = args
    return { outcome: 'completed', state: 'COMPLETED', summary: {}, session: {}, apiError: null }
  }

  const res = resumeRemoteJobs({ env, client: {}, adapter: julesAdapter, pollFn })
  assert.deepEqual(res.resumed, [job.jobId])
  await waitFor(() => readResult(job.jobId, env).status === 'succeeded')
  assert.equal(pollArgs.apiKey, 'key-aaa')
})
