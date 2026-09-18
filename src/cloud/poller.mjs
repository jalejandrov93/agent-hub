import crypto from 'node:crypto'
import { appendStdout, updateResult, readResult } from '../jobstore.mjs'

export const MIN_INTERVAL_MS = 5000
export const MAX_INTERVAL_MS = 60000
export const BACKOFF_FACTOR = 1.5

// A misbehaving server that keeps returning the same nextPageToken must never
// hang a poll tick, so one tick drains at most this many pages.
const MAX_PAGES_PER_TICK = 20

// Dedup memory is bounded: a long session must not grow result.json forever.
const MAX_SEEN_ACTIVITY_IDS = 500

/**
 * True when a remote session state means "waiting for someone else" rather
 * than "working". Prefer the adapter's own predicate; the prefix/PAUSED
 * fallback keeps this correct for adapters that predate isWaitingState.
 * Exported so job_wait can apply the exact same definition to a stored
 * record — one definition, two call sites, no drift.
 */
export function isWaitingRemoteState(adapter, state) {
  if (adapter?.isWaitingState?.(state)) return true
  return typeof state === 'string' && (state.startsWith('AWAITING_') || state === 'PAUSED')
}

/**
 * A stable identity for an activity. Prefer the API's own name/id; when an
 * activity carries neither, derive one from its content so it is still
 * recognised on the next tick. Without this the activity is "new" forever,
 * its line is re-appended to stdout.log every tick and the backoff never grows.
 */
function activityIdentity(activity) {
  const explicit = activity?.name ?? activity?.id
  if (explicit != null) return explicit
  const createTime = typeof activity?.createTime === 'string' ? activity.createTime : ''
  const description = typeof activity?.description === 'string' ? activity.description : ''
  if (createTime.length > 0 || description.length > 0) return `anon:${createTime}:${description}`
  return `anon:${crypto.createHash('sha1').update(JSON.stringify(activity ?? null)).digest('hex')}`
}

export const STATE_INTERVALS = {
  QUEUED: { minIntervalMs: 5000, maxIntervalMs: 5000, min: 5000, max: 5000, valueOf() { return 5000 } },
  PLANNING: { minIntervalMs: 5000, maxIntervalMs: 5000, min: 5000, max: 5000, valueOf() { return 5000 } },
  IN_PROGRESS: { minIntervalMs: 5000, maxIntervalMs: 15000, min: 5000, max: 15000, valueOf() { return 5000 } },
  AWAITING_PLAN_APPROVAL: { minIntervalMs: 30000, maxIntervalMs: 60000, min: 30000, max: 60000, valueOf() { return 30000 } },
  AWAITING_USER_FEEDBACK: { minIntervalMs: 30000, maxIntervalMs: 60000, min: 30000, max: 60000, valueOf() { return 30000 } },
  PAUSED: { minIntervalMs: 300000, maxIntervalMs: 300000, min: 300000, max: 300000, valueOf() { return 300000 } },
}

export function intervalForState(state, options = {}) {
  const opts = typeof options === 'number' ? { current: options } : options
  const cfg = STATE_INTERVALS[state] ?? {
    minIntervalMs: MIN_INTERVAL_MS,
    maxIntervalMs: MAX_INTERVAL_MS,
  }
  const minIntervalMs = cfg.minIntervalMs ?? MIN_INTERVAL_MS
  const maxIntervalMs = cfg.maxIntervalMs ?? MAX_INTERVAL_MS
  const backoffFactor = opts.backoffFactor ?? BACKOFF_FACTOR

  if (opts.current === undefined) {
    return minIntervalMs
  }

  if (opts.sawNewActivity) {
    return minIntervalMs
  }

  if (opts.current < minIntervalMs) {
    return minIntervalMs
  }

  return Math.min(opts.current * backoffFactor, maxIntervalMs)
}

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
  readResultFn = readResult,
}) {
  const session = await client.getSession({ apiKey, sessionId })

  let currentRemote = remote
  try {
    currentRemote = readResultFn(jobId, env)?.remote ?? remote
  } catch {
    // no persisted record (unit tests) — fall back to the passed snapshot
  }

  const isWaiting = isWaitingRemoteState(adapter, session.state)

  let pageToken = cursor
  let lastToken = cursor
  const activities = []
  let pages = 0

  if (!isWaiting) {
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
  }

  const seenIds = Array.isArray(currentRemote.seenActivityIds ?? remote.seenActivityIds)
    ? (currentRemote.seenActivityIds ?? remote.seenActivityIds)
    : []
  const seen = new Set(seenIds)
  const seenActivityIds = [...seen]
  const newActivities = activities.filter((activity) => !seen.has(activityIdentity(activity)))
  for (const activity of newActivities) {
    const id = activityIdentity(activity)
    if (!seen.has(id)) {
      seen.add(id)
      seenActivityIds.push(id)
    }
  }
  // Keep only the most recent identities so the record stays bounded.
  const cappedSeenActivityIds = seenActivityIds.slice(-MAX_SEEN_ACTIVITY_IDS)

  const summary = adapter.summarizeActivities(newActivities)
  const lines = Array.isArray(summary.lines) ? summary.lines : []
  const sawNewActivity = newActivities.length > 0

  if (lines.length > 0) {
    appendStdoutFn(jobId, lines.join('\n') + '\n', env)
  }

  // Re-read immediately before writing: the remote block may have changed
  // during the network round trip (a job_reply, another process). Spread the
  // CURRENT block and overwrite only the fields this tick owns, so a concurrent
  // write is not silently reverted.
  try {
    currentRemote = readResultFn(jobId, env)?.remote ?? currentRemote
  } catch {
    // no persisted record (unit tests) — fall back to the passed snapshot
  }

  // The working branch and PR url can surface on any tick, so they belong to
  // this tick's field set. `?? currentRemote.x` keeps a value already learned
  // on an earlier tick from being erased when a later tick reports null.
  const branch = adapter.branchFromSession?.(session) ?? null
  const prUrl = summary?.prUrl ?? adapter.prUrlFromSession?.(session) ?? null

  const nowIso = new Date(nowFn()).toISOString()
  const stateChanged = session.state !== (currentRemote.state ?? null)
  const remoteUpdate = {
    ...currentRemote,
    state: session.state,
    // First observation of the current state — lets callers distinguish a
    // session waiting 30s from one waiting 3h. Preserved across ticks that
    // report the same state.
    stateSince: stateChanged ? nowIso : (currentRemote.stateSince ?? nowIso),
    // Last tick that surfaced genuinely new remote activity (not merely a
    // poll that re-read the same session). Sticky: never erased by quiet ticks.
    lastActivityAt: sawNewActivity ? nowIso : (currentRemote.lastActivityAt ?? null),
    branch: branch ?? currentRemote.branch ?? null,
    prUrl: prUrl ?? currentRemote.prUrl ?? null,
    activityCursor: lastToken,
    seenActivityIds: cappedSeenActivityIds,
    lastPolledAt: nowIso,
  }
  if (isWaiting) {
    remoteUpdate.pollingStoppedReason = 'awaiting_interaction'
  } else if (currentRemote.pollingStoppedReason === 'awaiting_interaction') {
    remoteUpdate.pollingStoppedReason = null
  }

  updateResultFn(
    jobId,
    {
      // remote_state mirrors remote.state as a top-level SQL-friendly index.
      // The semantic source of truth stays remote.state; readers must not
      // treat the two as independent fields that can legitimately diverge.
      remote_state: session.state,
      remote: remoteUpdate,
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

    // P0.2: a waiting state is a real result, not a reason to keep polling.
    // Returning here (instead of slow-polling forever) hands control to the
    // supervisor/human via job_wait's waiting signal or jules_check's
    // attention fields. This is what makes pollingStoppedReason true rather
    // than descriptive: after this return nothing polls again on its own.
    // Model A (confirmed): jules_interact/job_reply clear the reason but
    // NEVER restart a poller — post-interaction observation belongs to the
    // caller (jules_wait/jules_check) or the future supervisor, which owns
    // the watch lease (see docs/execution-contract.md §7).
    if (isWaitingRemoteState(adapter, tick.state)) {
      return { outcome: 'waiting', state: tick.state, summary: tick.summary, session: tick.session, apiError: null }
    }

    await sleepFn(interval)
    if (STATE_INTERVALS[tick.state]) {
      interval = intervalForState(tick.state, {
        current: interval,
        sawNewActivity: tick.sawNewActivity,
        backoffFactor,
      })
    } else {
      interval = nextInterval(interval, {
        sawNewActivity: tick.sawNewActivity,
        minIntervalMs,
        maxIntervalMs,
        backoffFactor,
      })
    }
  }
}
