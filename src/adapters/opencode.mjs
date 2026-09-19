import { parseJsonl } from './base.mjs'

export const id = 'opencode'
export const cmd = 'opencode'

/**
 * Argv only. read -> --agent plan; write -> --agent build --auto.
 * sessionId resumes a session (-s <id>); variant selects reasoning effort
 * (minimal/low/medium/high/max), e.g. Muse Spark 1.3's registry default 'high'.
 *
 * v2 changes (see odd/tasks/opencode-v2-migration.md, evidence E1-E3/E11):
 * - No prompt positional: an argv element containing spaces arrives wrapped
 *   in literal double quotes and corrupts the prompt (E3). The prompt now
 *   travels on stdin instead -- see stdinFor() below.
 * - No --dir: the flag was removed (E1); cwd comes from the spawned
 *   process's own cwd/PWD instead (see jobrunner.mjs).
 * - No --variant: the flag was removed (E2). The variant now rides the
 *   model id as `<model>#<variant>`.
 * - Never --standalone: a private `opencode serve` reports zero
 *   credentials, zero providers, and zero models even when warm (E11), so
 *   the model id above would never resolve. This looks like an obvious
 *   "fix" to a future reader -- it is not; the shared service is the only
 *   mode with real provider credentials wired up.
 */
export function buildArgv({ model, prompt, mode = 'read', title, variant, sessionId }) {
  const agent = mode === 'write' ? 'build' : 'plan'
  const modelId = variant && !model.includes('#') ? `${model}#${variant}` : model
  const args = ['run', '-m', modelId, '--format', 'json', '--agent', agent]
  if (title) args.push('--title', title)
  if (sessionId) args.push('-s', sessionId)
  if (mode === 'write') args.push('--auto')
  return args
}

/**
 * The prompt now reaches opencode via stdin instead of argv (E3/E4): a
 * prompt passed as an argv element arrives wrapped in literal double
 * quotes, corrupting it, while the same text on stdin arrives verbatim.
 */
export function stdinFor({ prompt }) {
  return prompt
}

export function parseResult(stdout) {
  const events = parseJsonl(stdout)
  const textEvents = events.filter((e) => e.type === 'text')
  const finish = [...events].reverse().find((e) => e.type === 'step_finish')

  if (textEvents.length === 0) {
    return { ok: false, raw: events }
  }

  // v2 can emit several assistant messages in one run (E7): concatenating
  // every `text` event splices unrelated turns together (a real capture
  // produced "PONG" followed by an unrelated "Ready to plan..." turn). Group
  // by part.messageID, preserving stream order, and keep only the last
  // group. An event missing messageID still groups fine (under the
  // `undefined` key) instead of throwing.
  const groupOrder = []
  const groups = new Map()
  for (const e of textEvents) {
    const key = e.part?.messageID
    if (!groups.has(key)) {
      groups.set(key, [])
      groupOrder.push(key)
    }
    groups.get(key).push(e)
  }
  const lastMessageEvents = groups.get(groupOrder[groupOrder.length - 1])

  // v2's step_finish.part.tokens has no `total` field (E5): it is
  // {input, output, reasoning, cache:{read,write}}. We sum every component,
  // including cache read/write, into the reported total: cache tokens still
  // represent real work done against the provider, and this matches the
  // `total` this adapter reported pre-v2 (verified against a real capture
  // where total === input+output+reasoning+cache.read+cache.write).
  const tokenParts = finish?.part?.tokens
  const tokens = tokenParts
    ? (tokenParts.input ?? 0) + (tokenParts.output ?? 0) + (tokenParts.reasoning ?? 0) + (tokenParts.cache?.read ?? 0) + (tokenParts.cache?.write ?? 0)
    : null

  return {
    ok: true,
    text: lastMessageEvents.map((e) => e.part?.text ?? '').join(''),
    tokens,
    costUsd: finish?.part?.cost ?? null,
    sessionId: events[0]?.sessionID ?? null,
    raw: events,
  }
}

export function classifyError(stdout, exitInfo = {}) {
  if (exitInfo.timedOut) {
    return {
      kind: 'timeout',
      retriable: true,
      message: 'opencode hard timeout (it handles SIGINT but not SIGTERM; the process group was SIGKILLed)',
    }
  }

  if (exitInfo.code === 130) {
    // v2 exit codes are meaningful (E16): 130 is SIGINT/interrupt, not a
    // crash. Our own kill ladder sends SIGINT first (E13), so this is
    // reachable in normal operation, not only from an external Ctrl-C.
    return { kind: 'canceled', retriable: true, message: 'opencode run was interrupted (exit 130 / SIGINT)' }
  }

  const events = parseJsonl(stdout)
  // v2's `run` only ever emits `error`, never `session.error` (E18) — that
  // branch was dead against the real CLI and has been removed.
  const errorEvent = events.find((e) => e.type === 'error')
  if (errorEvent) {
    const msg = JSON.stringify(errorEvent).toLowerCase()
    // Real capture: DeepSeek returned statusCode:402 "Insufficient Balance".
    // Distinct, non-retriable kind so the circuit breaker opens immediately
    // instead of waiting on the quota/canceled failureThreshold.
    if (/"statuscode":402|insufficient balance|payment required/.test(msg)) {
      return { kind: 'billing', retriable: false, message: 'opencode billing error (402/insufficient balance)' }
    }
    if (/429|rate limit|quota/.test(msg)) return { kind: 'quota', retriable: true, message: 'opencode quota/rate-limit error event' }
    if (/401|unauthorized|not authenticated/.test(msg)) return { kind: 'auth', retriable: false, message: 'opencode auth error event' }
    return { kind: 'crash', retriable: false, message: 'opencode reported an error event' }
  }

  const hasText = events.some((e) => e.type === 'text')
  if (!hasText) {
    // Documented: text/step_finish events can be silently dropped from the stream.
    return { kind: 'empty', retriable: true, message: 'opencode stream had no text event (dropped)' }
  }
  return null
}

/**
 * Parse `opencode models <provider> --verbose`: repeated blocks of
 * "<provider>/<id>" followed by a pretty-printed JSON object.
 */
export function listModels(stdout) {
  const lines = stdout.split(/\r?\n/)
  const models = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i].trim()
    if (/^[\w.-]+\/[\w.-]+$/.test(header) && lines[i + 1]?.trim() === '{') {
      let depth = 0
      const block = []
      let j = i + 1
      for (; j < lines.length; j++) {
        block.push(lines[j])
        depth += (lines[j].match(/{/g) || []).length
        depth -= (lines[j].match(/}/g) || []).length
        if (depth === 0) break
      }
      try {
        const obj = JSON.parse(block.join('\n'))
        models.push({ id: `${obj.providerID}/${obj.id}`, label: obj.name, cost: obj.cost, limit: obj.limit })
      } catch {
        // skip a malformed block rather than aborting the whole parse
      }
      i = j + 1
    } else {
      i++
    }
  }
  return models
}
