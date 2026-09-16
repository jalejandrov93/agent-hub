import { test } from 'node:test'
import assert from 'node:assert/strict'
import { julesDelegateTool, julesSourcesTool } from '../../src/tools/jules.mjs'

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

test('julesSourcesTool returns {sources: [{name, owner, repo}]} from the connected GitHub repos', async () => {
  const page = {
    sources: [
      { name: 'sources/github/acme/widgets', id: 'github/acme/widgets', githubRepo: { owner: 'acme', repo: 'widgets', defaultBranch: 'main' } },
      { name: 'sources/github/acme/gadgets', id: 'github/acme/gadgets', githubRepo: { owner: 'acme', repo: 'gadgets', defaultBranch: 'develop' } },
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
      { name: 'sources/github/acme/widgets', owner: 'acme', repo: 'widgets' },
      { name: 'sources/github/acme/gadgets', owner: 'acme', repo: 'gadgets' },
    ],
  })
  assert.equal(capturedArgs.apiKey, 'k')
})

test('julesSourcesTool falls back to parsing owner/repo out of the resource name when githubRepo is absent', async () => {
  const page = { sources: [{ name: 'sources/github/acme/widgets', id: 'github/acme/widgets' }] }
  const client = { listSources: async () => page }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.deepEqual(result.sources, [{ name: 'sources/github/acme/widgets', owner: 'acme', repo: 'widgets' }])
})

test('julesSourcesTool falls back per-field when githubRepo is present but incomplete', async () => {
  const page = { sources: [{ name: 'sources/github/acme/widgets', githubRepo: { owner: 'acme' } }] }
  const client = { listSources: async () => page }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.deepEqual(result.sources, [{ name: 'sources/github/acme/widgets', owner: 'acme', repo: 'widgets' }])
})

test('julesSourcesTool prefers explicit githubRepo fields over the parsed name when both are present', async () => {
  const page = { sources: [{ name: 'sources/github/acme/widgets', githubRepo: { owner: 'other-owner', repo: 'other-repo' } }] }
  const client = { listSources: async () => page }

  const result = await julesSourcesTool({ env: { JULES_API_KEY: 'k' }, client })
  assert.deepEqual(result.sources, [{ name: 'sources/github/acme/widgets', owner: 'other-owner', repo: 'other-repo' }])
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
