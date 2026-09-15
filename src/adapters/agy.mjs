import { extractLastJsonLine, parseJsonl } from './base.mjs'

export const id = 'agy'
export const cmd = 'agy'

/**
 * Argv only, never a shell — the prompt is one argv element. agy 1.2.1's
 * --mode only accepts 'plan' or 'accept-edits' (not 'read'/'write'), so the
 * hub's own read/write mode is mapped here, not passed through verbatim.
 * --output-format stream-json (not the legacy single-line 'json') is what
 * lets parseResult/classifyError see partial text_delta output even when a
 * turn is abandoned by agy's own --print-timeout.
 */
export function buildArgv({ model, prompt, cwd, mode = 'read', sessionId, timeoutS }) {
  const agyMode = mode === 'write' ? 'accept-edits' : 'plan'
  const args = ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--mode', agyMode, '--add-dir', cwd, '--dangerously-skip-permissions']
  if (timeoutS) args.push('--print-timeout', `${timeoutS}s`)
  if (sessionId) args.push('--conversation', sessionId)
  return args
}

/**
 * Parse either shape agy can produce:
 *  - stream-json: NDJSON events {"event":"init"|"step_update"|"result",...}.
 *    The final "result" event's `result` object is the envelope; text_delta
 *    of "agent_response" step_update events accumulates as partial text.
 *  - legacy single-line json: one bare {...} envelope (no "event" wrapper),
 *    same shape agy-run.sh expects with `grep -o '^{.*}$' | tail -1`.
 */
function parseAgyStream(stdout) {
  const lines = parseJsonl(stdout)
  const streamEvents = lines.filter((e) => typeof e.event === 'string')

  if (streamEvents.length > 0) {
    const resultEvent = [...streamEvents].reverse().find((e) => e.event === 'result')
    const initEvent = streamEvents.find((e) => e.event === 'init')
    const partialText = streamEvents
      .filter((e) => e.event === 'step_update' && e.step_update?.step_type === 'agent_response')
      .map((e) => e.step_update.text_delta ?? '')
      .join('')
    return {
      resultEnvelope: resultEvent?.result ?? null,
      partialText,
      sessionId: resultEvent?.result?.conversation_id ?? initEvent?.conversation_id ?? null,
    }
  }

  const legacy = extractLastJsonLine(stdout)
  return { resultEnvelope: legacy, partialText: '', sessionId: legacy?.conversation_id ?? null }
}

export function parseResult(stdout) {
  const { resultEnvelope, partialText, sessionId } = parseAgyStream(stdout)
  if (!resultEnvelope || resultEnvelope.status !== 'SUCCESS') {
    return { ok: false, raw: resultEnvelope ?? stdout, partialText, sessionId }
  }
  return {
    ok: true,
    text: resultEnvelope.response || partialText || '',
    tokens: resultEnvelope.usage?.total_tokens ?? null,
    sessionId: resultEnvelope.conversation_id ?? sessionId ?? null,
    durationS: resultEnvelope.duration_seconds ?? null,
    raw: resultEnvelope,
  }
}

export function classifyError(stdout, exitInfo = {}) {
  const { resultEnvelope, partialText, sessionId } = parseAgyStream(stdout)

  // agy's own --print-timeout fires inside the CLI and still exits 0 with a
  // SUCCESS/empty envelope — exitInfo.timedOut (our hard-kill wrapper) is
  // false in that case, so the stdout marker must be checked too. The turn
  // itself is abandoned (verified live: resuming and asking for the answer
  // returned UNFINISHED), so this is 'timeout', not a plain empty response.
  if (exitInfo.timedOut || /\[agy\] print timeout/.test(stdout)) {
    return {
      kind: 'timeout',
      retriable: true,
      message: exitInfo.timedOut ? 'agy hard timeout' : 'agy print-timeout: turn abandoned mid-response',
      partialText,
      sessionId,
    }
  }

  if (resultEnvelope) {
    if (resultEnvelope.status === 'SUCCESS') {
      if (!resultEnvelope.response && !partialText) {
        return { kind: 'empty', retriable: true, message: 'agy SUCCESS with an empty response and no streamed text', partialText, sessionId }
      }
      return null
    }
    if (resultEnvelope.status === 'CANCELED') {
      // Headless agy auto-denies any tool that needs a permission prompt and
      // returns an empty response with exit code 0 — this is that failure.
      return { kind: 'canceled', retriable: true, message: 'agy CANCELED (silent permission denial)', partialText, sessionId }
    }
    return { kind: 'crash', retriable: false, message: `agy status=${resultEnvelope.status}`, partialText, sessionId }
  }

  if (/429|RESOURCE_EXHAUSTED/i.test(stdout)) {
    return { kind: 'quota', retriable: true, message: 'agy quota exhausted (429/RESOURCE_EXHAUSTED)' }
  }
  if (/not logged in|unauthenticated|401/i.test(stdout)) {
    return { kind: 'auth', retriable: false, message: 'agy not authenticated' }
  }
  return { kind: 'crash', retriable: false, message: 'agy produced no JSON envelope' }
}

/** Parse `agy models` output: lines of "id\tlabel" after a "Fetching..." banner. */
export function listModels(stdout) {
  const models = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9._-]+)\t(.+)$/)
    if (match) models.push({ id: match[1], label: match[2].trim() })
  }
  return models
}
