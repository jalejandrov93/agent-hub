import fs from 'node:fs'
import { paths, PREFLIGHT_TTL_MS, CIRCUIT_BREAKER, resolveTimeoutS } from './config.mjs'
import { readTail } from './eventlog.mjs'
import { adapterFor, modelsArgv } from './adapters/index.mjs'
import { runCommand } from './process.mjs'

const LADDER_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3 }
const PING_PROMPT = 'Reply exactly: PONG'

export function cacheKey(agent, model) {
  return `${agent}:${model}`
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function readCache(env = process.env) {
  const { preflightCacheFile } = paths(env)
  try {
    return JSON.parse(fs.readFileSync(preflightCacheFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    return {}
  }
}

export function writeCacheEntry(key, entry, env = process.env) {
  const { home, preflightCacheFile } = paths(env)
  ensureDir(home)
  const cache = readCache(env)
  cache[key] = entry
  fs.writeFileSync(preflightCacheFile, JSON.stringify(cache, null, 2), 'utf8')
  return entry
}

function isFresh(entry, env = process.env) {
  if (!entry?.checkedAt) return false
  return Date.now() - new Date(entry.checkedAt).getTime() < PREFLIGHT_TTL_MS
}

/**
 * Circuit breaker: >= failureThreshold quota/canceled job.failed events for
 * this exact agent+model pair within the trailing window minutes it open.
 */
export function circuitBreakerOpen({ agent, model, env = process.env }) {
  const events = readTail({ n: 2000, env })
  const cutoff = Date.now() - CIRCUIT_BREAKER.windowMs
  const failures = events.filter((e) => {
    if (e.kind !== 'job.failed') return false
    if (e.agent !== agent || e.model !== model) return false
    if (!CIRCUIT_BREAKER.failureKinds.has(e.errorKind)) return false
    return new Date(e.ts).getTime() >= cutoff
  })
  // A single billing failure (e.g. DeepSeek 402 Insufficient Balance) opens
  // the breaker right away — it never clears on its own retry, unlike a
  // transient quota/canceled blip, which needs failureThreshold within the window.
  if (failures.some((f) => CIRCUIT_BREAKER.immediateKinds.has(f.errorKind))) return true
  return failures.length >= CIRCUIT_BREAKER.failureThreshold
}

/**
 * Run the L0-L2 preflight ladder for one agent+model pair. Short-circuits on
 * the first failing rung. Never invokes a real prompt (that is L3, a
 * separate function called lazily by delegate(), never by agentsStatus()).
 */
export async function runPreflight({ agent, model, cwd, env = process.env, commandRunner = runCommand, level = 'L2', force = false }) {
  const key = cacheKey(agent, model)

  if (!force) {
    const cached = readCache(env)[key]
    if (cached && isFresh(cached, env) && LADDER_ORDER[cached.ladderLevel] >= LADDER_ORDER[level]) {
      return cached
    }
  }

  const adapter = adapterFor(agent)
  const startedAt = Date.now()

  // L0: --version
  const versionResult = await commandRunner(adapter.cmd, ['--version'], { cwd, env, timeoutMs: 10_000 })
  if (versionResult.code !== 0 || versionResult.timedOut) {
    return writeCacheEntry(
      key,
      {
        agent,
        model,
        status: 'unavailable',
        reason: 'L0 --version check failed',
        ladderLevel: 'L0',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      },
      env
    )
  }
  if (level === 'L0') {
    return writeCacheEntry(
      key,
      { agent, model, status: 'ready', reason: null, ladderLevel: 'L0', latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString() },
      env
    )
  }

  // L1: model listed. copilot's `help config` catalog is documentation, not
  // account availability (most listed ids were rejected live) — `auto` is
  // the one value verified reliable, so it is always treated as listed.
  // 60s (not 20s): the models-list command was measured at 24s under load,
  // which made a legitimately-listed model cache as falsely 'unavailable'.
  const isCopilotAuto = agent === 'copilot' && model === 'auto'
  const modelsResult = isCopilotAuto ? null : await commandRunner(adapter.cmd, modelsArgv(agent, model), { cwd, env, timeoutMs: 60_000 })
  const modelsListTimedOut = !isCopilotAuto && (modelsResult?.timedOut || !modelsResult?.stdout)
  const models = isCopilotAuto ? [] : adapter.listModels(modelsResult?.stdout ?? '')
  const listed = isCopilotAuto || models.some((m) => m.id === model)
  if (!listed) {
    // A timed-out or empty listing proves nothing about the model — it may
    // well be listed — so this is 'degraded' (retry later), not the harder
    // 'unavailable' a real, completed listing without the model earns.
    if (modelsListTimedOut) {
      return writeCacheEntry(
        key,
        {
          agent,
          model,
          status: 'degraded',
          reason: 'model list timed out',
          ladderLevel: 'L1',
          latencyMs: Date.now() - startedAt,
          checkedAt: new Date().toISOString(),
        },
        env
      )
    }
    return writeCacheEntry(
      key,
      {
        agent,
        model,
        status: 'unavailable',
        reason: `model not listed by ${adapter.cmd}`,
        ladderLevel: 'L1',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      },
      env
    )
  }

  // copilot's --model allowlist is account-specific and unstable; catalog
  // membership alone never proves a non-'auto' model actually works, so it
  // stays 'degraded' until an L3 ping confirms it (see pingAgent below).
  const catalogOnlyUncertain = agent === 'copilot' && model !== 'auto'

  if (level === 'L1') {
    return writeCacheEntry(
      key,
      {
        agent,
        model,
        status: catalogOnlyUncertain ? 'degraded' : 'ready',
        reason: catalogOnlyUncertain ? 'catalog only; account availability unverified' : null,
        ladderLevel: 'L1',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      },
      env
    )
  }

  // L2: quota signal + circuit breaker
  const breakerOpen = circuitBreakerOpen({ agent, model, env })
  const quotaSignal = breakerOpen ? 'unknown' : 'unknown' // no authoritative quota API for agy/opencode; copilot's is advisory and checked separately via quota tooling
  let status = 'ready'
  let reason = null
  if (breakerOpen) {
    status = 'degraded'
    reason = 'circuit_breaker_open: >=2 quota/canceled failures in the last 30 minutes'
  } else if (catalogOnlyUncertain) {
    status = 'degraded'
    reason = 'catalog only; account availability unverified'
  }

  return writeCacheEntry(
    key,
    {
      agent,
      model,
      status,
      reason,
      ladderLevel: 'L2',
      quotaSignal,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    },
    env
  )
}

/**
 * agents_status: L0-L2 for every requested pair. Never pings (no L3) —
 * pinging is reserved for delegate()'s lazy, per-call check.
 */
export async function agentsStatus({ agents, cwd, env = process.env, commandRunner = runCommand, refresh = false }) {
  const results = []
  for (const { agent, model } of agents) {
    results.push(await runPreflight({ agent, model, cwd, env, commandRunner, level: 'L2', force: refresh }))
  }
  return results
}

/** L3: a real ping using the same argv builder as a real job. */
export async function pingAgent({ agent, model, cwd, env = process.env, commandRunner = runCommand }) {
  const adapter = adapterFor(agent)
  const key = cacheKey(agent, model)
  const startedAt = Date.now()
  const timeoutS = resolveTimeoutS(agent, model)
  const argv = adapter.buildArgv({ model, prompt: PING_PROMPT, cwd, mode: agent === 'copilot' ? 'read' : 'plan' })

  const result = await commandRunner(adapter.cmd, argv, { cwd, env, timeoutMs: Math.min(timeoutS, 45) * 1000 })
  // Combine stdout+stderr before classifying: copilot's --model rejection
  // ("Error: Model ... is not available.") was measured on STDERR, not
  // stdout, while success payloads for all three adapters are stdout-only.
  // jobrunner.mjs already does this implicitly (it appends both streams to
  // the same stdout.log); pingAgent keeps process.mjs's streams separate, so
  // it must combine them explicitly or a stderr-only error is invisible.
  const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const error = adapter.classifyError(combinedOutput, { timedOut: result.timedOut })

  if (error) {
    return writeCacheEntry(
      key,
      {
        agent,
        model,
        status: 'unavailable',
        reason: `L3 ping failed: ${error.kind} — ${error.message}`,
        ladderLevel: 'L3',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      },
      env
    )
  }

  return writeCacheEntry(
    key,
    { agent, model, status: 'ready', reason: null, ladderLevel: 'L3', latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString() },
    env
  )
}
