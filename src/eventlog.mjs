import fs from 'node:fs'
import path from 'node:path'
import { paths } from './config.mjs'

const MAX_LINE_BYTES = 4096
// Leave headroom for JSON escaping/quoting overhead of the summary field itself.
const MAX_SUMMARY_CHARS = 1500

const VALID_KINDS = new Set([
  'preflight',
  'job.queued',
  'job.started',
  'job.finished',
  'job.failed',
  'job.canceled',
  'subagent.start',
  'subagent.stop',
])

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Append one event as one JSON line. Uses a single fs.appendFileSync call so
 * that on POSIX, writes below PIPE_BUF-ish sizes interleave atomically across
 * concurrent processes (O_APPEND semantics) — never a partial/corrupted line.
 */
export function appendEvent(event, { env = process.env } = {}) {
  const { home, eventsFile } = paths(env)
  ensureDir(home)

  const normalized = {
    ts: new Date().toISOString(),
    source: 'hub',
    ...event,
  }

  if (typeof normalized.summary === 'string' && normalized.summary.length > MAX_SUMMARY_CHARS) {
    normalized.summary = normalized.summary.slice(0, MAX_SUMMARY_CHARS) + '…[truncated]'
  }

  let line = JSON.stringify(normalized)
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_LINE_BYTES) {
    // Fall back to dropping the summary entirely rather than emitting a
    // line so large it risks losing the atomic-append guarantee.
    const { summary, ...rest } = normalized
    line = JSON.stringify({ ...rest, summary: '[dropped: line too large]' })
  }

  fs.appendFileSync(eventsFile, line + '\n', { encoding: 'utf8' })
  return normalized
}

/**
 * Read the last N valid JSON lines from the event log, oldest-first.
 * Malformed lines (partial writes, manual edits) are skipped, never thrown.
 */
export function readTail({ n = 200, env = process.env } = {}) {
  const { eventsFile } = paths(env)
  let raw
  try {
    raw = fs.readFileSync(eventsFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const lines = raw.split('\n').filter((l) => l.length > 0)
  const parsed = []
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      // skip malformed line
    }
  }
  return parsed.slice(-n)
}

export function eventsFilePath(env = process.env) {
  return paths(env).eventsFile
}

export { VALID_KINDS }
