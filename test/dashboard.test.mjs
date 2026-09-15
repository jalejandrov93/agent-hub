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

function postJson(port, urlPath, data, { method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? '' : JSON.stringify(data)
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function fakeRunner(responses) {
  const calls = []
  const runner = async (cmd, args) => {
    calls.push({ cmd, args })
    const key = `${cmd} ${args.join(' ')}`
    for (const [pattern, response] of responses) {
      if (typeof pattern === 'string' ? key.includes(pattern) : pattern.test(key)) return response
    }
    throw new Error(`fakeRunner: no response configured for "${key}"`)
  }
  runner.calls = calls
  return runner
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

test('buildState enriches each agent row with dataPolicy (from MODEL_REGISTRY) and binPath/cliVersion (from discovery.json)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { writeCacheEntry } = await import('../src/preflight.mjs?t=' + Date.now())
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())

  writeCacheEntry('agy:gemini-3.8-flash-low', { agent: 'agy', model: 'gemini-3.8-flash-low', status: 'ready', checkedAt: new Date().toISOString() }, env)
  writeJsonAtomic(paths(env).discoveryFile, {
    agy: { agent: 'agy', cmd: 'agy', binPath: '/home/u/.local/bin/agy', version: '1.2.1', models: [], checkedAt: new Date().toISOString(), error: null },
  })

  const state = buildState({ env })
  const row = state.agents.find((a) => a.agent === 'agy' && a.model === 'gemini-3.8-flash-low')
  assert.equal(row.dataPolicy, 'unknown')
  assert.equal(row.binPath, '/home/u/.local/bin/agy')
  assert.equal(row.cliVersion, '1.2.1')
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

test('the dashboard HTML wires up the Agents panel revalidate/rediscover actions and a Config panel', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/')
    const html = res.body
    assert.match(html, /id="btn-revalidate-all"/, 'header "Revalidate all" button')
    assert.match(html, /id="btn-rediscover"/, 'header "Rediscover CLIs" button')
    assert.match(html, /id="config-panel"/, 'a Config panel exists')
    assert.match(html, /\/api\/agents\/refresh/, 'JS calls the agents refresh endpoint')
    assert.match(html, /\/api\/discovery\/refresh/, 'JS calls the discovery refresh endpoint')
    assert.match(html, /\/api\/overrides/, 'JS calls the overrides endpoint')
    assert.match(html, /aria-busy/, 'in-flight actions set aria-busy')
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

test('GET /api/config returns delegationMap, discovery, timeouts, breaker, ttlMs, agentHubHome, writeAllowlist, breakerState, overrides', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/config')
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.delegationMap && typeof body.delegationMap === 'object')
    assert.ok(body.discovery && typeof body.discovery === 'object')
    assert.ok(body.timeouts && typeof body.timeouts === 'object')
    assert.ok(body.breaker)
    assert.ok(Array.isArray(body.breaker.failureKinds))
    assert.ok(Array.isArray(body.breaker.immediateKinds))
    assert.equal(typeof body.breaker.windowMs, 'number')
    assert.equal(typeof body.breaker.failureThreshold, 'number')
    assert.equal(typeof body.ttlMs, 'number')
    assert.equal(typeof body.agentHubHome, 'string')
    assert.ok(Array.isArray(body.writeAllowlist))
    assert.ok(Array.isArray(body.breakerState))
    assert.ok(body.overrides && typeof body.overrides === 'object')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with an empty body refreshes every default pair using the injected commandRunner', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', {})
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.results))
    assert.ok(res.body.results.length > 0)
    assert.ok(!runner.calls.some((c) => c.args.includes('Reply exactly: PONG')), 'a bulk refresh must never L3-ping')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with {agent, model} refreshes only that pair', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const runner = fakeRunner([['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }]])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', { agent: 'copilot', model: 'auto' })
    assert.equal(res.status, 200)
    assert.equal(res.body.results.length, 1)
    assert.equal(res.body.results[0].agent, 'copilot')
    assert.equal(res.body.results[0].model, 'auto')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with {agent, model, ping:true} runs an L3 ping, not a bulk refresh', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const runner = fakeRunner([[/-p Reply exactly: PONG/, { stdout: '{"status":"SUCCESS","response":"PONG","usage":{"total_tokens":1},"conversation_id":"c1"}', stderr: '', code: 0 }]])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', { agent: 'agy', model: 'gemini-3.8-flash-low', ping: true })
    assert.equal(res.status, 200)
    assert.equal(res.body.results.length, 1)
    assert.equal(res.body.results[0].ladderLevel, 'L3')
    assert.equal(res.body.results[0].status, 'ready')
  } finally {
    server.close()
  }
})

test('POST /api/discovery/refresh runs runDiscovery(force:true) and returns the discovery.json content', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/discovery/refresh', undefined)
    assert.equal(res.status, 200)
    assert.ok(res.body.agy)
    assert.ok(res.body.opencode)
    assert.ok(res.body.copilot)
  } finally {
    server.close()
  }
})

test('POST /api/overrides sets a hold and GET /api/config reflects it; DELETE clears it', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const setRes = await postJson(port, '/api/overrides', { agent: 'agy', model: 'gemini-3.8-flash-low', hold: true })
    assert.equal(setRes.status, 200)
    assert.equal(setRes.body.hold, true)

    const configRes = await get(port, '/api/config')
    const config = JSON.parse(configRes.body)
    assert.equal(config.overrides['agy:gemini-3.8-flash-low'].hold, true)

    const delRes = await postJson(port, '/api/overrides/agy/gemini-3.8-flash-low', undefined, { method: 'DELETE' })
    assert.equal(delRes.status, 200)
    assert.equal(delRes.body.cleared, true)

    const configRes2 = await get(port, '/api/config')
    const config2 = JSON.parse(configRes2.body)
    assert.equal('agy:gemini-3.8-flash-low' in config2.overrides, false)
  } finally {
    server.close()
  }
})

test('DELETE /api/overrides/:agent/:model URL-decodes the model segment (opencode ids contain "/")', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { setOverride, overrideKey, readOverrides } = await import('../src/overrides.mjs?t=' + Date.now())
  setOverride(overrideKey('opencode', 'opencode/muse-spark-1.3-contributor-free'), { hold: true }, env)

  const server = createServer({ env })
  const port = await listen(server)
  try {
    const encodedModel = encodeURIComponent('opencode/muse-spark-1.3-contributor-free')
    const res = await postJson(port, `/api/overrides/opencode/${encodedModel}`, undefined, { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal(res.body.cleared, true)
    assert.equal('opencode:opencode/muse-spark-1.3-contributor-free' in readOverrides(env), false)
  } finally {
    server.close()
  }
})

test('write routes (agents/refresh, discovery/refresh, overrides) are loopback-gated with 403 for a non-loopback caller', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  server.on('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5', configurable: true })
  })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/overrides', { agent: 'agy', model: 'x', hold: true })
    assert.equal(res.status, 403)
  } finally {
    server.close()
  }
})
