/**
 * Thin fetch/EventSource client for the dashboard's JSON API. `EventSource`
 * is only referenced inside connectEvents()'s body, never at module top
 * level, so this file imports cleanly under `node --test`.
 */

async function request(method, url, body) {
  const opts = { method }
  // Every write route requires application/json regardless of whether it
  // carries a body — this also forces a CORS preflight, closing a
  // cross-site <form>/no-cors-fetch path.
  if (method !== 'GET') opts.headers = { 'Content-Type': 'application/json' }
  if (body !== undefined) opts.body = JSON.stringify(body)

  const res = await fetch(url, opts)
  const contentType = res.headers.get('content-type') || ''
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null

  if (!res.ok) {
    const message = (data && data.error) || `request failed with status ${res.status}`
    const error = new Error(message)
    error.status = res.status
    throw error
  }
  return data
}

/** GET /api/state -> {agents, jobs, subagents, events}. */
export function fetchState() {
  return request('GET', '/api/state')
}

/** GET /api/config -> Config. */
export function fetchConfig() {
  return request('GET', '/api/config')
}

/** POST /api/agents/refresh {agent?, model?, ping?} -> {results}. */
export function refreshAgents(opts = {}) {
  return request('POST', '/api/agents/refresh', opts)
}

/** POST /api/discovery/refresh -> Object<agent, DiscoveryEntry>. */
export function refreshDiscovery() {
  return request('POST', '/api/discovery/refresh')
}

/** POST /api/overrides {agent, model, hold?, breakerReset?} -> Override. */
export function setOverride({ agent, model, hold, breakerReset }) {
  return request('POST', '/api/overrides', { agent, model, hold, breakerReset })
}

/** DELETE /api/overrides/:agent/:model -> {cleared:true}. Model ids contain '/', so both segments are URL-encoded. */
export function clearOverride(agent, model) {
  return request('DELETE', `/api/overrides/${encodeURIComponent(agent)}/${encodeURIComponent(model)}`)
}

/** POST /api/jobs/:jobId/cancel -> object. */
export function cancelJob(jobId) {
  return request('POST', `/api/jobs/${encodeURIComponent(jobId)}/cancel`)
}

/** Wraps EventSource('/events'); returns a close() function. */
export function connectEvents({ onEvent, onConnection }) {
  let source
  try {
    source = new EventSource('/events')
  } catch {
    if (onConnection) onConnection('offline')
    return () => {}
  }

  if (onConnection) onConnection('connecting')

  source.onopen = () => {
    if (onConnection) onConnection('live')
  }

  source.onerror = () => {
    if (!onConnection) return
    onConnection(source.readyState === EventSource.CONNECTING ? 'reconnecting' : 'offline')
  }

  source.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data)
      if (onEvent) onEvent(event)
    } catch {
      // ignore heartbeats or malformed packets
    }
  }

  return () => source.close()
}
