import fs from 'node:fs'
import { paths, PREFLIGHT_TTL_MS, CIRCUIT_BREAKER, resolveTimeoutS } from './config.mjs'
import { readTail, appendEvent } from './eventlog.mjs'
import { adapterFor, modelsArgv } from './adapters/index.mjs'
import { runCommand } from './process.mjs'
import { writeJsonAtomic } from './fsutil.mjs'
import { readDiscovery } from './discovery.mjs'
import { readOverrides, overrideKey } from './overrides.mjs'

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
  // Atomic write: the MCP process and the separately running dashboard
  // process both write this file, so a plain writeFileSync risks a reader
  // (or the other writer's read-modify-write) observing a partial/corrupted
  // file. A lost update between the two processes is an accepted residual
  // risk — it self-heals within one PREFLIGHT_TTL_MS cycle.
  writeJsonAtomic(preflightCacheFile, cache)
  return entry
}

function isFresh(entry, env = process.env) {
  if (!entry?.checkedAt) return false
  return Date.now() - new Date(entry.checkedAt).getTime() < PREFLIGHT_TTL_MS
}

/**
 * quota/canceled/billing job.failed events for this exact agent+model pair
 * within the trailing window, minus anything wiped by a manual breakerReset
 * override (dashboard "Reset breaker" button) — a failure at or before that
 * instant stops counting; a fresh one after it still counts.
 */
function matchingFailures({ agent, model, env }) {
  const events = readTail({ n: 2000, env })
  const cutoff = Date.now() - CIRCUIT_BREAKER.windowMs
  const override = readOverrides(env)[overrideKey(agent, model)]
  const breakerResetAt = override?.breakerReset ? new Date(override.breakerReset).getTime() : null
  return events.filter((e) => {
    if (e.kind !== 'job.failed') return false
    if (e.agent !== agent || e.model !== model) return false
    if (!CIRCUIT_BREAKER.failureKinds.has(e.errorKind)) return false
    const ts = new Date(e.ts).getTime()
    if (ts < cutoff) return false
    if (breakerResetAt != null && ts <= breakerResetAt) return false
    return true
  })
}

/**
 * Circuit breaker: >= failureThreshold quota/canceled job.failed events for
 * this exact agent+model pair within the trailing window it is open. A
 * single billing failure (e.g. DeepSeek 402 Insufficient Balance) opens the
 * breaker right away — it never clears on its own retry, unlike a transient
 * quota/canceled blip, which needs failureThreshold within the window.
 */
export function circuitBreakerOpen({ agent, model, env = process.env }) {
  const failures = matchingFailures({ agent, model, env })
  if (failures.some((f) => CIRCUIT_BREAKER.immediateKinds.has(f.errorKind))) return true
  return failures.length >= CIRCUIT_BREAKER.failureThreshold
}

/** Richer breaker view for the dashboard's Config panel: open state plus the failure count/last-failure timestamp behind it. */
export function breakerStatus({ agent, model, env = process.env }) {
  const failures = matchingFailures({ agent, model, env })
  const open = failures.some((f) => CIRCUIT_BREAKER.immediateKinds.has(f.errorKind)) || failures.length >= CIRCUIT_BREAKER.failureThreshold
  return { agent, model, open, failureCount: failures.length, lastFailureAt: failures.length > 0 ? failures[failures.length - 1].ts : null }
}

/**
 * Run the L0-L2 preflight ladder for one agent+model pair. Short-circuits on
 * the first failing rung. Never invokes a real prompt (that is L3, a
 * separate function called lazily by delegate(), never by agentsStatus()).
 */
export async function runPreflight({ agent, model, cwd, env = process.env, commandRunner = runCommand, level = 'L2', force = false, modelsById = null }) {
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
  //
  // modelsById (an {id: model} map from a fresh discovery.json row, or an
  // agentsStatus() call that already listed this agent once for the whole
  // batch) skips the spawn entirely — this is what turns "one models-list
  // call per pair" into "one per agent" for a cold agents_status refresh.
  const isCopilotAuto = agent === 'copilot' && model === 'auto'
  let modelsListTimedOut = false
  let listed
  if (isCopilotAuto) {
    listed = true
  } else if (modelsById) {
    listed = Object.prototype.hasOwnProperty.call(modelsById, model)
  } else {
    const modelsResult = await commandRunner(adapter.cmd, modelsArgv(agent, model), { cwd, env, timeoutMs: 60_000 })
    modelsListTimedOut = modelsResult?.timedOut || !modelsResult?.stdout
    const models = adapter.listModels(modelsResult?.stdout ?? '')
    listed = models.some((m) => m.id === model)
  }
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
function isFreshDiscoveryRow(entry) {
  if (!entry?.checkedAt) return false
  return Date.now() - new Date(entry.checkedAt).getTime() < PREFLIGHT_TTL_MS
}

/**
 * Resolve one shared {modelId: model} map for every pair of `agent` in this
 * agentsStatus() batch, so runPreflight's L1 spawns the models-list command
 * at most once per agent (not once per pair). Prefers a fresh discovery.json
 * row; otherwise spawns live, once per agent (opencode: once per distinct
 * provider actually requested, since its catalog command is provider-scoped).
 * Returns null on any failure/timeout so callers fall back to runPreflight's
 * own per-pair spawn — the pre-existing, safe "degraded on timeout" path.
 */
async function resolveModelsById({ agent, pairs, cwd, env, commandRunner, refresh }) {
  if (agent === 'copilot' && pairs.every((p) => p.model === 'auto')) return null // never consulted, see isCopilotAuto

  if (!refresh) {
    const discoveryRow = readDiscovery(env)[agent]
    if (isFreshDiscoveryRow(discoveryRow) && !discoveryRow.error) {
      return Object.fromEntries((discoveryRow.models ?? []).map((m) => [m.id, m]))
    }
  }

  const adapter = adapterFor(agent)
  const modelsById = {}

  if (agent === 'opencode') {
    const providers = new Set(pairs.map((p) => String(p.model).split('/')[0] || 'opencode'))
    for (const provider of providers) {
      const result = await commandRunner(adapter.cmd, modelsArgv(agent, `${provider}/probe`), { cwd, env, timeoutMs: 60_000 })
      if (result?.timedOut || !result?.stdout) return null
      for (const m of adapter.listModels(result.stdout)) modelsById[m.id] = m
    }
    return modelsById
  }

  const result = await commandRunner(adapter.cmd, modelsArgv(agent, pairs[0]?.model), { cwd, env, timeoutMs: 60_000 })
  if (result?.timedOut || !result?.stdout) return null
  for (const m of adapter.listModels(result.stdout)) modelsById[m.id] = m
  return modelsById
}

/**
 * L0-L2 for every requested pair. Different agents run in parallel
 * (Promise.allSettled); pairs of the SAME agent run serially, never more
 * than one live CLI process per agent at a time. Never pings (no L3).
 */
export async function agentsStatus({ agents, cwd, env = process.env, commandRunner = runCommand, refresh = false, announce = false }) {
  const groups = new Map()
  for (const pair of agents) {
    const list = groups.get(pair.agent) ?? []
    list.push(pair)
    groups.set(pair.agent, list)
  }

  const resultsByKey = new Map()
  await Promise.allSettled(
    [...groups.entries()].map(async ([agent, pairs]) => {
      const modelsById = await resolveModelsById({ agent, pairs, cwd, env, commandRunner, refresh })
      for (const { model } of pairs) {
        const entry = await runPreflight({ agent, model, cwd, env, commandRunner, level: 'L2', force: refresh, modelsById })
        resultsByKey.set(cacheKey(agent, model), entry)
        // Only refresh/dashboard paths announce — a plain cache-served
        // agents_status() call would otherwise flood the timeline on every
        // MCP client's routine health check.
        if (announce) {
          appendEvent(
            {
              kind: 'preflight',
              phase: 'agent',
              agent,
              model,
              status: entry.status,
              ladderLevel: entry.ladderLevel,
              reason: entry.reason ?? null,
              latencyMs: entry.latencyMs ?? null,
              summary: `${agent}:${model} → ${entry.status}`,
            },
            { env }
          )
        }
      }
    })
  )

  return agents.map(({ agent, model }) => {
    const found = resultsByKey.get(cacheKey(agent, model))
    if (found) return found
    // One agent-group's unexpected throw (Promise.allSettled swallowed it)
    // must never silently drop that agent's pairs from the response.
    return { agent, model, status: 'unavailable', reason: 'preflight failed unexpectedly', ladderLevel: 'L0', checkedAt: new Date().toISOString() }
  })
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
