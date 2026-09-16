import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { julesDelegateTool, julesSourcesTool, julesCheckTool, julesSessionsTool } from '../../src/tools/jules.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'jules')
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

test('julesDelegateTool requires either cwd or source', async () => {
  await assert.rejects(() => julesDelegateTool({ task: 't' }), /requires either cwd .* or .* source/i)
})

test('julesDelegateTool rejects an unknown taskType', async () => {
  await assert.rejects(() => julesDelegateTool({ task: 't', cwd: '/repo', taskType: 'not-a-task' }), /unknown taskType: not-a-task/)
})

test('julesDelegateTool forwards to startRemoteJobFn and returns {jobId, status, errorKind} like delegateTool', async () => {
  let captured = null
  const startRemoteJobFn = (args) => {
    captured = args
    return { job: { jobId: 'j-1', status: 'queued', errorKind: null }, done: Promise.resolve() }
  }

  const result = await julesDelegateTool({
    task: 'add a test',
    cwd: '/repo',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    title: 'my task',
    requirePlanApproval: true,
    automationMode: 'AUTO_CREATE_PR',
    timeoutS: 1200,
    taskType: 'implementation-with-repo-rules',
    env: { JULES_API_KEY: 'k' },
    startRemoteJobFn,
  })

  assert.deepEqual(result, { jobId: 'j-1', status: 'queued', errorKind: null })
  assert.equal(captured.agent, 'jules')
  assert.equal(captured.model, 'jules')
  assert.equal(captured.task, 'add a test')
  assert.equal(captured.cwd, '/repo')
  assert.equal(captured.source, 'sources/github/acme/widgets')
  assert.equal(captured.startingBranch, 'main')
  assert.equal(captured.title, 'my task')
  assert.equal(captured.requirePlanApproval, true)
  assert.equal(captured.automationMode, 'AUTO_CREATE_PR')
  assert.equal(captured.timeoutS, 1200)
  assert.equal(captured.taskType, 'implementation-with-repo-rules')
  assert.equal(captured.turnDepth, 0)
})

test('julesDelegateTool works with source alone (no cwd)', async () => {
  let captured = null
  const startRemoteJobFn = (args) => {
    captured = args
    return { job: { jobId: 'j-2', status: 'queued', errorKind: null }, done: Promise.resolve() }
  }
  const result = await julesDelegateTool({ task: 't', source: 'sources/github/acme/widgets', startRemoteJobFn })
  assert.equal(result.jobId, 'j-2')
  assert.equal(captured.cwd, undefined)
})

test('julesDelegateTool surfaces a failed job (e.g. missing JULES_API_KEY) the same way delegateTool would', async () => {
  const startRemoteJobFn = () => ({
    job: { jobId: 'j-3', status: 'failed', errorKind: 'auth' },
    done: Promise.resolve(),
  })
  const result = await julesDelegateTool({ task: 't', cwd: '/repo', startRemoteJobFn })
  assert.deepEqual(result, { jobId: 'j-3', status: 'failed', errorKind: 'auth' })
})

test('julesCheckTool forwards jobId/sessionId/env/client to checkRemoteSessionFn and returns its result', async () => {
  let captured = null
  const checkRemoteSessionFn = async (args) => {
    captured = args
    return { jobId: 'j1', sessionId: 's1', state: 'COMPLETED', finalized: true, terminal: true }
  }
  const client = { marker: true }
  const result = await julesCheckTool({
    jobId: 'j1',
    sessionId: 's1',
    env: { JULES_API_KEY: 'k' },
    client,
    checkRemoteSessionFn,
  })

  assert.equal(result.finalized, true)
  assert.equal(captured.jobId, 'j1')
  assert.equal(captured.sessionId, 's1')
  assert.equal(captured.env.JULES_API_KEY, 'k')
  assert.equal(captured.client, client)
})

test('julesSessionsTool throws a clean message when JULES_API_KEY is missing', async () => {
  await assert.rejects(
    () => julesSessionsTool({ env: {}, client: { listSessions: async () => ({}) } }),
    /JULES_API_KEY is missing or rejected/
  )
})

test('julesSessionsTool maps a 401/403 JulesApiError to a clean message', async () => {
  const apiError = Object.assign(new Error('Jules API responded 401'), { status: 401 })
  const client = {
    listSessions: async () => {
      throw apiError
    },
  }
  await assert.rejects(() => julesSessionsTool({ env: { JULES_API_KEY: 'bad' }, client }), /JULES_API_KEY is missing or rejected/)
})

test('julesSessionsTool returns sessions newest first with the matching local jobId or null', async () => {
  const page = {
    sessions: [
      {
        name: 'sessions/s-old',
        id: 's-old',
        state: 'COMPLETED',
        title: 'old',
        createTime: '2026-09-10T00:00:00Z',
        url: 'https://jules.google.com/session/s-old',
        outputs: [{ pullRequest: { url: 'https://github.com/acme/widgets/pull/1', headRef: 'jules/one' } }],
      },
      { name: 'sessions/s-new', id: 's-new', state: 'IN_PROGRESS', createTime: '2026-09-15T00:00:00Z', url: 'https://jules.google.com/session/s-new' },
    ],
  }
  let captured = null
  const client = {
    listSessions: async (args) => {
      captured = args
      return page
    },
  }
  const listJobsFn = () => [{ jobId: 'j-new', remote: { sessionId: 's-new' } }]

  const result = await julesSessionsTool({ env: { JULES_API_KEY: 'k' }, client, listJobsFn, limit: 20 })

  assert.equal(captured.apiKey, 'k')
  assert.equal(captured.pageSize, 20)
  assert.deepEqual(result.sessions.map((s) => s.sessionId), ['s-new', 's-old'])
  assert.deepEqual(result.sessions[0], {
    sessionId: 's-new',
    title: null,
    state: 'IN_PROGRESS',
    prUrl: null,
    branch: null,
    sessionUrl: 'https://jules.google.com/session/s-new',
    createTime: '2026-09-15T00:00:00Z',
    jobId: 'j-new',
  })
  assert.equal(result.sessions[1].jobId, null)
  assert.equal(result.sessions[1].prUrl, 'https://github.com/acme/widgets/pull/1')
  assert.equal(result.sessions[1].branch, 'jules/one')
  assert.equal(result.sessions[1].title, 'old')
})

test('julesSessionsTool caps the result at limit after sorting newest first', async () => {
  const sessions = [1, 2, 3].map((n) => ({
    id: `s-${n}`,
    state: 'COMPLETED',
    createTime: `2026-09-0${n}T00:00:00Z`,
  }))
  const client = { listSessions: async () => ({ sessions }) }
  const result = await julesSessionsTool({ env: { JULES_API_KEY: 'k' }, client, listJobsFn: () => [], limit: 2 })
  assert.deepEqual(result.sessions.map((s) => s.sessionId), ['s-3', 's-2'])
})

test('julesSessionsTool filters by state when given', async () => {
  const page = {
    sessions: [
      { id: 's-done', state: 'COMPLETED', createTime: '2026-09-10T00:00:00Z' },
      { id: 's-run', state: 'IN_PROGRESS', createTime: '2026-09-11T00:00:00Z' },
    ],
  }
  const client = { listSessions: async () => page }
  const result = await julesSessionsTool({ env: { JULES_API_KEY: 'k' }, client, listJobsFn: () => [], state: 'COMPLETED' })
  assert.deepEqual(result.sessions.map((s) => s.sessionId), ['s-done'])
})

test('julesSessionsTool still returns sessions when there is no local job history', async () => {
  const client = { listSessions: async () => ({ sessions: [{ id: 's1', state: 'COMPLETED', createTime: '2026-09-10T00:00:00Z' }] }) }
  const listJobsFn = () => {
    throw new Error('runs dir unreadable')
  }
  const result = await julesSessionsTool({ env: { JULES_API_KEY: 'k' }, client, listJobsFn })
  assert.deepEqual(result.sessions, [
    {
      sessionId: 's1',
      title: null,
      state: 'COMPLETED',
      prUrl: null,
      branch: null,
      sessionUrl: null,
      createTime: '2026-09-10T00:00:00Z',
      jobId: null,
    },
  ])
})

test('julesSourcesTool throws a clean message when JULES_API_KEY is missing', async () => {
  await assert.rejects(() => julesSourcesTool({ env: {}, client: { listSources: async () => ({ sources: [] }) } }), /JULES_API_KEY is missing or rejected/)
})

test('julesSourcesTool maps a 401/403 JulesApiError to a clean message', async () => {
  const apiError = Object.assign(new Error('Jules API responded 401'), { status: 401 })
  const client = {
    listSources: async () => {
      throw apiError
    },
  }
  await assert.rejects(() => julesSourcesTool({ env: { JULES_API_KEY: 'bad' }, client }), /JULES_API_KEY is missing or rejected/)
})

test('julesSourcesTool returns owner/repo plus defaultBranch and branches from the connected GitHub repos', async () => {
  const page = {
    sources: [
      {
        name: 'sources/github/acme/widgets',
        id: 'github/acme/widgets',
        githubRepo: {
          owner: 'acme',
          repo: 'widgets',
          isPrivate: true,
          defaultBranch: { displayName: 'main' },
          branches: [{ displayName: 'develop' }, { displayName: 'main' }],
        },
      },
      {
        name: 'sources/github/acme/gadgets',
        id: 'github/acme/gadgets',
        githubRepo: {
          owner: 'acme',
          repo: 'gadgets',
          isPrivate: false,
          defaultBranch: { displayName: 'develop' },
          branches: [{ displayName: 'develop' }],
        },
      },
    ],
    nextPageToken: 'tok-2',
  }
  let capturedArgs = null
  const client = {
    listSources: async (args) => {
      capturedArgs = args
      return page
    },
  }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.deepEqual(result, {
    sources: [
      { name: 'sources/github/acme/widgets', owner: 'acme', repo: 'widgets', defaultBranch: 'main', branches: ['develop', 'main'] },
      { name: 'sources/github/acme/gadgets', owner: 'acme', repo: 'gadgets', defaultBranch: 'develop', branches: ['develop'] },
    ],
  })
  assert.equal(capturedArgs.apiKey, 'k')
})

test('julesSourcesTool reads the real githubRepo defaultBranch.displayName and branches[].displayName shape', async () => {
  const page = readJson('sources-page.json')
  const client = { listSources: async () => page }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.equal(result.sources[0].defaultBranch, 'main')
  assert.deepEqual(result.sources[0].branches, ['develop', 'main'])
})

test('julesSourcesTool falls back to parsing owner/repo out of the resource name when githubRepo is absent', async () => {
  const page = { sources: [{ name: 'sources/github/acme/widgets', id: 'github/acme/widgets' }] }
  const client = { listSources: async () => page }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.deepEqual(result.sources, [
    { name: 'sources/github/acme/widgets', owner: 'acme', repo: 'widgets', defaultBranch: null, branches: [] },
  ])
})

test('julesSourcesTool falls back per-field when githubRepo is present but incomplete', async () => {
  const page = { sources: [{ name: 'sources/github/acme/widgets', githubRepo: { owner: 'acme' } }] }
  const client = { listSources: async () => page }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.deepEqual(result.sources, [
    { name: 'sources/github/acme/widgets', owner: 'acme', repo: 'widgets', defaultBranch: null, branches: [] },
  ])
})

test('julesSourcesTool prefers explicit githubRepo fields over the parsed name when both are present', async () => {
  const page = {
    sources: [
      {
        name: 'sources/github/acme/widgets',
        githubRepo: { owner: 'other-owner', repo: 'other-repo', defaultBranch: { displayName: 'trunk' }, branches: [{ displayName: 'trunk' }] },
      },
    ],
  }
  const client = { listSources: async () => page }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.deepEqual(result.sources, [
    { name: 'sources/github/acme/widgets', owner: 'other-owner', repo: 'other-repo', defaultBranch: 'trunk', branches: ['trunk'] },
  ])
})

test('julesSourcesTool re-throws any other client error unchanged', async () => {
  const apiError = Object.assign(new Error('Jules API responded 500'), { status: 500 })
  const client = {
    listSources: async () => {
      throw apiError
    },
  }
  await assert.rejects(() => julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client }), /500/)
})
