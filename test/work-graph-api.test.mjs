import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createServer } from '../src/dashboard.mjs'
import { WorkGraphResponse } from '../src/schemas.mjs'
import { createJob } from '../src/jobstore.mjs'

// GET /api/work-graph: server-side wiring for src/workGraph.mjs, validated
// against the shared WorkGraphResponse contract the dashboard also imports.

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-work-graph-api-'))
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function request(port, urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { Host: '127.0.0.1', ...headers } }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        let parsed = null
        try {
          parsed = raw ? JSON.parse(raw) : null
        } catch {
          parsed = raw
        }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

test('GET /api/work-graph returns a payload matching WorkGraphResponse on an empty home', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/work-graph')
    assert.equal(res.status, 200)
    const parsed = WorkGraphResponse.parse(res.body)
    assert.deepEqual(parsed.repos, [])
    assert.deepEqual(parsed.nodes, [])
    assert.deepEqual(parsed.edges, [])
    assert.equal(typeof parsed.generatedAt, 'string')
  } finally {
    server.close()
  }
})

test('GET /api/work-graph includes a job whose cwd is not a git repo in the outside group', async () => {
  const home = tmpHome()
  const previousHome = process.env.AGENT_HUB_HOME
  process.env.AGENT_HUB_HOME = home
  try {
    const env = { AGENT_HUB_HOME: home }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-work-graph-not-a-repo-'))
    createJob({ agent: 'agy', model: 'x', task: 't', cwd, title: 't', mode: 'read', env })

    const server = createServer({ env })
    const port = await listen(server)
    try {
      const res = await request(port, '/api/work-graph')
      assert.equal(res.status, 200)
      const parsed = WorkGraphResponse.parse(res.body)
      const jobNode = parsed.nodes.find((n) => n.kind === 'job')
      assert.ok(jobNode)
      const outsideNode = parsed.nodes.find((n) => n.kind === 'outside')
      assert.ok(outsideNode)
      const runsInEdge = parsed.edges.find((e) => e.kind === 'runsIn' && e.from === jobNode.id)
      assert.equal(runsInEdge.to, outsideNode.id)
    } finally {
      server.close()
    }
  } finally {
    process.env.AGENT_HUB_HOME = previousHome
  }
})

test('GET /api/work-graph is a read-only GET route (no write-route guards apply)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/work-graph', { method: 'GET' })
    assert.equal(res.status, 200)
  } finally {
    server.close()
  }
})
