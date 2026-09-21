import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  resolveOpencodeService,
  opencodeBridge,
  isSupportedOpencodeVersion,
} from '../src/harness/opencode-bridge.mjs'
import { bridgeSupportsWake, resolveBridge } from '../src/harness/bridge.mjs'

function makeTempServiceDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bridge-test-'))
}

test('opencode-bridge: isSupportedOpencodeVersion checks >= 2.0.0', () => {
  assert.equal(isSupportedOpencodeVersion('2.0.0'), true)
  assert.equal(isSupportedOpencodeVersion('2.0.11'), true)
  assert.equal(isSupportedOpencodeVersion('v2.0.11'), true)
  assert.equal(isSupportedOpencodeVersion('opencode v2.0.11'), true)
  assert.equal(isSupportedOpencodeVersion('3.0.0'), true)
  assert.equal(isSupportedOpencodeVersion('1.9.9'), false)
  assert.equal(isSupportedOpencodeVersion('1.0.0'), false)
  assert.equal(isSupportedOpencodeVersion(null), false)
  assert.equal(isSupportedOpencodeVersion(undefined), false)
  assert.equal(isSupportedOpencodeVersion(''), false)
  assert.equal(isSupportedOpencodeVersion('invalid'), false)
})

test('opencode-bridge: resolveOpencodeService reads service.json with credentials', () => {
  const tmpDir = makeTempServiceDir()
  try {
    const serviceFile = path.join(tmpDir, 'service.json')
    fs.writeFileSync(
      serviceFile,
      JSON.stringify({ url: 'http://127.0.0.1:49374', pid: 12345, password: 'test-password' })
    )
    const env = { AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile }
    const res = resolveOpencodeService({ env, cache: {} })
    assert.deepEqual(res, {
      url: 'http://127.0.0.1:49374',
      password: 'test-password',
    })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('opencode-bridge: resolveOpencodeService caches for ~5s and re-evaluates after expiration', () => {
  const tmpDir = makeTempServiceDir()
  try {
    const serviceFile = path.join(tmpDir, 'service.json')
    fs.writeFileSync(
      serviceFile,
      JSON.stringify({ url: 'http://127.0.0.1:49374', pid: 12345, password: 'pass1' })
    )
    const env = { AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile }
    let currentTime = 10000
    const cache = {}
    const res1 = resolveOpencodeService({ env, cache, now: () => currentTime })
    assert.equal(res1?.password, 'pass1')

    // Update the file on disk, but within 5s it should return the cached entry
    fs.writeFileSync(
      serviceFile,
      JSON.stringify({ url: 'http://127.0.0.1:49374', pid: 12345, password: 'pass2' })
    )
    const res2 = resolveOpencodeService({ env, cache, now: () => currentTime + 3000 })
    assert.equal(res2?.password, 'pass1')

    // After 5s expiry, cache is bypassed and new entry is read
    const res3 = resolveOpencodeService({ env, cache, now: () => currentTime + 5001 })
    assert.equal(res3?.password, 'pass2')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('opencode-bridge: a missing/rotating service.json (first read bad, second good) is handled by the retry', () => {
  let callCount = 0
  const readFileFn = () => {
    callCount++
    if (callCount === 1) {
      throw new Error('EBUSY: resource locked or being rewritten')
    }
    return JSON.stringify({ url: 'http://127.0.0.1:49374', pid: 99, password: 'recovered-password' })
  }

  const env = { AGENT_HUB_OPENCODE_SERVICE_FILE: '/dummy/path/service.json' }
  const res = resolveOpencodeService({ env, readFileFn, cache: {} })
  assert.equal(callCount, 2)
  assert.deepEqual(res, {
    url: 'http://127.0.0.1:49374',
    password: 'recovered-password',
  })
})

test('opencode-bridge: resolveOpencodeService never throws on completely missing or invalid file', () => {
  const env = { AGENT_HUB_OPENCODE_SERVICE_FILE: '/nonexistent/path/service.json' }
  const res = resolveOpencodeService({ env, cache: {} })
  assert.equal(res, null)

  const badReadFn = () => 'not-json-content'
  const resBad = resolveOpencodeService({ env, readFileFn: badReadFn, cache: {} })
  assert.equal(resBad, null)
})

test('opencode-bridge: canWake is false by default (env flag off) and true when AGENT_HUB_OPENCODE_BRIDGE=1 + supported version + resolvable service', () => {
  const tmpDir = makeTempServiceDir()
  try {
    const serviceFile = path.join(tmpDir, 'service.json')
    fs.writeFileSync(
      serviceFile,
      JSON.stringify({ url: 'http://127.0.0.1:49374', password: 'secret' })
    )

    const origin = {
      harness: 'opencode',
      sessionId: 'sess-123',
    }

    // Default: env flag off
    const defaultBridge = opencodeBridge({
      env: { AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile },
      version: '2.0.11',
    })
    assert.equal(defaultBridge.canWake(origin), false)

    // Bridge enabled + supported version + resolvable service -> true
    const enabledBridge = opencodeBridge({
      env: {
        AGENT_HUB_OPENCODE_BRIDGE: '1',
        AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile,
      },
      version: '2.0.11',
    })
    assert.equal(enabledBridge.canWake(origin), true)

    // Version in origin supported -> true
    const bridgeWithoutVersionOption = opencodeBridge({
      env: {
        AGENT_HUB_OPENCODE_BRIDGE: '1',
        AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile,
      },
    })
    assert.equal(
      bridgeWithoutVersionOption.canWake({ ...origin, version: '2.0.0' }),
      true
    )

    // Unsupported version (< 2.0.0) -> false
    assert.equal(
      enabledBridge.canWake({ ...origin, version: '1.9.0' }),
      false
    )

    // Missing session ID -> false
    assert.equal(
      enabledBridge.canWake({ harness: 'opencode', sessionId: '' }),
      false
    )
    assert.equal(
      enabledBridge.canWake({ harness: 'opencode' }),
      false
    )

    // Different harness -> false
    assert.equal(
      enabledBridge.canWake({ harness: 'claude-code', sessionId: 'sess-123' }),
      false
    )

    // Missing service credential -> false
    const noServiceBridge = opencodeBridge({
      env: {
        AGENT_HUB_OPENCODE_BRIDGE: '1',
        AGENT_HUB_OPENCODE_SERVICE_FILE: path.join(tmpDir, 'nonexistent.json'),
      },
      version: '2.0.11',
    })
    assert.equal(noServiceBridge.canWake(origin), false)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('opencode-bridge: wake posts to the exact URL with Basic auth and body { text, resume: true }, and truncates a long summary', async () => {
  const tmpDir = makeTempServiceDir()
  try {
    const serviceFile = path.join(tmpDir, 'service.json')
    fs.writeFileSync(
      serviceFile,
      JSON.stringify({ url: 'http://127.0.0.1:49374', password: 'my-password' })
    )

    let capturedUrl = null
    let capturedInit = null
    const fakeFetch = async (url, init) => {
      capturedUrl = url
      capturedInit = init
      return {
        ok: true,
        status: 200,
        text: async () => '{"ok":true}',
      }
    }

    const bridge = opencodeBridge({
      env: {
        AGENT_HUB_OPENCODE_BRIDGE: '1',
        AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile,
      },
      fetchFn: fakeFetch,
      version: '2.0.11',
    })

    const origin = { harness: 'opencode', sessionId: 'sess-abc' }
    const longSummary = 'X'.repeat(500)
    const payload = {
      jobId: 'job-999',
      summary: longSummary,
    }

    const outcome = await bridge.wake(origin, payload)
    assert.equal(outcome.delivered, true)
    assert.equal(outcome.status, 200)

    assert.equal(capturedUrl, 'http://127.0.0.1:49374/api/session/sess-abc/prompt')
    assert.equal(capturedInit.method, 'POST')
    assert.equal(capturedInit.headers['Content-Type'], 'application/json')

    const expectedAuth = 'Basic ' + Buffer.from('opencode:my-password').toString('base64')
    assert.equal(capturedInit.headers['Authorization'], expectedAuth)

    const parsedBody = JSON.parse(capturedInit.body)
    assert.equal(parsedBody.resume, true)
    assert.ok(parsedBody.text.includes('job-999'))
    // Long summary must be truncated to ~300 chars
    assert.ok(parsedBody.text.includes('X'.repeat(300)))
    assert.equal(parsedBody.text.includes('X'.repeat(301)), false)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('opencode-bridge: a non-2xx and a rejected fetch both return delivered:false without throwing', async () => {
  const tmpDir = makeTempServiceDir()
  try {
    const serviceFile = path.join(tmpDir, 'service.json')
    fs.writeFileSync(
      serviceFile,
      JSON.stringify({ url: 'http://127.0.0.1:49374', password: 'pwd' })
    )

    // Non-2xx response
    const fetch500 = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })

    const bridge500 = opencodeBridge({
      env: {
        AGENT_HUB_OPENCODE_BRIDGE: '1',
        AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile,
      },
      fetchFn: fetch500,
      version: '2.0.11',
    })

    const origin = { harness: 'opencode', sessionId: 'sess-err' }
    const payload = { jobId: 'job-500', summary: 'failed job' }

    const res500 = await bridge500.wake(origin, payload)
    assert.equal(res500.delivered, false)
    assert.equal(res500.status, 500)
    assert.ok(res500.reason)

    // Rejected fetch (network error)
    const fetchReject = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:49374')
    }

    const bridgeReject = opencodeBridge({
      env: {
        AGENT_HUB_OPENCODE_BRIDGE: '1',
        AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile,
      },
      fetchFn: fetchReject,
      version: '2.0.11',
    })

    const resReject = await bridgeReject.wake(origin, payload)
    assert.equal(resReject.delivered, false)
    assert.match(resReject.reason, /ECONNREFUSED/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('opencode-bridge: bridgeSupportsWake stays false when the flag is off', () => {
  // Flag unset
  assert.equal(bridgeSupportsWake('opencode'), false)
  assert.equal(bridgeSupportsWake('opencode', { version: '2.0.11' }), false)
  assert.equal(bridgeSupportsWake('opencode', { version: '1.0.0' }), false)

  // Flag explicitly 0
  const envOff = { AGENT_HUB_OPENCODE_BRIDGE: '0' }
  assert.equal(bridgeSupportsWake('opencode', { version: '2.0.11', env: envOff }), false)

  // Flag on (1) + supported version -> true
  const envOn = { AGENT_HUB_OPENCODE_BRIDGE: '1' }
  assert.equal(bridgeSupportsWake('opencode', { version: '2.0.11', env: envOn }), true)
  assert.equal(bridgeSupportsWake('opencode', { version: '2.0.0', env: envOn }), true)

  // Flag on (1) + unsupported version -> false
  assert.equal(bridgeSupportsWake('opencode', { version: '1.0.0', env: envOn }), false)
  assert.equal(bridgeSupportsWake('opencode', { version: null, env: envOn }), false)

  // resolveBridge respects flag and version
  const bridgeOff = resolveBridge('opencode', { version: '2.0.11', env: envOff })
  assert.equal(bridgeOff.id, 'noop')
  assert.equal(bridgeOff.canWake(), false)

  const bridgeOn = resolveBridge('opencode', { version: '2.0.11', env: envOn })
  assert.equal(bridgeOn.id, 'opencode')
})

test('opencode-bridge: wake performs a real HTTP POST to the local server', async () => {
  const tmpDir = makeTempServiceDir()
  let server
  try {
    let requestCount = 0
    let lastReq = null
    let lastBody = null

    server = http.createServer((req, res) => {
      requestCount++
      let body = ''
      req.on('data', chunk => {
        body += chunk.toString()
      })
      req.on('end', () => {
        lastReq = req
        lastBody = body
        if (req.url.includes('err')) {
          res.writeHead(500)
          res.end('Error')
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        }
      })
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const url = `http://127.0.0.1:${port}`

    const serviceFile = path.join(tmpDir, 'service.json')
    fs.writeFileSync(
      serviceFile,
      JSON.stringify({ url, password: 'real-password' })
    )

    const bridge = opencodeBridge({
      env: {
        AGENT_HUB_OPENCODE_BRIDGE: '1',
        AGENT_HUB_OPENCODE_SERVICE_FILE: serviceFile,
      },
      version: '2.0.11',
    })

    const origin = { harness: 'opencode', sessionId: 'sess-real' }
    const payload = { jobId: 'job-real', summary: 'real summary' }

    const outcome = await bridge.wake(origin, payload)

    assert.equal(outcome.delivered, true)
    assert.equal(outcome.status, 200)

    assert.equal(lastReq.method, 'POST')
    assert.equal(lastReq.url, '/api/session/sess-real/prompt')
    assert.equal(lastReq.headers['content-type'], 'application/json')

    const expectedAuth = 'Basic ' + Buffer.from('opencode:real-password').toString('base64')
    assert.equal(lastReq.headers['authorization'], expectedAuth)

    const parsedBody = JSON.parse(lastBody)
    assert.equal(parsedBody.resume, true)
    assert.ok(parsedBody.text.includes('job-real'))

    // Now test 500 error
    const originErr = { harness: 'opencode', sessionId: 'sess-err' }
    const outcomeErr = await bridge.wake(originErr, payload)

    assert.equal(outcomeErr.delivered, false)
    assert.equal(outcomeErr.status, 500)

  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve))
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
