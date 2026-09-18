import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  BACKOFF_FACTOR,
  nextInterval,
  pollOnce,
  pollUntilTerminal,
} from '../../src/cloud/poller.mjs'
import { createJob, readResult, updateResult } from '../../src/jobstore.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-poller-'))
}

function makeAdapter({ terminal = [] } = {}) {
  return {
    isTerminalState: (state) => terminal.includes(state),
    summarizeActivities: (activities) => ({
      lines: activities.map((a) => a.text),
      prUrl: null,
      changeSet: null,
      lastAgentMessage: null,
      completed: activities.some((a) => a.done === true),
      failed: activities.some((a) => a.failed === true),
      failureMessage: activities.find((a) => a.failed)?.text ?? null,
    }),
    branchFromSession: (session) => session?.branch ?? null,
    prUrlFromSession: (session) => session?.prUrl ?? null,
  }
}

function fakeClientForPollOnce({ session = { state: 'RUNNING' }, pages = [] } = {}) {
  let i = 0
  const calls = { getSession: [], listActivities: [] }
  return {
    calls,
    getSession: async (args) => {
      calls.getSession.push(args)
      return session
    },
    listActivities: async (args) => {
      calls.listActivities.push(args)
      return pages[i++] ?? { activities: [], nextPageToken: '' }
    },
  }
}

function scriptedClient({ states, pages }) {
  let s = 0
  let p = 0
  const calls = { getSession: [], listActivities: [] }
  return {
    calls,
    getSession: async (args) => {
      calls.getSession.push(args)
      const state = states[Math.min(s, states.length - 1)]
      s++
      return { state }
    },
    listActivities: async (args) => {
      calls.listActivities.push(args)
      const page = pages[Math.min(p, pages.length - 1)]
      p++
      if (page instanceof Error) throw page
      return page
    },
  }
}

function apiError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

function fakeClock() {
  let now = 0
  const delays = []
  return {
    delays,
    nowFn: () => now,
    sleepFn: async (ms) => {
      delays.push(ms)
      now += ms
    },
    advance: (ms) => {
      now += ms
    },
  }
}

const runningRecord = () => ({ status: 'running', remote: {} })
const emptyPage = () => ({ activities: [], nextPageToken: '' })

// 1. nextInterval resets to min on new activity
test('nextInterval resets to minIntervalMs when new activity arrived', () => {
  const grown = nextInterval(11250, {
    sawNewActivity: true,
    minIntervalMs: MIN_INTERVAL_MS,
    maxIntervalMs: MAX_INTERVAL_MS,
    backoffFactor: BACKOFF_FACTOR,
  })
  assert.equal(grown, 5000)
  assert.equal(nextInterval(11250, { sawNewActivity: true }), MIN_INTERVAL_MS)
})

// 2. nextInterval growth sequence 5000 -> 7500 -> 11250
test('nextInterval grows 5000 -> 7500 -> 11250 with no activity', () => {
  const opts = {
    sawNewActivity: false,
    minIntervalMs: MIN_INTERVAL_MS,
    maxIntervalMs: MAX_INTERVAL_MS,
    backoffFactor: BACKOFF_FACTOR,
  }
  assert.equal(nextInterval(5000, opts), 7500)
  assert.equal(nextInterval(7500, opts), 11250)
})

// 3. nextInterval clamps at max
test('nextInterval clamps at maxIntervalMs', () => {
  const opts = {
    sawNewActivity: false,
    minIntervalMs: MIN_INTERVAL_MS,
    maxIntervalMs: MAX_INTERVAL_MS,
    backoffFactor: BACKOFF_FACTOR,
  }
  assert.equal(nextInterval(50000, opts), MAX_INTERVAL_MS)
  assert.equal(nextInterval(60000, opts), MAX_INTERVAL_MS)
})

// 4. pollOnce advances cursor to nextPageToken
test('pollOnce advances the cursor to the last nextPageToken seen', async () => {
  const client = fakeClientForPollOnce({
    pages: [
      { activities: [{ id: 'a1', text: 'one' }], nextPageToken: 'tok-1' },
      { activities: [], nextPageToken: '' },
    ],
  })
  const res = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: 'start',
    remote: {},
    client,
    adapter: makeAdapter(),
    appendStdoutFn: () => {},
    updateResultFn: () => {},
  })
  assert.equal(res.cursor, 'tok-1')
  assert.equal(client.calls.getSession.length, 1)
  assert.equal(client.calls.listActivities.length, 2)
  assert.equal(client.calls.listActivities[0].pageToken, 'start')
  assert.equal(client.calls.listActivities[1].pageToken, 'tok-1')
})

// 5. pollOnce paginates two pages, concatenates lines, ONE appendStdout call, sawNewActivity true
test('pollOnce paginates two pages into one appendStdout call and sets sawNewActivity', async () => {
  const client = fakeClientForPollOnce({
    pages: [
      { activities: [{ id: 'a1', text: 'one' }], nextPageToken: 't1' },
      { activities: [{ id: 'a2', text: 'two' }], nextPageToken: '' },
    ],
  })
  const appended = []
  const res = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter: makeAdapter(),
    appendStdoutFn: (jobId, chunk, env) => appended.push(chunk),
    updateResultFn: () => {},
  })
  assert.equal(res.sawNewActivity, true)
  assert.deepEqual(res.lines, ['one', 'two'])
  assert.equal(appended.length, 1)
  assert.equal(appended[0], 'one\ntwo\n')
})

// 6. pollOnce stops after 20 pages when nextPageToken never changes
test('pollOnce stops after 20 pages when nextPageToken never changes', async () => {
  let calls = 0
  const client = {
    getSession: async () => ({ state: 'RUNNING' }),
    listActivities: async () => {
      calls++
      return { activities: [{ id: 'a', text: 'x' }], nextPageToken: 'same' }
    },
  }
  const appended = []
  const res = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter: makeAdapter(),
    appendStdoutFn: (jobId, chunk) => appended.push(chunk),
    updateResultFn: () => {},
  })
  assert.equal(calls, 20)
  assert.equal(res.cursor, 'same')
  assert.equal(res.sawNewActivity, true)
  assert.equal(appended.length, 1)
  assert.equal(appended[0], Array(20).fill('x').join('\n') + '\n')
})

// 7. pollOnce merges the previous remote block instead of replacing it
test('pollOnce merges the previous remote block instead of replacing it', async () => {
  const client = fakeClientForPollOnce({ session: { state: 'RUNNING' }, pages: [emptyPage()] })
  const updates = []
  const env = { SENTINEL: true }
  await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: 'old-cursor',
    remote: { state: 'OLD', activityCursor: 'old-cursor', branch: 'jules/x', sessionId: 'rs', keep: 'me' },
    client,
    adapter: makeAdapter(),
    env,
    nowFn: () => 1700000000000,
    appendStdoutFn: () => {},
    updateResultFn: (jobId, patch, passedEnv) => updates.push({ jobId, patch, passedEnv }),
  })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].jobId, 'j1')
  assert.equal(updates[0].passedEnv, env)
  assert.equal(updates[0].patch.remote.keep, 'me')
  assert.equal(updates[0].patch.remote.branch, 'jules/x')
  assert.equal(updates[0].patch.remote.sessionId, 'rs')
  assert.equal(updates[0].patch.remote.state, 'RUNNING')
  assert.equal(updates[0].patch.remote.activityCursor, 'old-cursor')
  assert.equal(updates[0].patch.remote.lastPolledAt, new Date(1700000000000).toISOString())
})

test('pollOnce persists the branch and prUrl from the session when they become known', async () => {
  const client = fakeClientForPollOnce({
    session: { state: 'RUNNING', branch: 'jules/fix-paginate', prUrl: 'https://github.com/acme/widgets/pull/9' },
    pages: [emptyPage()],
  })
  let patch
  await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter: makeAdapter(),
    nowFn: () => 0,
    appendStdoutFn: () => {},
    updateResultFn: (jobId, p) => {
      patch = p
    },
  })
  assert.equal(patch.remote.branch, 'jules/fix-paginate')
  assert.equal(patch.remote.prUrl, 'https://github.com/acme/widgets/pull/9')
})

test('pollOnce takes the prUrl from the activity summary when the session does not carry it', async () => {
  const client = fakeClientForPollOnce({ session: { state: 'RUNNING' }, pages: [emptyPage()] })
  const adapter = {
    ...makeAdapter(),
    summarizeActivities: () => ({
      lines: [],
      prUrl: 'https://github.com/acme/widgets/pull/11',
      changeSet: null,
      lastAgentMessage: null,
      completed: false,
      failed: false,
      failureMessage: null,
    }),
  }
  let patch
  await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter,
    nowFn: () => 0,
    appendStdoutFn: () => {},
    updateResultFn: (jobId, p) => {
      patch = p
    },
  })
  assert.equal(patch.remote.prUrl, 'https://github.com/acme/widgets/pull/11')
})

test('pollOnce never overwrites a known branch or prUrl with null', async () => {
  const client = fakeClientForPollOnce({ session: { state: 'RUNNING' }, pages: [emptyPage()] })
  let patch
  await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: { branch: 'jules/known', prUrl: 'https://github.com/acme/widgets/pull/1' },
    client,
    adapter: makeAdapter(),
    nowFn: () => 0,
    appendStdoutFn: () => {},
    updateResultFn: (jobId, p) => {
      patch = p
    },
  })
  assert.equal(patch.remote.branch, 'jules/known')
  assert.equal(patch.remote.prUrl, 'https://github.com/acme/widgets/pull/1')
})

// 8. pollOnce with zero activities makes no appendStdout call and sets sawNewActivity false
test('pollOnce with zero activities appends nothing and sets sawNewActivity false', async () => {
  const client = fakeClientForPollOnce({ pages: [emptyPage()] })
  const appended = []
  const res = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter: makeAdapter(),
    appendStdoutFn: (jobId, chunk) => appended.push(chunk),
    updateResultFn: () => {},
  })
  assert.equal(appended.length, 0)
  assert.equal(res.sawNewActivity, false)
  assert.deepEqual(res.lines, [])
})

// 9. cancel short-circuits with zero API calls
test('pollUntilTerminal returns canceled with zero API calls and zero sleeps', async () => {
  let apiCalls = 0
  const client = {
    getSession: async () => {
      apiCalls++
      return { state: 'RUNNING' }
    },
    listActivities: async () => {
      apiCalls++
      return emptyPage()
    },
  }
  const clock = fakeClock()
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 1000,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: () => ({ status: 'canceled', remote: {} }),
  })
  assert.equal(res.outcome, 'canceled')
  assert.equal(apiCalls, 0)
  assert.equal(clock.delays.length, 0)
})

// 10. cancel is checked BEFORE nowFn and before any API call (order guard)
test('cancel is checked before nowFn and before any API call', async () => {
  const client = {
    getSession: async () => {
      throw new Error('getSession must not be called')
    },
    listActivities: async () => {
      throw new Error('listActivities must not be called')
    },
  }
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 1000,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: () => {
      throw new Error('nowFn must not be called before the cancel check')
    },
    sleepFn: async () => {},
    readResultFn: () => ({ status: 'canceled', remote: {} }),
  })
  assert.equal(res.outcome, 'canceled')
})

// 11. timeout outcome
test('pollUntilTerminal returns timeout once the simulated clock passes timeoutMs', async () => {
  const clock = fakeClock()
  const client = scriptedClient({
    states: ['RUNNING'],
    pages: [emptyPage(), emptyPage(), emptyPage()],
  })
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 10000,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: runningRecord,
  })
  assert.equal(res.outcome, 'timeout')
  assert.deepEqual(clock.delays, [5000, 7500])
})

// 12. terminal completed is decided from the session STATE, not from a summary flag
test('pollUntilTerminal reports completed from the COMPLETED state even when no activity carries a completed flag', async () => {
  const clock = fakeClock()
  const client = scriptedClient({
    states: ['COMPLETED'],
    pages: [{ activities: [{ text: 'DONE' }], nextPageToken: '' }],
  })
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 10000,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: runningRecord,
  })
  assert.equal(res.outcome, 'completed')
  assert.equal(res.state, 'COMPLETED')
  assert.equal(res.summary.completed, false, 'summary does not carry the completed flag')
  assert.equal(clock.delays.length, 0)
})

// 13. terminal failed
test('pollUntilTerminal returns failed on a terminal failed session', async () => {
  const clock = fakeClock()
  const client = scriptedClient({
    states: ['FAILED'],
    pages: [{ activities: [{ text: 'boom', failed: true }], nextPageToken: '' }],
  })
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 10000,
    client,
    adapter: makeAdapter({ terminal: ['FAILED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: runningRecord,
  })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.state, 'FAILED')
  assert.equal(res.summary.completed, false)
  assert.equal(res.summary.failed, true)
  assert.equal(res.summary.failureMessage, 'boom')
})

// 14. 401 fails fast, 403 fails fast
test('pollUntilTerminal fails fast on 401 and 403 without sleeping', async () => {
  for (const status of [401, 403]) {
    const clock = fakeClock()
    const client = scriptedClient({ states: ['RUNNING'], pages: [apiError(status)] })
    const res = await pollUntilTerminal({
      jobId: 'j1',
      apiKey: 'k',
      sessionId: 's1',
      timeoutMs: 10000,
      client,
      adapter: makeAdapter({ terminal: ['COMPLETED'] }),
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      readResultFn: runningRecord,
    })
    assert.equal(res.outcome, 'failed', `status ${status}`)
    assert.equal(res.apiError.status, status)
    assert.equal(clock.delays.length, 0, `status ${status} must not sleep`)
    assert.equal(client.calls.listActivities.length, 1)
  }
})

// 15. 429 jumps to maxIntervalMs, loop continues, counter resets after a good tick
test('a 429 jumps straight to maxIntervalMs and the error counter resets after a good tick', async () => {
  const clock = fakeClock()
  const client = scriptedClient({
    states: ['RUNNING', 'RUNNING', 'RUNNING', 'COMPLETED'],
    pages: [
      apiError(429),
      emptyPage(),
      apiError(429),
      { activities: [{ text: 'DONE', done: true }], nextPageToken: '' },
    ],
  })
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 1000000000,
    maxConsecutiveErrors: 2,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: runningRecord,
  })
  assert.equal(res.outcome, 'completed')
  assert.deepEqual(clock.delays, [MAX_INTERVAL_MS, MAX_INTERVAL_MS, MAX_INTERVAL_MS])
  assert.equal(client.calls.getSession.length, 4)
})

// 16. maxConsecutiveErrors consecutive 5xx gives up after exactly N failures
test('pollUntilTerminal gives up after exactly maxConsecutiveErrors consecutive 5xx', async () => {
  const clock = fakeClock()
  const client = scriptedClient({ states: ['RUNNING'], pages: [apiError(503), apiError(503), apiError(503)] })
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 1000000000,
    maxConsecutiveErrors: 3,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: runningRecord,
  })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.apiError.status, 503)
  assert.equal(client.calls.listActivities.length, 3)
  assert.deepEqual(clock.delays, [MAX_INTERVAL_MS, MAX_INTERVAL_MS])
})

// 17. recorded sleep sequence equals the expected delays
test('the recorded sleep sequence matches backoff growth and the reset on new activity', async () => {
  const clock = fakeClock()
  const client = scriptedClient({
    states: ['RUNNING', 'RUNNING', 'RUNNING', 'COMPLETED'],
    pages: [
      emptyPage(),
      emptyPage(),
      { activities: [{ text: 'progress' }], nextPageToken: '' },
      { activities: [{ text: 'DONE', done: true }], nextPageToken: '' },
    ],
  })
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 1000000000,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: runningRecord,
  })
  assert.equal(res.outcome, 'completed')
  assert.deepEqual(clock.delays, [5000, 7500, 11250])
})

// 18. duplicate output guard: a full page re-read must not be appended twice
test('pollOnce does not re-append activities already recorded in the remote block', async () => {
  const client = {
    getSession: async () => ({ state: 'RUNNING' }),
    listActivities: async () => ({ activities: [{ name: 'a1', text: 'one' }], nextPageToken: '' }),
  }
  const adapter = makeAdapter()
  let firstPatch
  const firstAppend = []
  const first = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter,
    nowFn: () => 0,
    appendStdoutFn: (jobId, chunk) => firstAppend.push(chunk),
    updateResultFn: (jobId, patch) => {
      firstPatch = patch
    },
  })
  const secondAppend = []
  const second = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: firstPatch.remote.activityCursor,
    remote: firstPatch.remote,
    client,
    adapter,
    nowFn: () => 0,
    appendStdoutFn: (jobId, chunk) => secondAppend.push(chunk),
    updateResultFn: () => {},
  })
  assert.deepEqual(firstAppend, ['one\n'])
  assert.equal(first.sawNewActivity, true)
  assert.deepEqual(firstPatch.remote.seenActivityIds, ['a1'])
  assert.deepEqual(secondAppend, [])
  assert.equal(second.sawNewActivity, false)
})

// 19. a later tick carrying one genuinely new activity appends only that one
test('pollOnce appends only the genuinely new activity on a later tick', async () => {
  const client = fakeClientForPollOnce({
    pages: [
      { activities: [{ name: 'a1', text: 'one' }], nextPageToken: '' },
      { activities: [{ name: 'a1', text: 'one' }, { name: 'a2', text: 'two' }], nextPageToken: '' },
    ],
  })
  const adapter = makeAdapter()
  let firstPatch
  const firstAppend = []
  await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter,
    nowFn: () => 0,
    appendStdoutFn: (jobId, chunk) => firstAppend.push(chunk),
    updateResultFn: (jobId, patch) => {
      firstPatch = patch
    },
  })
  const secondAppend = []
  const second = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: firstPatch.remote.activityCursor,
    remote: firstPatch.remote,
    client,
    adapter,
    nowFn: () => 0,
    appendStdoutFn: (jobId, chunk) => secondAppend.push(chunk),
    updateResultFn: () => {},
  })
  assert.deepEqual(firstAppend, ['one\n'])
  assert.deepEqual(secondAppend, ['two\n'])
  assert.equal(second.sawNewActivity, true)
  assert.deepEqual(second.lines, ['two'])
  assert.deepEqual(second.summary.lines, ['two'])
})

// 20. a concurrent write to the remote block during the network round trip survives
test('pollOnce re-reads the record and preserves a remote field written mid-tick', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', title: 't', mode: 'write', env })
  updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 's1', state: 'IN_PROGRESS', activityCursor: '' } }, env)

  const client = {
    getSession: async () => ({ state: 'IN_PROGRESS' }),
    listActivities: async () => {
      // Simulate job_reply (or another process) touching result.remote while
      // this tick is awaiting the network.
      const current = readResult(job.jobId, env)
      updateResult(job.jobId, { remote: { ...current.remote, note: 'written-mid-tick' } }, env)
      return { activities: [], nextPageToken: '' }
    },
  }

  await pollOnce({
    jobId: job.jobId,
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: readResult(job.jobId, env).remote,
    client,
    adapter: makeAdapter(),
    env,
    appendStdoutFn: () => {},
  })

  const result = readResult(job.jobId, env)
  assert.equal(result.remote.note, 'written-mid-tick')
  assert.equal(result.remote.state, 'IN_PROGRESS')
})

// 21. an activity with neither name nor id must still dedupe on its content
test('pollOnce dedupes an activity with neither name nor id via a content-derived identity', async () => {
  const activity = { createTime: '2024-01-01T00:00:00Z', description: 'quiet tick', text: 'hello' }
  const client = fakeClientForPollOnce({
    pages: [
      { activities: [activity], nextPageToken: '' },
      { activities: [activity], nextPageToken: '' },
    ],
  })
  const firstAppend = []
  let firstPatch
  const first = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter: makeAdapter(),
    nowFn: () => 0,
    appendStdoutFn: (jobId, chunk) => firstAppend.push(chunk),
    updateResultFn: (jobId, patch) => {
      firstPatch = patch
    },
  })
  const secondAppend = []
  const second = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: firstPatch.remote,
    client,
    adapter: makeAdapter(),
    nowFn: () => 0,
    appendStdoutFn: (jobId, chunk) => secondAppend.push(chunk),
    updateResultFn: () => {},
  })

  assert.equal(first.sawNewActivity, true)
  assert.equal(firstAppend.length, 1)
  assert.equal(second.sawNewActivity, false)
  assert.deepEqual(secondAppend, [])
})

// 22. no name/id/createTime/description -> hash of the JSON is the stable identity
test('pollOnce hashes the activity JSON when it has no name, id, createTime or description', async () => {
  const activity = { weird: { nested: true } }
  const client = fakeClientForPollOnce({
    pages: [
      { activities: [activity], nextPageToken: '' },
      { activities: [activity], nextPageToken: '' },
    ],
  })
  let firstPatch
  const first = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: {},
    client,
    adapter: makeAdapter(),
    nowFn: () => 0,
    appendStdoutFn: () => {},
    updateResultFn: (jobId, patch) => {
      firstPatch = patch
    },
  })
  const secondAppend = []
  const second = await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: firstPatch.remote,
    client,
    adapter: makeAdapter(),
    nowFn: () => 0,
    appendStdoutFn: (jobId, chunk) => secondAppend.push(chunk),
    updateResultFn: () => {},
  })

  assert.equal(first.sawNewActivity, true)
  assert.equal(second.sawNewActivity, false)
  assert.deepEqual(secondAppend, [])
})

// 23. seenActivityIds cannot grow without bound
test('pollOnce caps seenActivityIds at the most recent 500 entries', async () => {
  const existing = Array.from({ length: 600 }, (_, i) => `id-${i}`)
  const client = fakeClientForPollOnce({ pages: [emptyPage()] })
  let patch
  await pollOnce({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    cursor: '',
    remote: { seenActivityIds: existing },
    client,
    adapter: makeAdapter(),
    nowFn: () => 0,
    appendStdoutFn: () => {},
    updateResultFn: (jobId, p) => {
      patch = p
    },
  })
  assert.equal(patch.remote.seenActivityIds.length, 500)
  assert.equal(patch.remote.seenActivityIds[0], 'id-100')
  assert.equal(patch.remote.seenActivityIds[499], 'id-599')
})

// P0.2: a waiting state is a result, not a reason to keep polling.
test('pollUntilTerminal returns waiting on AWAITING_USER_FEEDBACK instead of slow-polling it', async () => {
  const clock = fakeClock()
  const client = scriptedClient({
    states: ['AWAITING_USER_FEEDBACK'],
    pages: [emptyPage()],
  })
  const res = await pollUntilTerminal({
    jobId: 'j1',
    apiKey: 'k',
    sessionId: 's1',
    timeoutMs: 10000,
    client,
    adapter: makeAdapter({ terminal: ['COMPLETED'] }),
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    appendStdoutFn: () => {},
    updateResultFn: () => {},
    readResultFn: runningRecord,
  })
  assert.equal(res.outcome, 'waiting')
  assert.equal(res.state, 'AWAITING_USER_FEEDBACK')
  assert.equal(clock.delays.length, 0, 'no further sleeps once waiting is observed')
})

test('isWaitingRemoteState matches the adapter predicate and the AWAITING_/PAUSED fallback', async () => {
  const { isWaitingRemoteState } = await import('../../src/cloud/poller.mjs')
  assert.equal(isWaitingRemoteState({ isWaitingState: () => true }, 'WHATEVER'), true)
  assert.equal(isWaitingRemoteState({}, 'AWAITING_USER_FEEDBACK'), true)
  assert.equal(isWaitingRemoteState({}, 'AWAITING_PLAN_APPROVAL'), true)
  assert.equal(isWaitingRemoteState({}, 'PAUSED'), true)
  assert.equal(isWaitingRemoteState({}, 'IN_PROGRESS'), false)
  assert.equal(isWaitingRemoteState({}, 'COMPLETED'), false)
  assert.equal(isWaitingRemoteState({}, null), false)
})
