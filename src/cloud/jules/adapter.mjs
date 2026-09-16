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
 * accept either an array or a single object and probe the three url keys seen
 * in the wild (pullRequest.url, pullRequest.uri, url).
 */
function outputItems(outputs) {
  if (Array.isArray(outputs)) return outputs
  if (isPlainObject(outputs)) return [outputs]
  return []
}

function firstOutputUrl(outputs) {
  for (const item of outputItems(outputs)) {
    if (!isPlainObject(item)) continue
    const candidates = [item.pullRequest?.url, item.pullRequest?.uri, item.url]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
  }
  return null
}

function messageOf(container) {
  return typeof container?.message === 'string' ? container.message : ''
}

function countDiffLines(diff) {
  if (typeof diff !== 'string' || diff.length === 0) return 0
  // A trailing newline terminates the last line; it does not introduce an
  // empty one, so strip exactly one before counting separators.
  return diff.replace(/\n$/, '').split('\n').length
}

function changeSetLineFor(changeSet) {
  if (!isPlainObject(changeSet)) return null
  const message =
    typeof changeSet.suggestedCommitMessage === 'string' && changeSet.suggestedCommitMessage.length > 0
      ? changeSet.suggestedCommitMessage
      : '(no commit message)'
  return `[jules] change set: ${message} (${countDiffLines(changeSet.unifiedDiff)} diff lines)`
}

/**
 * The activity envelope is alpha and its field names are only partly
 * documented, so the type is detected by which key is present and an unknown
 * shape degrades to its `description` instead of throwing.
 */
function linesForActivity(activity) {
  if (activity.planGenerated != null) {
    const steps = Array.isArray(activity.planGenerated.steps) ? activity.planGenerated.steps : []
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
    const suffix = typeof description === 'string' && description.length > 0 ? ` — ${description}` : ''
    return [`[jules] progress: ${title}${suffix}`]
  }
  if (activity.sessionCompleted != null) {
    const lines = ['[jules] session completed']
    const url = firstOutputUrl(activity.sessionCompleted.outputs)
    if (url) lines.push(`[jules] pull request: ${url}`)
    return lines
  }
  if (activity.sessionFailed != null) {
    const reason = activity.sessionFailed.reason
    return [typeof reason === 'string' && reason.length > 0 ? `[jules] session failed: ${reason}` : '[jules] session failed']
  }
  if (typeof activity.description === 'string' && activity.description.length > 0) {
    return [`[jules] ${activity.description}`]
  }
  return []
}

export function activityLines(activities) {
  if (!Array.isArray(activities)) return []
  const lines = []
  for (const activity of activities) {
    if (!isPlainObject(activity)) continue
    lines.push(...linesForActivity(activity))
    const changeSetLine = changeSetLineFor(activity.changeSet)
    if (changeSetLine) lines.push(changeSetLine)
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

    if (isPlainObject(activity.changeSet)) summary.changeSet = activity.changeSet

    if (activity.agentMessaged != null) {
      const message = messageOf(activity.agentMessaged)
      if (message.length > 0) summary.lastAgentMessage = message
    }

    if (activity.sessionCompleted != null) {
      summary.completed = true
      const url = firstOutputUrl(activity.sessionCompleted.outputs)
      if (url && summary.prUrl === null) summary.prUrl = url
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

  const commitMessage = summary?.changeSet?.suggestedCommitMessage
  if (typeof commitMessage === 'string' && commitMessage.length > 0) sections.push(`Change set: ${commitMessage}`)

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
