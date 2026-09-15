import { spawn } from 'node:child_process'

const DEFAULT_KILL_GRACE_MS = 3000

/**
 * Spawn a child as the leader of its own process group (POSIX: detached
 * means setsid(), so child.pid === the group's pgid). Argv only, never a
 * shell — the prompt is one argv element, so no injection surface.
 */
export function spawnDetached(cmd, args, opts = {}) {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    shell: false,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
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
 * Kill an entire process group: SIGTERM first, then SIGKILL if it is still
 * alive after graceMs. Signaling -pgid reaches every process that shares the
 * group (children and grandchildren that never called setsid themselves),
 * which is how opencode's ignored SIGTERM and its stray children get reaped.
 */
export async function killProcessGroup(pgid, { graceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch (error) {
    if (error.code === 'ESRCH') return // already gone
    throw error
  }

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isAlive(pgid)) return
    await new Promise((r) => setTimeout(r, 50))
  }

  try {
    process.kill(-pgid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

/**
 * Drive a spawned child to completion with a hard timeout. On timeout, the
 * whole process group is killed via the SIGTERM->SIGKILL ladder (opencode
 * ignores SIGTERM outright, so the ladder — not a single signal — is what
 * actually stops it).
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
export async function runCommand(cmd, args, { cwd, env, timeoutMs, killGraceMs } = {}) {
  const child = spawnDetached(cmd, args, { cwd, env })
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
