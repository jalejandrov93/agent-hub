import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTail } from './eventlog.mjs'
import { listJobs } from './jobstore.mjs'
import { readCache } from './preflight.mjs'
import { cancelJob } from './jobrunner.mjs'
import { paths } from './config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HTML_PATH = path.join(HERE, 'dashboard.html')

export function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

/** State for GET /api/state: agents (from the preflight cache), jobs, and the last 200 events (subagents included). */
export function buildState({ env = process.env } = {}) {
  const agents = Object.values(readCache(env))
  const jobs = listJobs(env)
  const events = readTail({ n: 200, env })
  const subagents = events.filter((e) => e.source === 'claude-hook')
  return { agents, jobs, subagents, events }
}

export function createServer({ env = process.env } = {}) {
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
