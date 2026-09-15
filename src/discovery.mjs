import fs from 'node:fs'
import path from 'node:path'
import { paths, PREFLIGHT_TTL_MS } from './config.mjs'
import { writeJsonAtomic } from './fsutil.mjs'
import { adapterFor, modelsArgv } from './adapters/index.mjs'
import { runCommand } from './process.mjs'
import { appendEvent } from './eventlog.mjs'
import { DELEGATION_MAP } from './router.mjs'

export const KNOWN_AGENTS = ['agy', 'opencode', 'copilot']

/** Every distinct opencode provider ("<provider>/<id>") referenced anywhere in DELEGATION_MAP. */
function opencodeProviders() {
  const providers = new Set()
  for (const entry of Object.values(DELEGATION_MAP)) {
    for (const candidate of entry.chain) {
      if (candidate.agent === 'opencode') providers.add(String(candidate.model).split('/')[0] || 'opencode')
      if (candidate.parallelWith?.agent === 'opencode') providers.add(String(candidate.parallelWith.model).split('/')[0] || 'opencode')
    }
  }
  return providers.size > 0 ? [...providers] : ['opencode']
}

/**
 * Resolve a CLI's absolute path by scanning env.PATH ourselves (no shelling
 * out to `which`/`where`), so this works identically on POSIX and Windows.
 */
export function resolveBinPath(cmd, env = process.env) {
  const pathVar = env.PATH ?? env.Path ?? ''
  const dirs = pathVar.split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(path.delimiter) : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // not here — keep scanning the rest of PATH
      }
    }
  }
  return null
}

/**
 * Whether `agent`'s CLI is resolvable on `env`'s own PATH, without spawning
 * anything. The dashboard process (systemd --user, minimal PATH) and the MCP
 * server process (spawned by Claude Code, full user PATH) are separate
 * processes that share preflight-cache.json/discovery.json — a dashboard
 * write route must check this on ITS OWN env before ever calling
 * runPreflight/pingAgent/discovery for an agent, or a missing PATH entry on
 * the dashboard side alone would overwrite a good cached row with
 * 'unavailable' (ENOENT from spawn) even though the CLI is actually
 * installed and reachable by the MCP server.
 */
export function resolveAgentCli(agent, env = process.env) {
  const adapter = adapterFor(agent)
  const binPath = resolveBinPath(adapter.cmd, env)
  return { agent, cmd: adapter.cmd, binPath, resolvable: binPath !== null }
}

/**
 * Probe one agent CLI: binPath (PATH scan), L0 --version, L1 model catalog.
 * Never throws — every failure mode (missing binary, --version failure,
 * models-list timeout) is reported as an `error` string on the returned row.
 */
export async function discoverCli(agent, { env = process.env, commandRunner = runCommand } = {}) {
  const adapter = adapterFor(agent)
  const checkedAt = new Date().toISOString()
  const binPath = resolveBinPath(adapter.cmd, env)

  if (!binPath) {
    return { agent, cmd: adapter.cmd, binPath: null, version: null, models: [], checkedAt, error: 'not found on PATH' }
  }

  const versionResult = await commandRunner(adapter.cmd, ['--version'], { env, timeoutMs: 10_000 })
  if (versionResult.code !== 0 || versionResult.timedOut) {
    return { agent, cmd: adapter.cmd, binPath, version: null, models: [], checkedAt, error: 'L0 --version check failed' }
  }
  const version = (versionResult.stdout || '').trim().split(/\r?\n/)[0] || null

  if (agent === 'opencode') {
    // opencode's models-list argv is provider-scoped (derived from the
    // model id's "<provider>/..." prefix), unlike agy/copilot whose catalog
    // command ignores the model entirely. A single per-agent call would
    // silently miss every provider but the default one, so this probes each
    // provider actually referenced in DELEGATION_MAP once and merges the
    // results — still far fewer spawns than the old per-pair listing.
    const providers = opencodeProviders()
    const models = []
    const failedProviders = []
    for (const provider of providers) {
      const result = await commandRunner(adapter.cmd, modelsArgv(agent, `${provider}/probe`), { env, timeoutMs: 60_000 })
      if (result.timedOut || !result.stdout) {
        failedProviders.push(provider)
        continue
      }
      models.push(...adapter.listModels(result.stdout))
    }
    if (models.length === 0 && failedProviders.length === providers.length) {
      return { agent, cmd: adapter.cmd, binPath, version, models: [], checkedAt, error: 'model list timed out' }
    }
    return {
      agent,
      cmd: adapter.cmd,
      binPath,
      version,
      models,
      checkedAt,
      error: failedProviders.length > 0 ? `model list timed out for provider(s): ${failedProviders.join(', ')}` : null,
    }
  }

  const modelsResult = await commandRunner(adapter.cmd, modelsArgv(agent), { env, timeoutMs: 60_000 })
  if (modelsResult.timedOut || !modelsResult.stdout) {
    return { agent, cmd: adapter.cmd, binPath, version, models: [], checkedAt, error: 'model list timed out' }
  }

  const models = adapter.listModels(modelsResult.stdout)
  const entry = { agent, cmd: adapter.cmd, binPath, version, models, checkedAt, error: null }
  // copilot's --model allowlist is account-specific; the `help config`
  // catalog documents ids but most are rejected live — never authoritative
  // for account availability (only an L3 ping confirms that).
  if (agent === 'copilot') entry.note = 'catalog not authoritative'
  return entry
}

export function readDiscovery(env = process.env) {
  const { discoveryFile } = paths(env)
  try {
    return JSON.parse(fs.readFileSync(discoveryFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    return {}
  }
}

function isDiscoveryFresh(entry) {
  if (!entry?.checkedAt) return false
  return Date.now() - new Date(entry.checkedAt).getTime() < PREFLIGHT_TTL_MS
}

/**
 * Probe every requested agent (default: all three) in parallel via
 * Promise.allSettled, TTL-gated per agent against the existing
 * discovery.json (force:true bypasses the TTL). Writes the merged result
 * atomically and emits one {kind:'preflight', phase:'discovery'} event per
 * freshly-probed agent — never one for an agent served from cache.
 */
export async function runDiscovery({ agents = KNOWN_AGENTS, env = process.env, commandRunner = runCommand, force = false } = {}) {
  const existing = readDiscovery(env)

  const settled = await Promise.allSettled(
    agents.map(async (agent) => {
      if (!force && isDiscoveryFresh(existing[agent])) return { agent, entry: existing[agent], probed: false }

      const startedAt = Date.now()
      const entry = await discoverCli(agent, { env, commandRunner })
      appendEvent(
        {
          kind: 'preflight',
          phase: 'discovery',
          agent,
          status: entry.error ? 'error' : 'ok',
          reason: entry.error,
          latencyMs: Date.now() - startedAt,
          summary: `${agent} discovery: ${entry.error ?? 'ok'}`,
        },
        { env }
      )
      return { agent, entry, probed: true }
    })
  )

  const merged = { ...existing }
  agents.forEach((agent, i) => {
    const outcome = settled[i]
    if (outcome.status === 'fulfilled') {
      merged[agent] = outcome.value.entry
    } else {
      // Promise.allSettled means discoverCli itself never rejects in
      // practice (it catches every failure mode), but guard anyway so one
      // agent's unexpected throw never loses the others' results.
      merged[agent] = {
        agent,
        cmd: agent,
        binPath: null,
        version: null,
        models: [],
        checkedAt: new Date().toISOString(),
        error: outcome.reason?.message ?? String(outcome.reason),
      }
    }
  })

  writeJsonAtomic(paths(env).discoveryFile, merged)
  return merged
}

/** Every agent:model pair still reachable from DELEGATION_MAP's chains. */
function validPairKeys() {
  const keys = new Set()
  for (const entry of Object.values(DELEGATION_MAP)) {
    for (const candidate of entry.chain) {
      if (candidate.agent !== 'claude') keys.add(`${candidate.agent}:${candidate.model}`)
      if (candidate.parallelWith && candidate.parallelWith.agent !== 'claude') {
        keys.add(`${candidate.parallelWith.agent}:${candidate.parallelWith.model}`)
      }
    }
  }
  return keys
}

/**
 * "The board does not lie": drop preflight-cache.json rows for agent:model
 * pairs no longer reachable from DELEGATION_MAP (e.g. a copilot model that
 * was tried once and abandoned) so the dashboard never renders zombie rows.
 * Reads preflight-cache.json directly (not via preflight.mjs's readCache) to
 * avoid a circular import — preflight.mjs consumes discovery.mjs, not the
 * other way around.
 */
export function pruneCacheForMap(env = process.env) {
  const { preflightCacheFile } = paths(env)
  let cache = {}
  try {
    cache = JSON.parse(fs.readFileSync(preflightCacheFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') cache = {}
  }

  const valid = validPairKeys()
  const pruned = {}
  let removed = 0
  for (const [key, entry] of Object.entries(cache)) {
    if (valid.has(key)) pruned[key] = entry
    else removed++
  }

  if (removed > 0) writeJsonAtomic(preflightCacheFile, pruned)
  return { removed, remaining: Object.keys(pruned).length }
}
