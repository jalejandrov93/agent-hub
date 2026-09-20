import { spawn } from 'node:child_process'

const DEFAULT_KILL_GRACE_MS = 3000

/**
 * Spawn a child as the leader of its own process group (POSIX: detached
 * means setsid(), so child.pid === the group's pgid). Argv only, never a
 * shell — the prompt is one argv element, so no injection surface.
 *
 * opts.stdin, when a non-null string, pipes stdin and writes+ends it right
 * away (opencode v2 reads its prompt from stdin instead of argv — see
 * adapters/opencode.mjs). When absent, behavior is byte-identical to
 * before: stdin stays 'ignore'.
 */
export function spawnDetached(cmd, args, opts = {}) {
  const hasStdin = typeof opts.stdin === 'string'
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    shell: false,
    stdio: opts.stdio ?? [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })

  if (hasStdin && child.stdin) {
    // The child may exit (or close stdin) before it ever reads what we
    // write — e.g. it fails fast on a bad flag. That surfaces as EPIPE on
    // the write/end below; swallow it instead of letting it become an
    // unhandled 'error' event that crashes this process.
    child.stdin.on('error', () => {})
    child.stdin.write(opts.stdin)
    child.stdin.end()
  }

  return child
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Kill an entire process group: SIGINT first, then SIGTERM, then SIGKILL if
 * it is still alive. opencode v2's `run` registers a handler for SIGINT
 * only — it calls the server's `session.interrupt` before exiting — so
 * SIGINT is what actually stops server-side work; SIGTERM is unhandled and
 * would just detach the local client while the session keeps running on the
 * server (E13). SIGTERM stays as a second-stage fallback for every other
 * agent CLI, which does honor it. Signaling -pgid reaches every process that
 * shares the group (children and grandchildren that never called setsid
 * themselves).
 *
 * The grace window is split in half between the two signals rather than
 * multiplied out: SIGINT gets the first half, SIGTERM the second, so the
 * total worst case before SIGKILL stays bounded at graceMs, same as before.
 */
export async function killProcessGroup(pgid, { graceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  const signalAndWait = async (signal, waitMs) => {
    try {
      process.kill(-pgid, signal)
    } catch (error) {
      if (error.code === 'ESRCH') return true // already gone
      throw error
    }

    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (!isAlive(pgid)) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return !isAlive(pgid)
  }

  const stageMs = Math.max(1, Math.floor(graceMs / 2))
  if (await signalAndWait('SIGINT', stageMs)) return
  if (await signalAndWait('SIGTERM', graceMs - stageMs)) return

  try {
    process.kill(-pgid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

/**
 * Drive a spawned child to completion with a hard timeout. On timeout, the
 * whole process group is killed via the SIGINT->SIGTERM->SIGKILL ladder:
 * opencode v2's `run` only handles SIGINT (it interrupts the server-side
 * session), and SIGTERM is simply unhandled, so leading with SIGINT is what
 * actually stops server-side work instead of leaving it running after the
 * local client is gone.
 */
export function runWithTimeout(child, { timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS, onStdout, onStderr } = {}) {
  const pgid = child.pid
  let timedOut = false
  let timer = null

  if (child.stdout && onStdout) child.stdout.on('data', onStdout)
  if (child.stderr && onStderr) child.stderr.on('data', onStderr)

  const exitPromise = new Promise((resolve) => {
    // 'close' (not 'exit') so every buffered stdout/stderr 'data' event has
    // already fired before callers read back what onStdout/onStderr wrote.
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ code, signal, timedOut })
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: null, signal: null, timedOut, error })
    })
  })

  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true
      killProcessGroup(pgid, { graceMs: killGraceMs }).catch(() => {})
    }, timeoutMs)
    timer.unref?.()
  }

  return { pgid, exitPromise }
}

/**
 * The real command runner used outside tests: spawn argv, buffer
 * stdout/stderr, enforce a hard timeout. Preflight and the job runner both
 * take this as an injectable dependency so tests never spawn a real process.
 */
export async function runCommand(cmd, args, { cwd, env, timeoutMs, killGraceMs, stdin } = {}) {
  const child = spawnDetached(cmd, args, { cwd, env, stdin })
  const stdoutChunks = []
  const stderrChunks = []
  const { exitPromise } = runWithTimeout(child, {
    timeoutMs,
    killGraceMs,
    onStdout: (c) => stdoutChunks.push(c),
    onStderr: (c) => stderrChunks.push(c),
  })
  const { code, signal, timedOut, error } = await exitPromise
  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    code,
    signal,
    timedOut,
    error,
  }
}
