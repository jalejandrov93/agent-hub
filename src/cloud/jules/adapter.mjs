export const id = 'jules'
export const remote = true

export const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED'])

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state)
}

/**
 * Validates and defaults the argument set for client.createSession. This is
 * NOT the HTTP body: it returns the flat keyword arguments (source,
 * startingBranch, ...) that createSession turns into the nested
 * `sourceContext` wire payload, so it must be spread into createSession
 * rather than passed straight to fetch.
 */
export function buildSessionRequest({
  prompt,
  source,
  startingBranch,
  title,
  requirePlanApproval = false,
  automationMode = 'AUTO_CREATE_PR',
} = {}) {
  if (!prompt) throw new Error('jules: prompt is required')
  if (!source) throw new Error('jules: source is required')
  const request = { prompt, source, startingBranch, requirePlanApproval, automationMode }
  if (title !== undefined) request.title = title
  return request
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The Jules alpha API nests outputs differently depending on the endpoint, so
 * accept either an array or a single object.
 */
function outputItems(outputs) {
  if (Array.isArray(outputs)) return outputs
  if (isPlainObject(outputs)) return [outputs]
  return []
}

/**
 * A real session output wraps its result in `changeSet.gitPatch`; a pull
 * request has only ever been observed behind automationMode AUTO_CREATE_PR,
 * so probe it defensively (and inside the change set) but never require it.
 */
function urlFromValue(value) {
  if (!isPlainObject(value)) return null
  const candidates = [value.pullRequest?.url, value.pullRequest?.uri, value.url]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

function firstOutputUrl(outputs) {
  for (const item of outputItems(outputs)) {
    if (!isPlainObject(item)) continue
    const url = urlFromValue(item) ?? urlFromValue(item.changeSet)
    if (url) return url
  }
  return null
}

/**
 * The session's working branch is nested differently across alpha shapes. Probe
 * the field names in priority order (an earlier field wins even if it lives on
 * a later output), reusing outputItems so a single object and an array behave
 * identically to the url traversal.
 */
function firstOutputBranch(outputs) {
  const items = outputItems(outputs).filter(isPlainObject)
  const probes = [
    (item) => item.pullRequest?.headRef,
    (item) => item.pullRequest?.head?.ref,
    (item) => item.pullRequest?.branch,
    (item) => item.branch,
    (item) => item.changeSet?.branch,
    (item) => item.changeSet?.pullRequest?.headRef,
  ]
  for (const probe of probes) {
    for (const item of items) {
      const value = probe(item)
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return null
}

/**
 * Map a wire change set (`{ source, gitPatch: { unidiffPatch, baseCommitId,
 * suggestedCommitMessage } }`) to the flat shape callers rely on. A missing
 * gitPatch still yields the four stable keys, all null.
 */
function normalizeChangeSet(changeSet) {
  const gitPatch = isPlainObject(changeSet?.gitPatch) ? changeSet.gitPatch : {}
  return {
    source: typeof changeSet?.source === 'string' ? changeSet.source : null,
    baseCommitId: typeof gitPatch.baseCommitId === 'string' ? gitPatch.baseCommitId : null,
    unifiedDiff: typeof gitPatch.unidiffPatch === 'string' ? gitPatch.unidiffPatch : null,
    suggestedCommitMessage: typeof gitPatch.suggestedCommitMessage === 'string' ? gitPatch.suggestedCommitMessage : null,
  }
}

/**
 * A change set lives in an activity's OPTIONAL `artifacts` array, not on the
 * activity itself. The last one wins, matching "the result of this activity".
 */
function changeSetFromArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return null
  let found = null
  for (const artifact of artifacts) {
    if (isPlainObject(artifact?.changeSet)) found = normalizeChangeSet(artifact.changeSet)
  }
  return found
}

function artifactUrl(artifact) {
  return urlFromValue(artifact) ?? urlFromValue(artifact.changeSet)
}

/** The session-level result: the last outputs[].changeSet, mapped flat, or null. */
export function changeSetFromSession(session) {
  let found = null
  for (const item of outputItems(session?.outputs)) {
    if (isPlainObject(item?.changeSet)) found = normalizeChangeSet(item.changeSet)
  }
  return found
}

/**
 * `agentMessaged` carries `agentMessage`; `userMessaged` was not observed in
 * the real API, so its `userMessage` is ASSUMED by symmetry with agentMessaged
 * and `message` is accepted as a fallback. The old `message`-only read never
 * matched a real payload.
 */
function messageOf(container) {
  const candidates = [container?.agentMessage, container?.userMessage, container?.message]
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate
  }
  return ''
}

function countDiffLines(diff) {
  if (typeof diff !== 'string' || diff.length === 0) return 0
  // A trailing newline terminates the last line; it does not introduce an
  // empty one, so strip exactly one before counting separators.
  return diff.replace(/\n$/, '').split('\n').length
}

/**
 * Real suggested commit messages are full multi-paragraph bodies (one observed
 * session returned ~2 KB), so only the subject line belongs in a streamed log
 * line. The full message still reaches the caller through summary.changeSet.
 */
function commitSubject(message) {
  const subject = String(message).split('\n', 1)[0].trim()
  return subject.length > 120 ? subject.slice(0, 117) + '…' : subject
}

function changeSetLineFor(changeSet) {
  if (!isPlainObject(changeSet)) return null
  const message =
    typeof changeSet.suggestedCommitMessage === 'string' && changeSet.suggestedCommitMessage.trim().length > 0
      ? commitSubject(changeSet.suggestedCommitMessage)
      : '(no commit message)'
  return `[jules] change set: ${message} (${countDiffLines(changeSet.unifiedDiff)} diff lines)`
}

function bashOutputLine(bashOutput) {
  if (!isPlainObject(bashOutput)) return null
  const command = typeof bashOutput.command === 'string' ? bashOutput.command.trim() : ''
  const output = typeof bashOutput.output === 'string' ? bashOutput.output.replace(/\s+/g, ' ').trim() : ''
  if (command && output) return `[jules] bash: ${command} — ${output}`
  if (command) return `[jules] bash: ${command}`
  if (output) return `[jules] bash output: ${output}`
  return null
}

// Every activity carries these envelope keys plus exactly one type key. An
// unrecognised type still gets one honest line instead of disappearing.
const ACTIVITY_ENVELOPE_KEYS = new Set(['name', 'id', 'createTime', 'originator', 'artifacts'])

function unknownTypeKey(activity) {
  for (const key of Object.keys(activity)) {
    if (!ACTIVITY_ENVELOPE_KEYS.has(key)) return key
  }
  return null
}

/**
 * The activity envelope is alpha. The type is detected by which key is present;
 * plan steps live at `planGenerated.plan.steps`, and an unknown shape degrades
 * to its type key name rather than throwing or vanishing.
 */
function linesForActivity(activity) {
  if (activity.planGenerated != null) {
    const plan = activity.planGenerated.plan
    const steps = Array.isArray(plan?.steps) ? plan.steps : []
    const lines = [`[jules] plan generated: ${steps.length} step(s)`]
    steps.forEach((step, index) => {
      lines.push(`[jules]   ${index + 1}. ${step?.title ?? ''}`)
    })
    return lines
  }
  if (activity.planApproved != null) return ['[jules] plan approved']
  if (activity.userMessaged != null) return [`[jules] user: ${messageOf(activity.userMessaged)}`]
  if (activity.agentMessaged != null) return [`[jules] agent: ${messageOf(activity.agentMessaged)}`]
  if (activity.progressUpdated != null) {
    const { title = '', description } = activity.progressUpdated
    const hasTitle = typeof title === 'string' && title.length > 0
    const hasDescription = typeof description === 'string' && description.length > 0
    // Observed live: most progressUpdated activities are an empty {} whose only
    // payload is a diff snapshot in `artifacts` (83 of 91 in one session). They
    // say nothing on their own, so they get no line — the snapshot speaks for
    // itself through artifactLines.
    if (!hasTitle && !hasDescription) return []
    const suffix = hasDescription ? ` — ${description}` : ''
    return [`[jules] progress: ${title}${suffix}`]
  }
  // sessionCompleted is empty in the real API — the outputs live in artifacts,
  // which activityLines renders right after this line.
  if (activity.sessionCompleted != null) return ['[jules] session completed']
  if (activity.sessionFailed != null) {
    const reason = activity.sessionFailed.reason
    return [typeof reason === 'string' && reason.length > 0 ? `[jules] session failed: ${reason}` : '[jules] session failed']
  }
  const typeKey = unknownTypeKey(activity)
  if (typeKey) return [`[jules] unknown activity: ${typeKey}`]
  return []
}

/**
 * `tracker` carries the size of the last diff snapshot reported, across the
 * activities of one activityLines call. While a session runs, Jules attaches a
 * CUMULATIVE diff snapshot to almost every step — without a commit message,
 * which only the final change set gets. Reported one by one that is dozens of
 * near-identical lines, so a snapshot is reported as work in progress, and only
 * when its size changed. A change set that does carry a commit message is the
 * finished result and is always reported as a change set.
 */
function artifactLines(artifacts, tracker = { lastSnapshotLines: null }) {
  if (!Array.isArray(artifacts)) return []
  const lines = []
  for (const artifact of artifacts) {
    if (!isPlainObject(artifact)) continue
    if (isPlainObject(artifact.changeSet)) {
      const changeSet = normalizeChangeSet(artifact.changeSet)
      const message = changeSet?.suggestedCommitMessage
      if (typeof message === 'string' && message.trim().length > 0) {
        const line = changeSetLineFor(changeSet)
        if (line) lines.push(line)
      } else {
        const size = countDiffLines(changeSet?.unifiedDiff)
        if (size !== tracker.lastSnapshotLines) {
          lines.push(`[jules] working: ${size} diff lines so far`)
          tracker.lastSnapshotLines = size
        }
      }
    }
    if (artifact.bashOutput != null) {
      const line = bashOutputLine(artifact.bashOutput)
      if (line) lines.push(line)
    }
    const url = artifactUrl(artifact)
    if (url) lines.push(`[jules] pull request: ${url}`)
  }
  return lines
}

export function activityLines(activities) {
  if (!Array.isArray(activities)) return []
  const lines = []
  const tracker = { lastSnapshotLines: null }
  for (const activity of activities) {
    if (!isPlainObject(activity)) continue
    lines.push(...linesForActivity(activity))
    lines.push(...artifactLines(activity.artifacts, tracker))
  }
  return lines
}

export function summarizeActivities(activities) {
  const summary = {
    lines: [],
    prUrl: null,
    changeSet: null,
    lastAgentMessage: null,
    completed: false,
    failed: false,
    failureMessage: null,
  }
  if (!Array.isArray(activities)) return summary

  summary.lines = activityLines(activities)
  for (const activity of activities) {
    if (!isPlainObject(activity)) continue

    const changeSet = changeSetFromArtifacts(activity.artifacts)
    if (changeSet) summary.changeSet = changeSet

    for (const artifact of Array.isArray(activity.artifacts) ? activity.artifacts : []) {
      if (!isPlainObject(artifact)) continue
      const url = artifactUrl(artifact)
      if (url && summary.prUrl === null) summary.prUrl = url
    }

    if (activity.agentMessaged != null) {
      const message = messageOf(activity.agentMessaged)
      if (message.length > 0) summary.lastAgentMessage = message
    }

    if (activity.sessionCompleted != null) {
      summary.completed = true
    }

    if (activity.sessionFailed != null) {
      summary.failed = true
      const reason = activity.sessionFailed.reason
      if (typeof reason === 'string' && reason.length > 0) summary.failureMessage = reason
    }
  }
  return summary
}

export function sessionState(session) {
  return typeof session?.state === 'string' && session.state.length > 0 ? session.state : 'UNKNOWN'
}

export function prUrlFromSession(session) {
  return firstOutputUrl(session?.outputs)
}

export function branchFromSession(session) {
  const fromOutputs = firstOutputBranch(session?.outputs)
  if (fromOutputs) return fromOutputs
  for (const candidate of [session?.branch, session?.workingBranch]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

export function sessionUrl(session) {
  return typeof session?.url === 'string' && session.url.length > 0 ? session.url : null
}

function sessionIdOf(session) {
  const name = typeof session?.name === 'string' ? session.name : ''
  if (name.length > 0) return name.startsWith('sessions/') ? name.slice('sessions/'.length) : name
  if (typeof session?.id === 'string' && session.id.length > 0) return session.id
  return 'unknown'
}

export function buildResponseText({ session, summary } = {}) {
  const sections = [`Jules session ${sessionIdOf(session)} (${sessionState(session)})`]

  const prUrl = summary?.prUrl ?? prUrlFromSession(session)
  if (prUrl) sections.push(`Pull request: ${prUrl}`)

  // A change set with no pull request is a normal success: Jules produced a
  // patch. Name the suggested commit message and the base it applies to so the
  // response is not nearly empty.
  const changeSet = summary?.changeSet ?? changeSetFromSession(session)
  if (changeSet) {
    const message =
      typeof changeSet.suggestedCommitMessage === 'string' && changeSet.suggestedCommitMessage.length > 0
        ? changeSet.suggestedCommitMessage
        : '(no commit message)'
    const base =
      typeof changeSet.baseCommitId === 'string' && changeSet.baseCommitId.length > 0 ? ` (base ${changeSet.baseCommitId})` : ''
    sections.push(`Change set: ${message}${base}`)
  }

  if (typeof summary?.lastAgentMessage === 'string' && summary.lastAgentMessage.length > 0) {
    sections.push(summary.lastAgentMessage)
  }

  if (summary?.failed && typeof summary.failureMessage === 'string' && summary.failureMessage.length > 0) {
    sections.push(`Failure: ${summary.failureMessage}`)
  }

  const url = sessionUrl(session)
  if (url) sections.push(`Session URL: ${url}`)

  return sections.join('\n\n')
}

export function classifyError({ session, summary, timedOut, apiError } = {}) {
  if (timedOut) {
    return { kind: 'timeout', retriable: true, message: 'Jules session timed out' }
  }

  const status = apiError?.status
  if (status === 429) {
    return { kind: 'quota', retriable: true, message: 'Jules API quota exhausted (429)' }
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', retriable: false, message: `Jules API rejected the credentials (${status})` }
  }

  if (sessionState(session) === 'FAILED' || summary?.failed) {
    const reason = summary?.failureMessage
    return {
      kind: 'remote_failed',
      retriable: false,
      message: typeof reason === 'string' && reason.length > 0 ? `Jules session failed: ${reason}` : 'Jules session failed',
    }
  }

  if (apiError) {
    return { kind: 'crash', retriable: false, message: `Jules API error (${status ?? 'unknown'})` }
  }

  return null
}
