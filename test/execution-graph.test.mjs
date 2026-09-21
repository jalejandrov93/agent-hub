import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {
  nodeIdentity,
  buildExecutionGraph,
  summarizeExecutionGraph,
} from '../src/execution-graph.mjs'
import { listJobs } from '../src/jobstore.mjs'
import { executionGraphTool, execution_graph } from '../src/tools/insights.mjs'
import { createServer } from '../src/dashboard.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-exec-graph-test-'))
}

function writeJob(home, record) {
  const dir = path.join(home, 'runs', record.jobId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2), 'utf8')
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('nodeIdentity returns executionId, execution_id or jobId', () => {
  assert.equal(nodeIdentity({ executionId: 'e1', execution_id: 'e2', jobId: 'j1' }), 'e1')
  assert.equal(nodeIdentity({ execution_id: 'e2', jobId: 'j1' }), 'e2')
  assert.equal(nodeIdentity({ jobId: 'j1' }), 'j1')
  assert.equal(nodeIdentity({}), null)
})

test('empty job list yields an empty graph', () => {
  const graph = buildExecutionGraph({ jobs: [] })
  assert.deepEqual(graph, {
    roots: [],
    nodes: {},
    edges: [],
  })

  const summary = summarizeExecutionGraph(graph)
  assert.deepEqual(summary, {
    roots: [],
    nodeCount: 0,
    edgeCount: 0,
    byStatus: {},
  })
})

test('execution graph: small tree with root, children, grandchild, relations, edges, summary, and subtree filter', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  // 1. Root
  writeJob(home, {
    jobId: 'job-root',
    executionId: 'exec-root',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    status: 'succeeded',
    sessionId: 'session-alpha',
    attempt: 1,
    workflow_id: 'wf-1',
    step_id: 'step-root',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:05.000Z',
  })

  // 2. Child 1 (resumes session-alpha from exec-root)
  writeJob(home, {
    jobId: 'job-child-1',
    executionId: 'exec-child-1',
    parent_execution_id: 'exec-root',
    root_execution_id: 'exec-root',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    status: 'succeeded',
    sessionId: 'session-alpha',
    attempt: 1,
    workflow_id: 'wf-1',
    step_id: 'step-child-1',
    createdAt: '2026-09-20T10:01:00.000Z',
    updatedAt: '2026-09-20T10:01:05.000Z',
  })

  // 3. Child 2 (delegates, new session-beta)
  writeJob(home, {
    jobId: 'job-child-2',
    executionId: 'exec-child-2',
    parent_execution_id: 'exec-root',
    root_execution_id: 'exec-root',
    agent: 'opencode',
    model: 'claude-3-5-sonnet',
    mode: 'read',
    status: 'running',
    sessionId: 'session-beta',
    attempt: 1,
    workflow_id: 'wf-1',
    step_id: 'step-child-2',
    createdAt: '2026-09-20T10:02:00.000Z',
    updatedAt: '2026-09-20T10:02:05.000Z',
  })

  // 4. Grandchild (retry: attempt 2)
  writeJob(home, {
    jobId: 'job-grandchild-1',
    executionId: 'exec-grandchild-1',
    parent_execution_id: 'exec-child-1',
    root_execution_id: 'exec-root',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    status: 'failed',
    sessionId: 'session-gamma',
    attempt: 2,
    workflow_id: 'wf-1',
    step_id: 'step-grandchild-1',
    createdAt: '2026-09-20T10:03:00.000Z',
    updatedAt: '2026-09-20T10:03:05.000Z',
  })

  // 5. Job with missing parent (edges only emitted when parent id exists in provided jobs)
  writeJob(home, {
    jobId: 'job-orphan',
    executionId: 'exec-orphan',
    parent_execution_id: 'missing-parent',
    root_execution_id: 'missing-root',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    status: 'succeeded',
    sessionId: 'session-delta',
    attempt: 1,
    workflow_id: 'wf-1',
    step_id: 'step-orphan',
    createdAt: '2026-09-20T10:04:00.000Z',
    updatedAt: '2026-09-20T10:04:05.000Z',
  })

  const jobs = listJobs(env)
  const graph = buildExecutionGraph({ jobs })

  // Roots: only nodes with parent === null
  assert.deepEqual(graph.roots, ['exec-root'])

  // Node attributes (root, parent, relation)
  assert.equal(graph.nodes['exec-root'].parent, null)
  assert.equal(graph.nodes['exec-root'].root, 'exec-root')
  assert.equal(graph.nodes['exec-root'].relation, 'delegate')

  assert.equal(graph.nodes['exec-child-1'].parent, 'exec-root')
  assert.equal(graph.nodes['exec-child-1'].root, 'exec-root')
  assert.equal(graph.nodes['exec-child-1'].relation, 'resume')

  assert.equal(graph.nodes['exec-child-2'].parent, 'exec-root')
  assert.equal(graph.nodes['exec-child-2'].root, 'exec-root')
  assert.equal(graph.nodes['exec-child-2'].relation, 'delegate')

  assert.equal(graph.nodes['exec-grandchild-1'].parent, 'exec-child-1')
  assert.equal(graph.nodes['exec-grandchild-1'].root, 'exec-root')
  assert.equal(graph.nodes['exec-grandchild-1'].relation, 'retry')

  assert.equal(graph.nodes['exec-orphan'].parent, 'missing-parent')
  assert.equal(graph.nodes['exec-orphan'].root, 'missing-root')

  // Edges: only emitted when parent exists in provided jobs
  // Sorted by from then to
  assert.deepEqual(graph.edges, [
    { from: 'exec-child-1', to: 'exec-grandchild-1', relation: 'retry' },
    { from: 'exec-root', to: 'exec-child-1', relation: 'resume' },
    { from: 'exec-root', to: 'exec-child-2', relation: 'delegate' },
  ])

  // Summarize counts
  const summary = summarizeExecutionGraph(graph)
  assert.deepEqual(summary.roots, ['exec-root'])
  assert.equal(summary.nodeCount, 5)
  assert.equal(summary.edgeCount, 3)
  assert.deepEqual(summary.byStatus, {
    succeeded: 3,
    running: 1,
    failed: 1,
  })

  // rootExecutionId subtree filter
  const subtree = buildExecutionGraph({ jobs, rootExecutionId: 'exec-child-1' })
  assert.deepEqual(subtree.roots, ['exec-child-1'])
  assert.deepEqual(Object.keys(subtree.nodes).sort(), ['exec-child-1', 'exec-grandchild-1'])
  assert.deepEqual(subtree.edges, [
    { from: 'exec-child-1', to: 'exec-grandchild-1', relation: 'retry' },
  ])
  const subtreeSummary = summarizeExecutionGraph(subtree)
  assert.equal(subtreeSummary.nodeCount, 2)
  assert.equal(subtreeSummary.edgeCount, 1)

  // MCP tool execution_graph / executionGraphTool in tools/insights.mjs
  const toolResultFull = executionGraphTool({ env })
  assert.deepEqual(toolResultFull.roots, ['exec-root'])
  assert.equal(Object.keys(toolResultFull.nodes).length, 5)

  const toolResultSubtree = execution_graph({ rootExecutionId: 'exec-child-1', env })
  assert.deepEqual(toolResultSubtree.roots, ['exec-child-1'])
  assert.equal(Object.keys(toolResultSubtree.nodes).length, 2)

  // Dashboard endpoint GET /api/execution-graph
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const resFull = await getJson(port, '/api/execution-graph')
    assert.equal(resFull.status, 200)
    assert.deepEqual(resFull.data.roots, ['exec-root'])
    assert.equal(Object.keys(resFull.data.nodes).length, 5)

    const resSubtree = await getJson(port, '/api/execution-graph?root=exec-child-1')
    assert.equal(resSubtree.status, 200)
    assert.deepEqual(resSubtree.data.roots, ['exec-child-1'])
    assert.equal(Object.keys(resSubtree.data.nodes).length, 2)
  } finally {
    server.close()
  }
})
