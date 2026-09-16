import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { checkRemoteSession } from '../../src/cloud/check.mjs'
import { createAccount } from '../../src/accounts.mjs'
import * as julesAdapter from '../../src/cloud/jules/adapter.mjs'

// Every env handed to code under test gets its own throwaway AGENT_HUB_HOME.
// Without one, stateHome() falls back to the REAL ~/.local/share/agent-hub:
// these tests then read the user's actual accounts.json — real API keys — and
// passed only while that file happened not to exist.
const isolated = (env) => ({ AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-isolated-')), ...env })


function fakeClient({ session = {}, activities = [] } = {}) {
  const calls = { getSession: [], listActivities: [] }
  return {
    calls,
    getSession: async (args) => {
      calls.getSession.push(args)
      return session
    },
    listActivities: async (args) => {
      calls.listActivities.push(args)
      return { activities }
    },
  }
}

/**
 * A client whose listActivities answers from a fixed sequence of pages, so a
 * test can hand back a nextPageToken and prove the caller follows it.
 */
function pagedClient({ session = {}, pages = [] } = {}) {
  const calls = { getSession: [], listActivities: [] }
  let index = 0
  return {
    calls,
    getSession: async (args) => {
      calls.getSession.push(args)
      return session
    },
    listActivities: async (args) => {
      calls.listActivities.push(args)
      const page = pages[Math.min(index, pages.length - 1)]
      index++
      return page
    },
  }
}

/** An in-memory jobstore: readResult/updateResult without touching disk. */
function memoryStore(record) {
  const updates = []
  let current = record
  return {
    updates,
    readResultFn: () => current,
    updateResultFn: (jobId, patch) => {
      updates.push(patch)
      current = { ...current, ...patch, remote: patch.remote ?? current.remote }
    },
    get record() {
      return current
    },
  }
}

function completedSession(overrides = {}) {
  return {
    name: 'sessions/sess-1',
    id: 'sess-1',
    state: 'COMPLETED',
    url: 'https://jules.google.com/session/sess-1',
    outputs: [{ pullRequest: { url: 'https://github.com/acme/widgets/pull/42', headRef: 'jules/fix-paginate' } }],
    ...overrides,
  }
}

test('checkRemoteSession throws a clear error naming JULES_API_KEY when it is missing', async () => {
  await assert.rejects(
    () => checkRemoteSession({ sessionId: 'sess-1', env: isolated({}), client: fakeClient(), adapter: julesAdapter }),
    /JULES_API_KEY/
  )
})

test('checkRemoteSession throws when neither a jobId nor a sessionId is given', async () => {
  await assert.rejects(
    () => checkRemoteSession({ env: isolated({ JULES_API_KEY: 'k' }), client: fakeClient(), adapter: julesAdapter }),
    /jobId or a sessionId/
  )
})

test('checkRemoteSession throws when the named job has no recorded Jules session', async () => {
  const store = memoryStore({ jobId: 'j1', status: 'running', remote: { provider: 'jules' } })
  await assert.rejects(
    () =>
      checkRemoteSession({
        jobId: 'j1',
        env: isolated({ JULES_API_KEY: 'k' }),
        client: fakeClient(),
        adapter: julesAdapter,
        readResultFn: store.readResultFn,
        updateResultFn: store.updateResultFn,
      }),
    /no .*session/i
  )
})

test('a bare sessionId does ONE getSession and ONE listActivities, maps the fields and never touches the job store', async () => {
  const client = fakeClient({
    session: completedSession(),
    activities: [{ agentMessaged: { message: 'All done' } }],
  })
  let updates = 0
  const result = await checkRemoteSession({
    sessionId: 'sess-1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    listJobsFn: () => [],
    updateResultFn: () => {
      updates++
    },
  })

  assert.equal(client.calls.getSession.length, 1)
  assert.equal(client.calls.listActivities.length, 1)
  assert.deepEqual(result, {
    jobId: null,
    sessionId: 'sess-1',
    state: 'COMPLETED',
    prUrl: 'https://github.com/acme/widgets/pull/42',
    branch: 'jules/fix-paginate',
    sessionUrl: 'https://jules.google.com/session/sess-1',
    lastMessage: 'All done',
    finalized: false,
    recovered: false,
    terminal: true,
  })
  assert.equal(updates, 0)
})

test('a bare sessionId resolves the local job by matching remote.sessionId and finalizes it', async () => {
  const client = fakeClient({ session: completedSession(), activities: [] })
  const store = memoryStore({
    jobId: 'j-local',
    status: 'running',
    remote: { provider: 'jules', sessionId: 'sess-1', source: 'sources/github/acme/widgets' },
  })
  const finishCalls = []
  const result = await checkRemoteSession({
    sessionId: 'sess-1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    listJobsFn: () => [
      { jobId: 'j-old', status: 'succeeded', remote: { provider: 'jules', sessionId: 'other' } },
      { jobId: 'j-local', status: 'running', remote: { provider: 'jules', sessionId: 'sess-1' } },
    ],
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    finishRemoteJobFn: (args) => finishCalls.push(args),
  })

  assert.equal(result.jobId, 'j-local')
  assert.equal(result.finalized, true)
  assert.equal(finishCalls.length, 1)
  assert.equal(finishCalls[0].jobId, 'j-local')
  assert.equal(finishCalls[0].outcome, 'completed')
  assert.equal(finishCalls[0].state, 'COMPLETED')
})

test('with a jobId, checkRemoteSession merges the fresh state/prUrl/branch into the remote block and keeps unrelated fields', async () => {
  const client = fakeClient({
    session: completedSession({ state: 'IN_PROGRESS' }),
    activities: [],
  })
  const store = memoryStore({
    jobId: 'j1',
    status: 'running',
    remote: { provider: 'jules', sessionId: 'sess-1', source: 'sources/github/acme/widgets', startingBranch: 'main', activityCursor: 'tok' },
  })
  const result = await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
  })

  assert.equal(result.jobId, 'j1')
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.state, 'IN_PROGRESS')
  assert.equal(result.terminal, false)
  assert.equal(result.finalized, false)

  assert.equal(store.record.remote.state, 'IN_PROGRESS')
  assert.equal(store.record.remote.prUrl, 'https://github.com/acme/widgets/pull/42')
  assert.equal(store.record.remote.branch, 'jules/fix-paginate')
  assert.equal(store.record.remote.source, 'sources/github/acme/widgets')
  assert.equal(store.record.remote.startingBranch, 'main')
  assert.equal(store.record.remote.activityCursor, 'tok')
})

test('with a jobId, a known branch or prUrl is never overwritten with null', async () => {
  const client = fakeClient({ session: { state: 'IN_PROGRESS' }, activities: [] })
  const store = memoryStore({
    jobId: 'j1',
    status: 'running',
    remote: { provider: 'jules', sessionId: 'sess-1', branch: 'jules/known', prUrl: 'https://github.com/acme/widgets/pull/1' },
  })
  await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
  })

  assert.equal(store.record.remote.branch, 'jules/known')
  assert.equal(store.record.remote.prUrl, 'https://github.com/acme/widgets/pull/1')
})

test('a terminal session on a still-running job is finalized through finishRemoteJob', async () => {
  const client = fakeClient({ session: completedSession(), activities: [] })
  const store = memoryStore({ jobId: 'j1', status: 'running', remote: { provider: 'jules', sessionId: 'sess-1' } })
  const finishCalls = []
  const result = await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    appendEventFn: () => {},
    finishRemoteJobFn: (args) => finishCalls.push(args),
  })

  assert.equal(result.finalized, true)
  assert.equal(result.terminal, true)
  assert.equal(finishCalls.length, 1)
  assert.equal(finishCalls[0].jobId, 'j1')
  assert.equal(finishCalls[0].outcome, 'completed')
  assert.equal(finishCalls[0].state, 'COMPLETED')
  assert.equal(finishCalls[0].adapter, julesAdapter)
})

test('a terminal FAILED session finalizes the job with outcome failed', async () => {
  const client = fakeClient({ session: { state: 'FAILED', id: 'sess-1' }, activities: [] })
  const store = memoryStore({ jobId: 'j1', status: 'running', remote: { provider: 'jules', sessionId: 'sess-1' } })
  const finishCalls = []
  await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    finishRemoteJobFn: (args) => finishCalls.push(args),
  })

  assert.equal(finishCalls.length, 1)
  assert.equal(finishCalls[0].outcome, 'failed')
  assert.equal(finishCalls[0].state, 'FAILED')
})

test('a terminal session whose local job already finished is not finalized again', async () => {
  const client = fakeClient({ session: completedSession(), activities: [] })
  const store = memoryStore({ jobId: 'j1', status: 'succeeded', remote: { provider: 'jules', sessionId: 'sess-1' } })
  const finishCalls = []
  const result = await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    finishRemoteJobFn: (args) => finishCalls.push(args),
  })

  assert.equal(result.finalized, false)
  assert.equal(finishCalls.length, 0)
})

test('checkRemoteSession never throws on an odd or empty session shape', async () => {
  const client = fakeClient({ session: {}, activities: undefined })
  const result = await checkRemoteSession({
    sessionId: 'sess-odd',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    listJobsFn: () => [],
  })

  assert.deepEqual(result, {
    jobId: null,
    sessionId: 'sess-odd',
    state: 'UNKNOWN',
    prUrl: null,
    branch: null,
    sessionUrl: null,
    lastMessage: null,
    finalized: false,
    recovered: false,
    terminal: false,
  })
})

test('checkRemoteSession drains every activity page so lastMessage is the newest, not the oldest', async () => {
  const client = pagedClient({
    session: { state: 'COMPLETED', id: 'sess-1' },
    pages: [
      { activities: [{ agentMessaged: { message: 'first' } }], nextPageToken: 'page-2' },
      { activities: [{ agentMessaged: { message: 'last' } }] },
    ],
  })
  const result = await checkRemoteSession({
    sessionId: 'sess-1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    listJobsFn: () => [],
  })

  assert.equal(result.lastMessage, 'last')
  assert.equal(client.calls.listActivities.length, 2)
  assert.equal(client.calls.listActivities[1].pageToken, 'page-2')
})

test('checkRemoteSession stops after 10 pages when nextPageToken never changes', async () => {
  const client = pagedClient({
    session: { state: 'IN_PROGRESS' },
    pages: [{ activities: [{ agentMessaged: { message: 'tick' } }], nextPageToken: 'constant' }],
  })
  const result = await checkRemoteSession({
    sessionId: 'sess-1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    listJobsFn: () => [],
  })

  assert.equal(client.calls.listActivities.length, 10)
  assert.equal(result.lastMessage, 'tick')
})

test('checkRemoteSession forwards activityPageSize to listActivities', async () => {
  const client = fakeClient({ session: { state: 'IN_PROGRESS' } })
  await checkRemoteSession({
    sessionId: 'sess-1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client,
    adapter: julesAdapter,
    listJobsFn: () => [],
    activityPageSize: 25,
  })
  assert.equal(client.calls.listActivities[0].pageSize, 25)
  assert.equal(client.calls.listActivities[0].apiKey, 'k')
  assert.equal(client.calls.listActivities[0].sessionId, 'sess-1')
})

test('checkRemoteSession reads the key for the job\'s OWN remote.accountId, so a resumed session keeps its account', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-check-'))
  const env = { AGENT_HUB_HOME: home }
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)

  const client = fakeClient({ session: completedSession(), activities: [] })
  const store = memoryStore({
    jobId: 'j1',
    status: 'running',
    remote: { provider: 'jules', accountId: account.id, sessionId: 'sess-1' },
  })

  await checkRemoteSession({
    jobId: 'j1',
    env,
    client,
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    appendEventFn: () => {},
    finishRemoteJobFn: () => {},
  })

  assert.equal(client.calls.getSession[0].apiKey, 'key-aaa')
})

test('checkRemoteSession falls back to env.JULES_API_KEY for a job with no accountId', async () => {
  const client = fakeClient({ session: completedSession(), activities: [] })
  const store = memoryStore({ jobId: 'j1', status: 'running', remote: { provider: 'jules', sessionId: 'sess-1' } })

  await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'key-env' }),
    client,
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    appendEventFn: () => {},
    finishRemoteJobFn: () => {},
  })

  assert.equal(client.calls.getSession[0].apiKey, 'key-env')
})

// Observed for real: an older agent-hub install, whose reconcileOrphans did not
// know about remote jobs, marked three live Jules jobs failed/orphaned on its
// next startup. A remote job has no local process, so it can never truly be
// orphaned — and before this fix jules_check only finalized a job still
// 'running', so a misclassified job could never recover its pull request.
function orphanedJob() {
  return {
    jobId: 'j1',
    status: 'failed',
    errorKind: 'orphaned',
    error: 'process not found on startup reconcile',
    remote: { provider: 'jules', sessionId: 'sess-1' },
  }
}

test('checkRemoteSession recovers a remote job wrongly marked orphaned and finalizes it when the session completed', async () => {
  const store = memoryStore(orphanedJob())
  const finished = []
  const result = await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client: fakeClient({ session: completedSession(), activities: [] }),
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    appendEventFn: () => {},
    finishRemoteJobFn: (args) => finished.push(args),
  })

  assert.equal(result.recovered, true)
  assert.equal(result.finalized, true)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].outcome, 'completed')
  assert.equal(store.updates.some((p) => p.status === 'running' && p.errorKind === null), true)
})

test('checkRemoteSession reopens a wrongly orphaned remote job as running while its session is still in progress', async () => {
  const store = memoryStore(orphanedJob())
  const finished = []
  const result = await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client: fakeClient({ session: completedSession({ state: 'IN_PROGRESS', outputs: [] }), activities: [] }),
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    appendEventFn: () => {},
    finishRemoteJobFn: (args) => finished.push(args),
  })

  assert.equal(result.recovered, true)
  assert.equal(result.finalized, false)
  assert.equal(finished.length, 0)
  assert.equal(store.record.status, 'running')
  assert.equal(store.record.errorKind, null)
})

test('checkRemoteSession never reopens a remote job that failed for a real reason', async () => {
  const store = memoryStore({ ...orphanedJob(), errorKind: 'auth', error: 'JULES_API_KEY rejected' })
  const finished = []
  const result = await checkRemoteSession({
    jobId: 'j1',
    env: isolated({ JULES_API_KEY: 'k' }),
    client: fakeClient({ session: completedSession(), activities: [] }),
    adapter: julesAdapter,
    readResultFn: store.readResultFn,
    updateResultFn: store.updateResultFn,
    appendEventFn: () => {},
    finishRemoteJobFn: (args) => finished.push(args),
  })

  assert.equal(result.recovered, false)
  assert.equal(result.finalized, false)
  assert.equal(finished.length, 0)
  assert.equal(store.record.status, 'failed')
  assert.equal(store.record.errorKind, 'auth')
})
