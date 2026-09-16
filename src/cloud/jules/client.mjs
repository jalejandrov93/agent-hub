export const DEFAULT_BASE_URL = 'https://jules.googleapis.com/v1alpha'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000

/**
 * Error raised for every failed Jules call, whether the HTTP layer answered
 * with a non-2xx status or fetch itself rejected. `status: 0` marks the
 * transport failure (no response), and `cause` keeps the original error so
 * callers can tell DNS/TLS/socket problems apart from API rejections.
 */
export class JulesApiError extends Error {
  constructor(message, { status, body, endpoint, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'JulesApiError'
    this.status = status
    this.body = body
    this.endpoint = endpoint
  }
}

/**
 * A session id can arrive bare ('abc') or as the API's resource name
 * ('sessions/abc'); both must resolve to the same URL.
 */
function bareSessionId(sessionId) {
  const value = String(sessionId ?? '')
  return value.startsWith('sessions/') ? value.slice('sessions/'.length) : value
}

/**
 * Concatenate the base path instead of using `new URL(path, base)`: a leading
 * '/' in the path would be root-relative and silently drop the '/v1alpha'
 * segment of the base.
 */
function buildUrl(baseUrl, path, query) {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  let url = `${base}${path}`
  if (query) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value))
    }
    const qs = params.toString()
    if (qs) url += `?${qs}`
  }
  return url
}

async function request({ apiKey, method, path, query, body, baseUrl, fetchImpl, timeoutMs }) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const headers = { 'X-Goog-Api-Key': apiKey }
  // Without a signal a connection that hangs open parks the caller inside
  // `await` forever, so the polling loop's own deadline can never fire.
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let response
  try {
    response = await doFetch(buildUrl(baseUrl, path, query), init)
  } catch (error) {
    throw new JulesApiError(`Jules request failed: ${method} ${path}`, {
      status: 0,
      body: null,
      endpoint: path,
      cause: error,
    })
  }

  const raw = await response.text()
  let parsed = raw
  if (raw === '') parsed = null
  else {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
  }

  if (!response.ok) {
    throw new JulesApiError(`Jules API responded ${response.status} on ${path}`, {
      status: response.status,
      body: parsed,
      endpoint: path,
    })
  }
  return parsed
}

export function listSources({ apiKey, pageSize, pageToken, baseUrl, fetchImpl, timeoutMs } = {}) {
  return request({ apiKey, method: 'GET', path: '/sources', query: { pageSize, pageToken }, baseUrl, fetchImpl, timeoutMs })
}

export function createSession({
  apiKey,
  prompt,
  source,
  startingBranch,
  title,
  requirePlanApproval,
  automationMode,
  baseUrl,
  fetchImpl,
  timeoutMs,
} = {}) {
  // An alpha API is entitled to reject an empty githubRepoContext, so only
  // attach it when there is an actual branch to name.
  const sourceContext = { source }
  if (typeof startingBranch === 'string' && startingBranch.length > 0) {
    sourceContext.githubRepoContext = { startingBranch }
  }
  const body = { prompt, sourceContext }
  if (title !== undefined) body.title = title
  if (requirePlanApproval !== undefined) body.requirePlanApproval = requirePlanApproval
  if (automationMode !== undefined) body.automationMode = automationMode
  return request({ apiKey, method: 'POST', path: '/sessions', body, baseUrl, fetchImpl, timeoutMs })
}

export function getSession({ apiKey, sessionId, baseUrl, fetchImpl, timeoutMs } = {}) {
  return request({ apiKey, method: 'GET', path: `/sessions/${bareSessionId(sessionId)}`, baseUrl, fetchImpl, timeoutMs })
}

export function listActivities({ apiKey, sessionId, pageSize, pageToken, baseUrl, fetchImpl, timeoutMs } = {}) {
  return request({
    apiKey,
    method: 'GET',
    path: `/sessions/${bareSessionId(sessionId)}/activities`,
    query: { pageSize, pageToken },
    baseUrl,
    fetchImpl,
    timeoutMs,
  })
}

export function sendMessage({ apiKey, sessionId, prompt, baseUrl, fetchImpl, timeoutMs } = {}) {
  return request({
    apiKey,
    method: 'POST',
    path: `/sessions/${bareSessionId(sessionId)}:sendMessage`,
    body: { prompt },
    baseUrl,
    fetchImpl,
    timeoutMs,
  })
}

export function approvePlan({ apiKey, sessionId, baseUrl, fetchImpl, timeoutMs } = {}) {
  return request({
    apiKey,
    method: 'POST',
    path: `/sessions/${bareSessionId(sessionId)}:approvePlan`,
    body: {},
    baseUrl,
    fetchImpl,
    timeoutMs,
  })
}
