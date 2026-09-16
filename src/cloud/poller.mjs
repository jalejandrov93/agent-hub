import { appendStdout, updateResult, readResult } from '../jobstore.mjs'

export const MIN_INTERVAL_MS = 5000
export const MAX_INTERVAL_MS = 60000
export const BACKOFF_FACTOR = 1.5

// A misbehaving server that keeps returning the same nextPageToken must never
// hang a poll tick, so one tick drains at most this many pages.
const MAX_PAGES_PER_TICK = 20

export function nextInterval(current, {
  sawNewActivity,
  minIntervalMs = MIN_INTERVAL_MS,
  maxIntervalMs = MAX_INTERVAL_MS,
  backoffFactor = BACKOFF_FACTOR,
} = {}) {
  if (sawNewActivity) return minIntervalMs
  return Math.min(current * backoffFactor, maxIntervalMs)
}

/**
 * One polling tick: read the remote session, drain any new activities from
 * `cursor`, stream them to the local stdout.log and persist the new cursor.
 * `remote` is the previous remote block so a caller can merge instead of
 * clobbering fields it does not own.
 *
 * `pageToken` paginates the FULL activity list, not an incremental feed, so a
 * drained tick comes back with no `nextPageToken` and the next tick would
 * re-read the same page. Dedup is therefore by activity identity
 * (`seenActivityIds`), never by cursor position — otherwise every line is
 * appended again and `sawNewActivity` stays true forever, which also freezes
 * the backoff.
 */
export async function pollOnce({
  jobId,
  apiKey,
  sessionId,
  cursor,
  remote = {},
  client,
  adapter,
  env = process.env,
  nowFn = Date.now,
  appendStdoutFn = appendStdout,
  updateResultFn = updateResult,
}) {
  const session = await client.getSession({ apiKey, sessionId })

  let pageToken = cursor
  let lastToken = cursor
  const activities = []
  let pages = 0
  while (pages < MAX_PAGES_PER_TICK) {
    const page = await client.listActivities({ apiKey, sessionId, pageToken })
    pages++
    const batch = Array.isArray(page?.activities) ? page.activities : []
    activities.push(...batch)
    if (page?.nextPageToken) {
      lastToken = page.nextPageToken
      pageToken = page.nextPageToken
    } else {
      break
    }
    // An empty page with a next token means there is nothing more to read
    // this tick; stop rather than chase a token with no data behind it.
    if (batch.length === 0) break
  }

  const seenIds = Array.isArray(remote.seenActivityIds) ? remote.seenActivityIds : []
  const seen = new Set(seenIds)
  const seenActivityIds = [...seen]
  // An activity with neither name nor id cannot be identified, so it can never
  // be proven a duplicate — treat it as new rather than silently dropping it.
  const newActivities = activities.filter((activity) => {
    const id = activity?.name ?? activity?.id
    return id == null || !seen.has(id)
  })
  for (const activity of newActivities) {
    const id = activity?.name ?? activity?.id
    if (id != null && !seen.has(id)) {
      seen.add(id)
      seenActivityIds.push(id)
    }
  }

  const summary = adapter.summarizeActivities(newActivities)
  const lines = Array.isArray(summary.lines) ? summary.lines : []
  const sawNewActivity = newActivities.length > 0

  if (lines.length > 0) {
    appendStdoutFn(jobId, lines.join('\n') + '\n', env)
  }

  updateResultFn(
    jobId,
    {
      remote: {
        ...remote,
        state: session.state,
        activityCursor: lastToken,
        seenActivityIds,
        lastPolledAt: new Date(nowFn()).toISOString(),
      },
    },
    env
  )

  return { state: session.state, cursor: lastToken, sawNewActivity, lines, summary, session }
}

/**
 * Poll a remote Jules session until it reaches a terminal state, the local job
 * is canceled, or timeoutMs elapses. The sleep/now functions are injected so
 * the loop is deterministic in tests and never touches real timers directly.
 */
export async function pollUntilTerminal({
  jobId,
  apiKey,
  sessionId,
  timeoutMs,
  client,
  adapter,
  env = process.env,
  nowFn = Date.now,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  appendStdoutFn = appendStdout,
  updateResultFn = updateResult,
  readResultFn = readResult,
  minIntervalMs = MIN_INTERVAL_MS,
  maxIntervalMs = MAX_INTERVAL_MS,
  backoffFactor = BACKOFF_FACTOR,
  maxConsecutiveErrors = 5,
}) {
  // The cancel check must run BEFORE the clock is read (a canceled job must
  // not spend quota), so the first read happens here; the deadline is then
  // pinned once and does not drift with the first in-loop cancel check.
  const initial = readResultFn(jobId, env)
  if (initial?.status === 'canceled') {
    return { outcome: 'canceled', state: null, summary: null, session: null, apiError: null }
  }
  const start = nowFn()

  let interval = minIntervalMs
  let consecutiveErrors = 0

  while (true) {
    const record = readResultFn(jobId, env)
    if (record?.status === 'canceled') {
      return { outcome: 'canceled', state: null, summary: null, session: null, apiError: null }
    }

    if (nowFn() - start >= timeoutMs) {
      return { outcome: 'timeout', state: null, summary: null, session: null, apiError: null }
    }

    const remote = record?.remote ?? {}
    let tick
    try {
      tick = await pollOnce({
        jobId,
        apiKey,
        sessionId,
        cursor: remote.activityCursor,
        remote,
        client,
        adapter,
        env,
        nowFn,
        appendStdoutFn,
        updateResultFn,
      })
      consecutiveErrors = 0
    } catch (error) {
      const status = error?.status
      // A bad key will not fix itself: fail immediately.
      if (status === 401 || status === 403) {
        return { outcome: 'failed', state: null, summary: null, session: null, apiError: error }
      }
      consecutiveErrors++
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { outcome: 'failed', state: null, summary: null, session: null, apiError: error }
      }
      // Transient (429/5xx/network): back off to the ceiling and keep trying
      // until the timeout, instead of burning through the error budget fast.
      interval = maxIntervalMs
      await sleepFn(interval)
      continue
    }

    if (adapter.isTerminalState(tick.state)) {
      // Decide from the session STATE: the completed activity may have been
      // consumed on an earlier tick (or never surfaced) while the state is
      // already terminal, and reading a summary flag would then misreport a
      // completed session as failed.
      const outcome = tick.state === 'COMPLETED' ? 'completed' : 'failed'
      return { outcome, state: tick.state, summary: tick.summary, session: tick.session, apiError: null }
    }

    await sleepFn(interval)
    interval = nextInterval(interval, {
      sawNewActivity: tick.sawNewActivity,
      minIntervalMs,
      maxIntervalMs,
      backoffFactor,
    })
  }
}
