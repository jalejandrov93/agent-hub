import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { isLoopback, createServer, buildState } from '../src/dashboard.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dashboard-'))
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function get(port, urlPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('isLoopback accepts 127.0.0.1 and ::1, rejects a routable address', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('::ffff:127.0.0.1'), true)
  assert.equal(isLoopback('192.168.1.50'), false)
  assert.equal(isLoopback('8.8.8.8'), false)
})

test('buildState reflects the jobstore, preflight cache and event log', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  appendEvent({ kind: 'subagent.start', source: 'claude-hook', agent: 'claude', cwd: '/repo', title: 'Explore' }, { env })

  const state = buildState({ env })
  assert.ok(Array.isArray(state.agents))
  assert.ok(Array.isArray(state.jobs))
  assert.ok(Array.isArray(state.subagents))
  assert.equal(state.subagents.length, 1)
})

test('buildState jobs carry variant, sessionId, parentJobId and errorKind through to the dashboard (needed to render job_reply chains and the new billing/timeout/empty error badges)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { createJob, updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())

  const parent = createJob({
    agent: 'opencode',
    model: 'deepseek/deepseek-v4-pro',
    task: 't',
    cwd: '/tmp',
    title: 'parent job',
    mode: 'read',
    variant: 'high',
    env,
  })
  updateResult(parent.jobId, { status: 'failed', errorKind: 'billing', error: 'opencode billing error (402/insufficient balance)' }, env)

  const reply = createJob({
    agent: 'opencode',
    model: 'deepseek/deepseek-v4-pro',
    task: 't2',
    cwd: '/tmp',
    title: 'parent job (reply)',
    mode: 'read',
    sessionId: 'ses_abc',
    parentJobId: parent.jobId,
    env,
  })

  const state = buildState({ env })
  const jobsById = Object.fromEntries(state.jobs.map((j) => [j.jobId, j]))
  assert.equal(jobsById[parent.jobId].variant, 'high')
  assert.equal(jobsById[parent.jobId].errorKind, 'billing')
  assert.equal(jobsById[reply.jobId].sessionId, 'ses_abc')
  assert.equal(jobsById[reply.jobId].parentJobId, parent.jobId)
})

test('GET / serves the dashboard HTML page', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/')
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.match(res.body, /<title>/i)
  } finally {
    server.close()
  }
})

test('GET /api/state returns JSON with agents/jobs/subagents/events arrays', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/state')
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    const parsed = JSON.parse(res.body)
    assert.ok(Array.isArray(parsed.agents))
    assert.ok(Array.isArray(parsed.jobs))
    assert.ok(Array.isArray(parsed.subagents))
    assert.ok(Array.isArray(parsed.events))
  } finally {
    server.close()
  }
})

test('GET /events opens an SSE stream framed as "data: <line>\\n\\n" for new event-log lines', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const server = createServer({ env })
  const port = await listen(server)

  try {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET' }, (res) => {
        assert.equal(res.statusCode, 200)
        assert.match(res.headers['content-type'], /text\/event-stream/)
        let buf = ''
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8')
          if (buf.includes('\n\n') && buf.includes('"kind"')) {
            req.destroy()
            resolve(buf)
          }
        })
        res.on('error', () => {})
      })
      req.on('error', (err) => {
        if (!err.message.includes('socket hang up')) reject(err)
      })
      req.end()

      // Give the SSE connection a moment to register, then append an event.
      setTimeout(async () => {
        const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
        appendEvent({ kind: 'job.finished', agent: 'agy', model: 'x', cwd: '/tmp', title: 'sse-test' }, { env })
      }, 150)
    })

    assert.match(received, /data: \{.*"kind":"job\.finished".*\}\n\n/s)
  } finally {
    server.close()
  }
})

test('POST /api/jobs/:id/cancel from a loopback connection is processed (404-style JSON for an unknown job, not a 403)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/jobs/does-not-exist/cancel', { method: 'POST' })
    assert.notEqual(res.status, 403, 'a real loopback request must never be rejected as non-loopback')
  } finally {
    server.close()
  }
})
