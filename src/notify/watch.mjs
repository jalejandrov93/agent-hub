import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../config.mjs'

function fileSize(eventsFile) {
  try {
    return fs.statSync(eventsFile).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

function readChunk(eventsFile, from, to) {
  const fd = fs.openSync(eventsFile, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Tail events.jsonl and invoke onEvent(event) for every new valid JSON line.
 *
 * Same pattern as the dashboard's SSE tail (dashboard.mjs): fs.watch on the
 * file's directory (watching the file itself breaks on editors that replace
 * it) plus byte-offset tracking, so a restart with a saved offset never
 * replays old lines. Malformed lines are skipped, never thrown — same
 * tolerance as readTail() in eventlog.mjs.
 *
 * This is deliberately NOT wired into src/index.mjs: the MCP server is a
 * per-session stdio process that dies with the Claude session, and index.mjs
 * avoids extra schedulers on purpose. Run the watcher as a separate process
 * via `bin/agent-hub watch` instead.
 *
 * @param {object} opts
 * @param {object} opts.env - env carrying AGENT_HUB_HOME (default process.env)
 * @param {number|null} opts.sinceOffset - byte offset to resume from; defaults
 *   to the current end of file (only future appends are delivered)
 * @param {(event: object) => void|Promise<void>} opts.onEvent - called once
 *   per new valid event, in file order; a throwing/rejecting handler is
 *   reported to console.error and does not stop the tail
 * @param {AbortSignal|null} opts.signal - aborts (closes) the watcher cleanly
 * @returns {{ close(): void, poll(): Promise<void>, getOffset(): number,
 *   eventsFile: string, closed: boolean }}
 */
export function watchEvents({ env = process.env, sinceOffset = null, onEvent, signal = null } = {}) {
  if (typeof onEvent !== 'function') throw new Error('watchEvents requires onEvent(event)')
  const { eventsFile } = paths(env)
  const dir = path.dirname(eventsFile)
  const base = path.basename(eventsFile)

  let offset = sinceOffset ?? fileSize(eventsFile)
  let closed = false
  let polling = false
  let queued = false

  async function poll() {
    if (closed || polling) {
      queued = true
      return
    }
    polling = true
    try {
      let size = fileSize(eventsFile)
      if (size < offset) offset = 0 // rotated/truncated — same as the dashboard
      if (size <= offset) return
      const text = readChunk(eventsFile, offset, size)
      offset = size // advance BEFORE parsing: a malformed line is skipped once, never replayed
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        try {
          await onEvent(event)
        } catch (error) {
          console.error('[agent-hub] watch onEvent failed:', error?.message ?? error)
        }
        if (closed) return
      }
    } finally {
      polling = false
      if (queued && !closed) {
        queued = false
        await poll()
      } else {
        queued = false
      }
    }
  }

  function close() {
    if (closed) return
    closed = true
    watcher?.close()
    signal?.removeEventListener?.('abort', close)
  }

  let watcher = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename === base) void poll()
    })
    watcher.on?.('error', () => {
      // fs.watch unavailable on this mount — poll() still works manually.
    })
  } catch {
    // fs.watch unavailable on this platform/mount — poll() still works manually.
  }

  if (signal) {
    if (signal.aborted) close()
    else signal.addEventListener?.('abort', close, { once: true })
  }

  const handle = {
    close,
    poll,
    getOffset: () => offset,
    eventsFile,
    get closed() {
      return closed
    },
  }
  return handle
}

/** Current end-of-file offset — persist getOffset() and pass it back as sinceOffset to resume without replays. */
export function currentOffset({ env = process.env } = {}) {
  return fileSize(paths(env).eventsFile)
}
