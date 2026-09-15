import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTail, appendEvent } from './eventlog.mjs'
import { listJobs } from './jobstore.mjs'
import { readCache, agentsStatus, pingAgent, breakerStatus } from './preflight.mjs'
import { cancelJob } from './jobrunner.mjs'
import { paths, DEFAULT_TIMEOUTS_S, CIRCUIT_BREAKER, PREFLIGHT_TTL_MS, WRITE_ALLOWLIST, MODEL_REGISTRY } from './config.mjs'
import { runDiscovery, readDiscovery } from './discovery.mjs'
import { readOverrides, setOverride, clearOverride, overrideKey } from './overrides.mjs'
import { DELEGATION_MAP } from './router.mjs'
import { defaultPairs } from './tools/agents.mjs'
import { runCommand } from './process.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HTML_PATH = path.join(HERE, 'dashboard.html')

export function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

// Hostnames a request is allowed to address this dashboard as. Anything else
// (an attacker-controlled DNS name that resolves to 127.0.0.1, e.g. DNS
// rebinding) is rejected regardless of remote address.
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

// Extract the hostname portion of a Host header, stripping the port and any
// IPv6 brackets (e.g. "[::1]:7777" -> "::1"). Returns null when there is
// nothing usable (missing header, or a malformed IPv6 literal).
function hostnameFromHostHeader(hostHeader) {
  if (!hostHeader) return null
  let h = hostHeader.trim()
  if (!h) return null
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? null : h.slice(1, end).toLowerCase()
  }
  // A single colon is "host:port"; more than one, unbracketed, is a bare
  // IPv6 literal like "::1" (no port is possible in that form) — leave it be.
  const colonCount = (h.match(/:/g) || []).length
  if (colonCount === 1) {
    const idx = h.indexOf(':')
    if (/^\d+$/.test(h.slice(idx + 1))) h = h.slice(0, idx)
  }
  return h.toLowerCase()
}

/** Host header validation against DNS rebinding: hostname must be a loopback name, any port. Missing header is rejected. */
export function isAllowedHost(hostHeader) {
  const hostname = hostnameFromHostHeader(hostHeader)
  return hostname !== null && ALLOWED_HOSTNAMES.has(hostname)
}

/** True when the media type (ignoring parameters like charset) is exactly application/json. */
export function isJsonContentType(contentType) {
  if (!contentType) return false
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  return mediaType === 'application/json'
}

/** A missing Origin header is allowed (same-origin browser navigations, and non-browser callers, don't send one). Present, it must be a loopback origin. */
export function isAllowedOrigin(origin) {
  if (origin == null) return true
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:') return false
    const hostname = u.hostname.toLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** State for GET /api/state: agents (from the preflight cache), jobs, and the last 200 events (subagents included). */
export function buildState({ env = process.env } = {}) {
  const discovery = readDiscovery(env)
  const agents = Object.values(readCache(env)).map((a) => ({
    ...a,
    dataPolicy: MODEL_REGISTRY[a.agent]?.[a.model]?.dataPolicy ?? 'unknown',
    binPath: discovery[a.agent]?.binPath ?? null,
    cliVersion: discovery[a.agent]?.version ?? null,
  }))
  const jobs = listJobs(env)
  const events = readTail({ n: 200, env })
  const subagents = events.filter((e) => e.source === 'claude-hook')
  return { agents, jobs, subagents, events }
}

/** Read-only snapshot for GET /api/config: everything the Config panel renders, plus current overrides/breaker state. */
export function buildConfig({ env = process.env } = {}) {
  return {
    delegationMap: DELEGATION_MAP,
    discovery: readDiscovery(env),
    timeouts: DEFAULT_TIMEOUTS_S,
    breaker: {
      windowMs: CIRCUIT_BREAKER.windowMs,
      failureThreshold: CIRCUIT_BREAKER.failureThreshold,
      failureKinds: [...CIRCUIT_BREAKER.failureKinds],
      immediateKinds: [...CIRCUIT_BREAKER.immediateKinds],
    },
    ttlMs: PREFLIGHT_TTL_MS,
    agentHubHome: paths(env).home,
    writeAllowlist: WRITE_ALLOWLIST,
    breakerState: defaultPairs().map((p) => breakerStatus({ agent: p.agent, model: p.model, env })),
    overrides: readOverrides(env),
  }
}

const MAX_BODY_BYTES = 64 * 1024

/**
 * Buffer and parse a request body as JSON; {} for an empty body. Rejects
 * (never throws synchronously) with a tagged error for a payload over
 * MAX_BODY_BYTES or malformed JSON, so a write route can answer 413/400
 * instead of silently treating either as {}.
 */
function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    let oversize = false
    req.on('data', (chunk) => {
      // Once over the cap, stop buffering (free the memory) but keep
      // draining the stream — destroying `req` would tear down the shared
      // socket and the response below would never reach the client.
      if (oversize) return
      size += chunk.length
      if (size > maxBytes) {
        oversize = true
        data = ''
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (oversize) {
        const err = new Error('payload too large')
        err.statusCode = 413
        err.expose = 'payload too large'
        return reject(err)
      }
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        const err = new Error('invalid JSON body')
        err.statusCode = 400
        err.expose = 'invalid JSON body'
        reject(err)
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Map a readJsonBody rejection (413/400) or a route-thrown error (500 default) to a JSON error response. */
function sendError(res, error) {
  const status = error?.statusCode ?? 500
  const message = error?.expose ?? String(error?.message ?? error)
  sendJson(res, status, { error: message })
}

export function createServer({ env = process.env, commandRunner = runCommand } = {}) {
  const sseClients = new Set()

  const server = http.createServer((req, res) => {
    const remoteAddress = req.socket.remoteAddress
    const url = new URL(req.url, 'http://localhost')

    // Every request (GET included) must address this dashboard by a loopback
    // hostname — otherwise a DNS-rebinding page could read state/config from
    // "inside" the browser's same-origin policy.
    if (!isAllowedHost(req.headers.host)) {
      return sendJson(res, 403, { error: 'forbidden: invalid Host header' })
    }

    // A browser can only be tricked into a "simple request" (no CORS
    // preflight) for GET/HEAD or a POST with one of a few whitelisted
    // Content-Types, none of which is application/json. So requiring
    // application/json on every write route forces a preflight, which this
    // server's lack of CORS headers will always fail — closing the
    // <form enctype="text/plain">/no-cors-fetch CSRF path.
    if (req.method !== 'GET') {
      if (!isLoopback(remoteAddress)) {
        return sendJson(res, 403, { error: 'forbidden: dashboard only accepts loopback connections' })
      }
      if (!isJsonContentType(req.headers['content-type'])) {
        return sendJson(res, 415, { error: 'unsupported media type: application/json required' })
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        return sendJson(res, 403, { error: 'forbidden: cross-origin request' })
      }
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(HTML_PATH, 'utf8'))
      return
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildState({ env })))
      return
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, buildConfig({ env }))
      return
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/)
    if (cancelMatch && req.method === 'POST') {
      cancelJob(cancelMatch[1], { env })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendError(res, error))
      return
    }

    if (url.pathname === '/api/agents/refresh' && req.method === 'POST') {
      readJsonBody(req)
        .then(async (body) => {
          const cwd = process.cwd()
          // ping:true is the only path that ever runs L3 — always exactly
          // one explicit agent+model pair, never a bulk refresh.
          if (body.ping === true) {
            if (!body.agent || !body.model) throw new Error('ping requires both "agent" and "model"')
            const entry = await pingAgent({ agent: body.agent, model: body.model, cwd, env, commandRunner })
            appendEvent(
              {
                kind: 'preflight',
                phase: 'ping',
                agent: body.agent,
                model: body.model,
                status: entry.status,
                ladderLevel: entry.ladderLevel,
                reason: entry.reason ?? null,
                summary: `${body.agent}:${body.model} L3 ping → ${entry.status}`,
              },
              { env }
            )
            return { results: [entry] }
          }
          let pairs = defaultPairs()
          if (body.agent) pairs = pairs.filter((p) => p.agent === body.agent)
          if (body.model) pairs = pairs.filter((p) => p.model === body.model)
          const results = await agentsStatus({ agents: pairs, cwd, env, commandRunner, refresh: true, announce: true })
          return { results }
        })
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendError(res, error))
      return
    }

    if (url.pathname === '/api/discovery/refresh' && req.method === 'POST') {
      runDiscovery({ env, commandRunner, force: true })
        .then((discovery) => sendJson(res, 200, discovery))
        .catch((error) => sendError(res, error))
      return
    }

    if (url.pathname === '/api/overrides' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          if (!body.agent || !body.model) throw new Error('overrides require both "agent" and "model"')
          const patch = {}
          if ('hold' in body) patch.hold = Boolean(body.hold)
          if (body.breakerReset === true) patch.breakerReset = new Date().toISOString()
          const entry = setOverride(overrideKey(body.agent, body.model), patch, env)
          sendJson(res, 200, entry)
        })
        .catch((error) => sendError(res, error))
      return
    }

    // Model ids contain '/' (e.g. opencode/muse-spark-1.3-contributor-free),
    // so the model segment must be URL-encoded by the caller and decoded here.
    const overrideMatch = url.pathname.match(/^\/api\/overrides\/([^/]+)\/(.+)$/)
    if (overrideMatch && req.method === 'DELETE') {
      const agent = decodeURIComponent(overrideMatch[1])
      const model = decodeURIComponent(overrideMatch[2])
      sendJson(res, 200, clearOverride(overrideKey(agent, model), env))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  // Tail events.jsonl (fs.watch on its directory, offset-tracked) and push
  // new lines to every connected SSE client as they are appended.
  const eventsFile = paths(env).eventsFile
  let offset = 0
  try {
    offset = fs.statSync(eventsFile).size
  } catch {
    offset = 0
  }

  function pushNewLines() {
    let stat
    try {
      stat = fs.statSync(eventsFile)
    } catch {
      return
    }
    if (stat.size < offset) offset = 0 // file was rotated/truncated
    if (stat.size <= offset) return

    const stream = fs.createReadStream(eventsFile, { start: offset, end: stat.size - 1, encoding: 'utf8' })
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk
    })
    stream.on('end', () => {
      offset = stat.size
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        for (const client of sseClients) client.write(`data: ${line}\n\n`)
      }
    })
  }

  let watcher = null
  try {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true })
    watcher = fs.watch(path.dirname(eventsFile), (_eventType, filename) => {
      if (filename === path.basename(eventsFile)) pushNewLines()
    })
  } catch {
    // fs.watch unavailable on this platform/mount — clients still get the heartbeat
  }

  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(': heartbeat\n\n')
  }, 15_000)
  heartbeat.unref?.()

  server.on('close', () => {
    clearInterval(heartbeat)
    watcher?.close()
  })

  return server
}

export function startDashboard({ port = 7777, env = process.env } = {}) {
  const server = createServer({ env })
  server.listen(port, '127.0.0.1', () => {
    console.error(`[agent-hub] dashboard listening on http://127.0.0.1:${port}`)
  })
  return server
}
