import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  JulesApiError,
  listSources,
  listSessions,
  createSession,
  getSession,
  listActivities,
  sendMessage,
  approvePlan,
} from '../../src/cloud/jules/client.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'jules')
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

/**
 * Every HTTP call goes through this fake: it records the request and hands
 * back the next canned response (or throws it, when the entry is an Error).
 */
function fakeFetch(...responses) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body, signal: init.signal })
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { impl, calls }
}

function canned({ status, body, raw, contentType = 'application/json' }) {
  const text = raw !== undefined ? raw : body === undefined ? '' : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': contentType },
    text: async () => text,
  }
}

test('listSources issues GET /sources with the API key header and page params, and returns the decoded body', async () => {
  const page = readJson('sources-page.json')
  const { impl, calls } = fakeFetch(canned({ status: 200, body: page }))
  const result = await listSources({ apiKey: 'key-123', pageSize: 10, pageToken: 'tok-1', fetchImpl: impl })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sources?pageSize=10&pageToken=tok-1`)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers['X-Goog-Api-Key'], 'key-123')
  assert.deepEqual(result, page)
})

test('listSources omits page params entirely when none are given', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: { sources: [] } }))
  await listSources({ apiKey: 'k', fetchImpl: impl })
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sources`)
})

test('listSessions issues GET /sessions with the API key header and page params, and returns the decoded body', async () => {
  const page = { sessions: [{ name: 'sessions/s1', state: 'COMPLETED' }] }
  const { impl, calls } = fakeFetch(canned({ status: 200, body: page }))
  const result = await listSessions({ apiKey: 'key-123', pageSize: 20, pageToken: 'tok-1', fetchImpl: impl })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sessions?pageSize=20&pageToken=tok-1`)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers['X-Goog-Api-Key'], 'key-123')
  assert.deepEqual(result, page)
})

test('listSessions omits page params entirely when none are given', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: { sessions: [] } }))
  await listSessions({ apiKey: 'k', fetchImpl: impl })
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sessions`)
})

test('listSessions maps a non-2xx response to JulesApiError with the /sessions endpoint', async () => {
  const body = readJson('error-429.json')
  const { impl } = fakeFetch(canned({ status: 429, body }))
  await assert.rejects(
    () => listSessions({ apiKey: 'k', fetchImpl: impl }),
    (error) => {
      assert.ok(error instanceof JulesApiError)
      assert.equal(error.status, 429)
      assert.deepEqual(error.body, body)
      assert.equal(error.endpoint, '/sessions')
      return true
    },
  )
})

test('createSession POSTs the nested sourceContext shape and omits undefined optionals', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: { name: 'sessions/s1', state: 'IN_PROGRESS' } }))
  await createSession({
    apiKey: 'k',
    prompt: 'do the thing',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    fetchImpl: impl,
  })

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sessions`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body), {
    prompt: 'do the thing',
    sourceContext: { source: 'sources/github/acme/widgets', githubRepoContext: { startingBranch: 'main' } },
  })
})

test('createSession includes title, requirePlanApproval and automationMode when provided', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: {} }))
  await createSession({
    apiKey: 'k',
    prompt: 'p',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    title: 'Fix paginate',
    requirePlanApproval: true,
    automationMode: 'AUTO_CREATE_PR',
    fetchImpl: impl,
  })
  assert.deepEqual(JSON.parse(calls[0].body), {
    prompt: 'p',
    sourceContext: { source: 'sources/github/acme/widgets', githubRepoContext: { startingBranch: 'main' } },
    title: 'Fix paginate',
    requirePlanApproval: true,
    automationMode: 'AUTO_CREATE_PR',
  })
})

test('createSession omits githubRepoContext entirely when no starting branch is given', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: {} }))
  await createSession({ apiKey: 'k', prompt: 'p', source: 'sources/github/acme/widgets', fetchImpl: impl })
  const body = JSON.parse(calls[0].body)
  assert.deepEqual(body, {
    prompt: 'p',
    sourceContext: { source: 'sources/github/acme/widgets' },
  })
  assert.equal('githubRepoContext' in body.sourceContext, false)
})

test('createSession omits githubRepoContext for an empty starting branch but keeps it for a real one', async () => {
  const empty = fakeFetch(canned({ status: 200, body: {} }))
  await createSession({
    apiKey: 'k',
    prompt: 'p',
    source: 'sources/github/acme/widgets',
    startingBranch: '',
    fetchImpl: empty.impl,
  })
  assert.equal('githubRepoContext' in JSON.parse(empty.calls[0].body).sourceContext, false)

  const withBranch = fakeFetch(canned({ status: 200, body: {} }))
  await createSession({
    apiKey: 'k',
    prompt: 'p',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    fetchImpl: withBranch.impl,
  })
  assert.deepEqual(JSON.parse(withBranch.calls[0].body).sourceContext, {
    source: 'sources/github/acme/widgets',
    githubRepoContext: { startingBranch: 'main' },
  })
})

test('getSession normalises a resource name and a bare id to the same URL', async () => {
  const first = fakeFetch(canned({ status: 200, body: { state: 'IN_PROGRESS' } }))
  const second = fakeFetch(canned({ status: 200, body: { state: 'IN_PROGRESS' } }))
  await getSession({ apiKey: 'k', sessionId: 'sessions/abc', fetchImpl: first.impl })
  await getSession({ apiKey: 'k', sessionId: 'abc', fetchImpl: second.impl })
  assert.equal(first.calls[0].url, `${DEFAULT_BASE_URL}/sessions/abc`)
  assert.equal(second.calls[0].url, `${DEFAULT_BASE_URL}/sessions/abc`)
})

test('getSession percent-encodes a bare session id so it cannot reshape the request path', async () => {
  const first = fakeFetch(canned({ status: 200, body: { state: 'IN_PROGRESS' } }))
  await getSession({ apiKey: 'k', sessionId: 'abc/def?x=1', fetchImpl: first.impl })
  assert.equal(first.calls[0].url, `${DEFAULT_BASE_URL}/sessions/abc%2Fdef%3Fx%3D1`)

  const second = fakeFetch(canned({ status: 200, body: { state: 'IN_PROGRESS' } }))
  await getSession({ apiKey: 'k', sessionId: 'sessions/../../etc/passwd', fetchImpl: second.impl })
  assert.equal(second.calls[0].url, `${DEFAULT_BASE_URL}/sessions/..%2F..%2Fetc%2Fpasswd`)
})

test('listActivities GETs /sessions/{id}/activities with paging', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: { activities: [] } }))
  await listActivities({ apiKey: 'k', sessionId: 'sessions/abc', pageSize: 25, pageToken: 'tok', fetchImpl: impl })
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sessions/abc/activities?pageSize=25&pageToken=tok`)
  assert.equal(calls[0].method, 'GET')
})

test('sendMessage POSTs { prompt } to :sendMessage', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: {} }))
  await sendMessage({ apiKey: 'k', sessionId: 'abc', prompt: 'keep going', fetchImpl: impl })
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sessions/abc:sendMessage`)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { prompt: 'keep going' })
})

test('approvePlan POSTs an empty object to :approvePlan', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: {} }))
  await approvePlan({ apiKey: 'k', sessionId: 'abc', fetchImpl: impl })
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sessions/abc:approvePlan`)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), {})
})

test('baseUrl overrides DEFAULT_BASE_URL', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: { sources: [] } }))
  await listSources({ apiKey: 'k', baseUrl: 'https://example.test/v9/', fetchImpl: impl })
  assert.equal(calls[0].url, 'https://example.test/v9/sources')
})

test('DEFAULT_REQUEST_TIMEOUT_MS is 30s', () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30000)
})

test('every request carries an AbortSignal so a hung connection cannot block the caller forever', async () => {
  const { impl, calls } = fakeFetch(canned({ status: 200, body: { sources: [] } }))
  await listSources({ apiKey: 'k', fetchImpl: impl })
  assert.ok(calls[0].signal instanceof AbortSignal)
})

test('an aborted request surfaces as a transport JulesApiError with status 0 and the abort error as cause', async () => {
  const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  const { impl } = fakeFetch(abortError)
  await assert.rejects(
    () => listSources({ apiKey: 'k', fetchImpl: impl }),
    (error) => {
      assert.equal(error.name, 'JulesApiError')
      assert.equal(error.status, 0)
      assert.equal(error.body, null)
      assert.equal(error.cause, abortError)
      return true
    },
  )
})

test('a non-2xx JSON response throws JulesApiError carrying status, parsed body and endpoint', async () => {
  const body = readJson('error-429.json')
  const { impl } = fakeFetch(canned({ status: 429, body }))
  await assert.rejects(
    () => listSources({ apiKey: 'k', fetchImpl: impl }),
    (error) => {
      assert.ok(error instanceof JulesApiError)
      assert.equal(error.name, 'JulesApiError')
      assert.equal(error.status, 429)
      assert.deepEqual(error.body, body)
      assert.equal(error.endpoint, '/sources')
      return true
    },
  )
})

test('a non-2xx non-JSON response throws JulesApiError with the raw text as body', async () => {
  const { impl } = fakeFetch(canned({ status: 500, raw: '<html>gateway blew up</html>', contentType: 'text/html' }))
  await assert.rejects(
    () => listSources({ apiKey: 'k', fetchImpl: impl }),
    (error) => {
      assert.equal(error.status, 500)
      assert.equal(error.body, '<html>gateway blew up</html>')
      return true
    },
  )
})

test('a rejected fetch throws JulesApiError with status 0, body null and the original error as cause', async () => {
  const boom = new Error('network down')
  const { impl } = fakeFetch(boom)
  await assert.rejects(
    () => listSources({ apiKey: 'k', fetchImpl: impl }),
    (error) => {
      assert.equal(error.name, 'JulesApiError')
      assert.equal(error.status, 0)
      assert.equal(error.body, null)
      assert.equal(error.cause, boom)
      return true
    },
  )
})
