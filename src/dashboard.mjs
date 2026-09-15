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

/** Buffer and parse a request body as JSON; {} for an empty or malformed body (never throws). */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function createServer({ env = process.env, commandRunner = runCommand } = {}) {
  const sseClients = new Set()

  const server = http.createServer((req, res) => {
    const remoteAddress = req.socket.remoteAddress
    const url = new URL(req.url, 'http://localhost')

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
      if (!isLoopback(remoteAddress)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden: dashboard only accepts loopback connections' }))
        return
      }
      cancelJob(cancelMatch[1], { env })
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        })
        .catch((error) => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        })
      return
    }

    if (url.pathname === '/api/agents/refresh' && req.method === 'POST') {
      if (!isLoopback(remoteAddress)) return sendJson(res, 403, { error: 'forbidden: dashboard only accepts loopback connections' })
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
        .catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
      return
    }

    if (url.pathname === '/api/discovery/refresh' && req.method === 'POST') {
      if (!isLoopback(remoteAddress)) return sendJson(res, 403, { error: 'forbidden: dashboard only accepts loopback connections' })
      runDiscovery({ env, commandRunner, force: true })
        .then((discovery) => sendJson(res, 200, discovery))
        .catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
      return
    }

    if (url.pathname === '/api/overrides' && req.method === 'POST') {
      if (!isLoopback(remoteAddress)) return sendJson(res, 403, { error: 'forbidden: dashboard only accepts loopback connections' })
      readJsonBody(req)
        .then((body) => {
          if (!body.agent || !body.model) throw new Error('overrides require both "agent" and "model"')
          const patch = {}
          if ('hold' in body) patch.hold = Boolean(body.hold)
          if (body.breakerReset === true) patch.breakerReset = new Date().toISOString()
          const entry = setOverride(overrideKey(body.agent, body.model), patch, env)
          sendJson(res, 200, entry)
        })
        .catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
      return
    }

    // Model ids contain '/' (e.g. opencode/muse-spark-1.3-contributor-free),
    // so the model segment must be URL-encoded by the caller and decoded here.
    const overrideMatch = url.pathname.match(/^\/api\/overrides\/([^/]+)\/(.+)$/)
    if (overrideMatch && req.method === 'DELETE') {
      if (!isLoopback(remoteAddress)) return sendJson(res, 403, { error: 'forbidden: dashboard only accepts loopback connections' })
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
