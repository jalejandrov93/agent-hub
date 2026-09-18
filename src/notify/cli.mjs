import { readTail } from '../eventlog.mjs'
import { watchEvents } from './watch.mjs'
import { routeEvent, consoleAdapter, createFileAdapter, createWebhookAdapter } from './adapters.mjs'

function usageError(message) {
  console.error(`agent-hub watch: ${message}`)
  console.error('Usage: agent-hub watch [--once|--follow] [--sink console|file|webhook] [--file PATH] [--url URL] [--tail N]')
  process.exitCode = 2
  return false
}

/**
 * `bin/agent-hub watch` — the watcher as its own process, so the MCP stdio
 * lifecycle (src/index.mjs) stays scheduler-free on purpose.
 *
 * - --once: route the last --tail N events (default 50) and exit. Exit 0.
 * - --follow (default): route the last --tail N (default: none, only new
 *   appends), then tail events.jsonl until SIGINT/SIGTERM.
 * - --sink: comma-separated/repeatable, subset of console|file|webhook
 *   (default console). --file sets the file sink path, --url the webhook URL.
 */
export async function runWatchCli(args, { env = process.env } = {}) {
  let once = false
  let follow = false
  const sinks = []
  let file = null
  let url = null
  let tail = null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--once') once = true
    else if (a === '--follow') follow = true
    else if (a === '--sink') {
      const v = args[++i]
      if (!v) return usageError('--sink requires a value')
      sinks.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a.startsWith('--sink=')) {
      sinks.push(...a.slice('--sink='.length).split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a === '--file') {
      file = args[++i]
      if (!file) return usageError('--file requires a path')
    } else if (a.startsWith('--file=')) file = a.slice('--file='.length)
    else if (a === '--url') {
      url = args[++i]
      if (!url) return usageError('--url requires a value')
    } else if (a.startsWith('--url=')) url = a.slice('--url='.length)
    else if (a === '--tail') {
      tail = Number(args[++i])
      if (!Number.isInteger(tail) || tail < 0) return usageError('--tail requires a non-negative integer')
    } else if (a.startsWith('--tail=')) {
      tail = Number(a.slice('--tail='.length))
      if (!Number.isInteger(tail) || tail < 0) return usageError('--tail requires a non-negative integer')
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: agent-hub watch [--once|--follow] [--sink console|file|webhook] [--file PATH] [--url URL] [--tail N]')
      return true
    } else {
      return usageError(`unknown flag "${a}"`)
    }
  }

  if (once && follow) return usageError('--once and --follow are mutually exclusive')
  if (sinks.length === 0) sinks.push('console')
  for (const s of sinks) {
    if (!['console', 'file', 'webhook'].includes(s)) return usageError(`unknown sink "${s}"`)
  }
  if (sinks.includes('webhook') && !url) return usageError('webhook sink requires --url')

  const handlers = []
  if (sinks.includes('console')) handlers.push((e) => consoleAdapter(e))
  if (sinks.includes('file')) handlers.push(createFileAdapter({ file, env }))
  if (sinks.includes('webhook')) handlers.push(createWebhookAdapter({ url }))

  let routed = 0
  const dispatch = async (event) => {
    if (!routeEvent(event)) return
    routed++
    await Promise.all(handlers.map((h) => h(event)))
  }

  if (once) {
    const n = tail ?? 50
    for (const event of readTail({ n, env })) await dispatch(event)
    console.error(`[agent-hub] watch --once: routed ${routed} event(s)`)
    return true
  }

  // --follow: catch up on --tail N first (default: only new appends), then tail.
  if (tail != null && tail > 0) {
    for (const event of readTail({ n: tail, env })) await dispatch(event)
  }
  const handle = watchEvents({ env, onEvent: dispatch })
  console.error('[agent-hub] watch: following events.jsonl (Ctrl-C to stop)')
  const stop = () => {
    handle.close()
    console.error(`[agent-hub] watch: stopped after routing ${routed} event(s)`)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (handle.closed) {
        clearInterval(t)
        resolve()
      }
    }, 100)
    t.unref?.()
  })
  return true
}
