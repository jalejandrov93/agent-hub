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

  return {
    ok: true,
    text: textEvents.map((e) => e.part?.text ?? '').join(''),
    tokens: finish?.part?.tokens?.total ?? null,
    costUsd: finish?.part?.cost ?? null,
    sessionId: events[0]?.sessionID ?? null,
    raw: events,
  }
}

export function classifyError(stdout, exitInfo = {}) {
  if (exitInfo.timedOut) {
    return { kind: 'timeout', retriable: true, message: 'opencode hard timeout (it ignores SIGTERM; the process group was SIGKILLed)' }
  }

  const events = parseJsonl(stdout)
  const errorEvent = events.find((e) => e.type === 'error' || e.type === 'session.error')
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
