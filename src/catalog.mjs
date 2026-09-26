import { PREFLIGHT_TTL_MS } from './config.mjs'

/**
 * Pure derivation of an agent CLI's live pricing tier from its catalog
 * (discovery.json), plus report-only drift between that catalog and
 * MODEL_REGISTRY/DELEGATION_MAP. Implements T11/T12 of
 * odd/tasks/opencode-v2-migration.md (see odd/tasks/opencode-live-catalog.md
 * for the full rationale).
 *
 * Deliberately pure and side-effect-free, like model-gaps.mjs: callers own
 * reading discovery.json/DELEGATION_MAP/MODEL_REGISTRY and deciding what to
 * persist or expose.
 */

function isFreshRow(entry) {
  if (!entry?.checkedAt) return false
  return Date.now() - new Date(entry.checkedAt).getTime() < PREFLIGHT_TTL_MS
}

/**
 * Pricing tier from one catalog model entry's `cost` (an array of
 * {input, output, cache} -- the first entry is the one opencode's
 * `api model.list` actually varies per model). Missing or empty cost is
 * 'unknown' (null): a model must be POSITIVELY confirmed input:0/output:0 to
 * report as free, never assumed free from absence of data.
 */
export function catalogTier(entry) {
  const cost = entry?.cost?.[0]
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return null
  if (cost.input === 0 && cost.output === 0) return 'free'
  if (cost.input > 0 || cost.output > 0) return 'paid'
  return null
}

/**
 * Effective tier for one agent:model pair: the live catalog's tier when a
 * fresh, error-free discovery row for `agent` actually lists `model`;
 * otherwise MODEL_REGISTRY's hand-written tier (or null if neither knows the
 * model). `tierSource` records which one won, so callers/UI can show
 * provenance instead of presenting a stale registry value as live fact.
 */
export function effectiveTier({ agent, model, discovery = {}, registry = {} }) {
  const row = discovery?.[agent]
  if (isFreshRow(row) && !row.error) {
    const entry = (row.models ?? []).find((m) => m.id === model)
    if (entry) return { tier: catalogTier(entry), tierSource: 'catalog' }
  }
  return { tier: registry?.[agent]?.[model]?.tier ?? null, tierSource: 'registry' }
}

/**
 * Drift between the live catalog and MODEL_REGISTRY/DELEGATION_MAP for one
 * `agent` (opencode by default -- the only CLI with an authoritative,
 * cost-bearing catalog today; see discovery.mjs's note on copilot/codex).
 * Report-only: this never mutates routing or the registry, mirroring
 * model-gaps.mjs's unmapped/versionBumps split.
 *
 * Only computed when that agent's discovery row is fresh and error-free --
 * a stale, missing, or errored row would otherwise report every pinned id
 * as "vanished", which is not evidence of anything.
 *
 * Returns an array of:
 *   {type: 'vanished', agent, model}            -- pinned id no longer in the catalog
 *   {type: 'now_paid', agent, model}             -- registry tier:'free', catalog cost > 0
 *   {type: 'new_free', agent, model}             -- catalog free model, absent from the registry
 *   {type: 'variant_unavailable', agent, model, variant} -- pinned registry variant not in catalog variants[]
 */
export function computeCatalogDrift({ discovery = {}, map = {}, registry = {}, agent = 'opencode' } = {}) {
  const row = discovery?.[agent]
  if (!isFreshRow(row) || row.error) return []

  const catalog = row.models ?? []
  const catalogById = new Map(catalog.filter((m) => m?.id).map((m) => [m.id, m]))
  const items = []

  // Every id pinned for `agent`, from MODEL_REGISTRY and from DELEGATION_MAP
  // chains -- either source can reference an id that later vanishes.
  const pinnedVariant = new Map() // id -> registry variant (or null)
  for (const [id, entry] of Object.entries(registry?.[agent] ?? {})) {
    pinnedVariant.set(id, entry?.variant ?? null)
  }
  for (const chainEntry of Object.values(map ?? {})) {
    for (const step of chainEntry?.chain ?? []) {
      if (step?.agent !== agent || !step.model) continue
      if (!pinnedVariant.has(step.model)) pinnedVariant.set(step.model, null)
    }
  }

  for (const [id, variant] of pinnedVariant) {
    const entry = catalogById.get(id)
    if (!entry) {
      items.push({ type: 'vanished', agent, model: id })
      continue
    }
    if (registry?.[agent]?.[id]?.tier === 'free' && catalogTier(entry) === 'paid') {
      items.push({ type: 'now_paid', agent, model: id })
    }
    if (variant) {
      const variants = entry.variants ?? []
      if (!variants.some((v) => v?.id === variant)) {
        items.push({ type: 'variant_unavailable', agent, model: id, variant })
      }
    }
  }

  const registrySet = new Set(Object.keys(registry?.[agent] ?? {}))
  for (const entry of catalog) {
    if (!entry?.id || registrySet.has(entry.id)) continue
    if (catalogTier(entry) === 'free') items.push({ type: 'new_free', agent, model: entry.id })
  }

  return items
}
