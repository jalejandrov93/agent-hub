import crypto from 'node:crypto'
import { paths, METRICS_MIN_SAMPLES, PROPOSAL_REJECT_COOLDOWN_MS } from './config.mjs'
import { readJsonSafe, updateJsonLocked } from './fsutil.mjs'
import { appendEvent } from './eventlog.mjs'
import { computeMetrics } from './metrics.mjs'

/**
 * Routing proposals: evidence-backed reorders of a DELEGATION_MAP chain,
 * persisted in proposals.json ({version:1, proposals:[...]}) and applied by
 * route() only after a human accepts them in the dashboard.
 *
 * Deliberately does NOT import router.mjs: router.mjs imports this module to
 * apply an accepted proposal, so the reverse import would be a cycle. Callers
 * pass the delegation map / chain in explicitly instead.
 */

const DEFAULT_PROPOSALS_FILE = { version: 1, proposals: [] }

function pairKey(pair) {
  return `${pair.agent}:${pair.model}`
}

/**
 * sha1 of the JSON-normalized chain (first 12 hex chars). Used to detect
 * whether DELEGATION_MAP changed underneath a stored proposal.
 */
export function chainHash(chain) {
  const normalized = chain.map((step) => {
    const out = { agent: step.agent, model: step.model, mode: step.mode }
    if (step.parallelWith) out.parallelWith = step.parallelWith
    return out
  })
  return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex').slice(0, 12)
}

/**
 * 95% Wilson score interval for `successes` out of `n` trials. With n=0
 * there is no evidence either way, so the interval is the widest possible.
 */
export function wilson(successes, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 1 }
  const phat = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = phat + z2 / (2 * n)
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))
  return { low: (center - margin) / denom, high: (center + margin) / denom }
}

function findRow(rows, candidate, taskType) {
  const mode = candidate.mode ?? 'read'
  return (
    rows.find((r) => r.agent === candidate.agent && r.model === candidate.model && r.mode === mode && r.taskType === taskType) ?? null
  )
}

/**
 * Pure: proposals suggested by `metrics` ({rows}) for `map` (DELEGATION_MAP
 * shape: {taskType: {why, chain}}). For each taskType, compares the current
 * primary CLI candidate (first non-claude step) against the other CLI
 * candidates and proposes promoting whichever one has a strictly better,
 * non-overlapping Wilson lower bound once both have enough samples.
 */
export function computeProposals({ metrics, map, minSamples = METRICS_MIN_SAMPLES, now = new Date() } = {}) {
  void now
  const rows = metrics?.rows ?? []
  const proposals = []

  for (const [taskType, entry] of Object.entries(map ?? {})) {
    const chain = entry.chain ?? []
    const cliCandidates = chain.filter((step) => step.agent !== 'claude')
    if (cliCandidates.length < 2) continue

    const primary = cliCandidates[0]
    const others = cliCandidates.slice(1)

    const primaryRow = findRow(rows, primary, taskType)
    if (!primaryRow || primaryRow.samples < minSamples) continue

    const eligible = []
    for (const candidate of others) {
      const row = findRow(rows, candidate, taskType)
      if (row && row.samples >= minSamples) eligible.push({ candidate, row })
    }
    if (eligible.length === 0) continue

    const primaryWilson = wilson(primaryRow.succeeded, primaryRow.samples)

    let best = null
    for (const { candidate, row } of eligible) {
      const w = wilson(row.succeeded, row.samples)
      if (!best || w.low > best.wilson.low) best = { candidate, row, wilson: w }
    }

    if (best.wilson.low <= primaryWilson.high) continue

    const toOrder = [best.candidate, ...cliCandidates.filter((c) => c !== best.candidate)]

    const evidence = {}
    for (const candidate of cliCandidates) {
      const row = findRow(rows, candidate, taskType)
      if (!row) continue
      evidence[pairKey(candidate)] = {
        samples: row.samples,
        successRate: row.successRate,
        wilsonLow: wilson(row.succeeded, row.samples).low,
        wilsonHigh: wilson(row.succeeded, row.samples).high,
        p50Ms: row.p50Ms,
      }
    }

    const reason = `${pairKey(best.candidate)} succeeded ${best.row.succeeded}/${best.row.samples} (wilson low ${best.wilson.low.toFixed(2)}) vs ${pairKey(primary)} ${primaryRow.succeeded}/${primaryRow.samples} (wilson high ${primaryWilson.high.toFixed(2)}) for ${taskType}`

    proposals.push({
      taskType,
      chainHash: chainHash(chain),
      fromOrder: cliCandidates.map((c) => ({ agent: c.agent, model: c.model })),
      toOrder: toOrder.map((c) => ({ agent: c.agent, model: c.model })),
      evidence,
      reason,
    })
  }

  return proposals
}

function sameToOrder(a, b) {
  if (a.length !== b.length) return false
  return a.every((pair, i) => pair.agent === b[i].agent && pair.model === b[i].model)
}

/** Recompute from current metrics, persist new pending proposals, return every stored proposal. */
export function refreshProposals({ env = process.env, map = {}, now = new Date() } = {}) {
  const { proposalsFile } = paths(env)
  const metrics = computeMetrics({ env })
  const computed = computeProposals({ metrics, map, now })
  const created = []

  const result = updateJsonLocked(
    proposalsFile,
    (data) => {
      for (const proposal of data.proposals) {
        if (proposal.status !== 'pending' && proposal.status !== 'accepted') continue
        const entry = map[proposal.taskType]
        if (!entry) continue
        const currentHash = chainHash(entry.chain)
        if (proposal.chainHash !== currentHash) {
          proposal.status = 'superseded'
          proposal.decidedAt = now.toISOString()
        }
      }

      for (const candidate of computed) {
        const hasPending = data.proposals.some((p) => p.taskType === candidate.taskType && p.status === 'pending')
        if (hasPending) continue

        const recentlyRejected = data.proposals.some(
          (p) =>
            p.taskType === candidate.taskType &&
            p.status === 'rejected' &&
            p.decidedAt &&
            now.getTime() - new Date(p.decidedAt).getTime() < PROPOSAL_REJECT_COOLDOWN_MS
        )
        if (recentlyRejected) continue

        const alreadyAccepted = data.proposals.some(
          (p) => p.taskType === candidate.taskType && p.status === 'accepted' && p.chainHash === candidate.chainHash && sameToOrder(p.toOrder, candidate.toOrder)
        )
        if (alreadyAccepted) continue

        const proposal = {
          id: `prop-${candidate.taskType}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
          taskType: candidate.taskType,
          chainHash: candidate.chainHash,
          fromOrder: candidate.fromOrder,
          toOrder: candidate.toOrder,
          evidence: candidate.evidence,
          reason: candidate.reason,
          status: 'pending',
          createdAt: now.toISOString(),
          decidedAt: null,
        }
        data.proposals.push(proposal)
        created.push(proposal)
      }

      return data
    },
    { defaultValue: DEFAULT_PROPOSALS_FILE }
  )

  for (const proposal of created) {
    appendEvent({ kind: 'proposal.created', taskType: proposal.taskType, summary: proposal.reason }, { env })
  }

  return result.proposals
}

/** Stored proposals, optionally filtered by status. */
export function listProposals({ status } = {}, env = process.env) {
  const { proposalsFile } = paths(env)
  const data = readJsonSafe(proposalsFile, DEFAULT_PROPOSALS_FILE)
  return status ? data.proposals.filter((p) => p.status === status) : data.proposals
}

/** Accept or reject a pending proposal. Throws `proposal not found: <id>` or `proposal not pending: <id>`. */
export function decideProposal(id, status, env = process.env) {
  if (status !== 'accepted' && status !== 'rejected') {
    throw new Error(`invalid proposal status: ${status}`)
  }

  const { proposalsFile } = paths(env)
  const decidedAt = new Date().toISOString()
  let decided

  updateJsonLocked(
    proposalsFile,
    (data) => {
      const proposal = data.proposals.find((p) => p.id === id)
      if (!proposal) throw new Error(`proposal not found: ${id}`)
      if (proposal.status !== 'pending') throw new Error(`proposal not pending: ${id}`)

      proposal.status = status
      proposal.decidedAt = decidedAt

      if (status === 'accepted') {
        for (const other of data.proposals) {
          if (other !== proposal && other.taskType === proposal.taskType && other.status === 'accepted') {
            other.status = 'superseded'
            other.decidedAt = decidedAt
          }
        }
      }

      decided = proposal
      return data
    },
    { defaultValue: DEFAULT_PROPOSALS_FILE }
  )

  appendEvent({ kind: 'proposal.decided', taskType: decided.taskType, summary: `${status} ${id}` }, { env })
  return decided
}

/**
 * The accepted chain order for a task type, or null when no chain was passed
 * or no accepted proposal matches this exact chain (by chainHash). Claude
 * steps keep their original indexes; CLI step slots are filled in toOrder
 * order using the original step objects (preserving mode/parallelWith); any
 * CLI step missing from toOrder keeps its relative order after the listed ones.
 */
export function acceptedOrderFor(taskType, env = process.env, { chain } = {}) {
  if (!chain) return null

  const hash = chainHash(chain)
  const { proposalsFile } = paths(env)
  const data = readJsonSafe(proposalsFile, DEFAULT_PROPOSALS_FILE)
  const accepted = data.proposals.find((p) => p.taskType === taskType && p.status === 'accepted' && p.chainHash === hash)
  if (!accepted) return null

  const cliOriginal = chain.filter((s) => s.agent !== 'claude')
  const byKey = new Map(cliOriginal.map((s) => [pairKey(s), s]))
  const usedKeys = new Set()
  const orderedCli = []

  for (const pair of accepted.toOrder) {
    const key = pairKey(pair)
    const step = byKey.get(key)
    if (step && !usedKeys.has(key)) {
      orderedCli.push(step)
      usedKeys.add(key)
    }
  }
  for (const step of cliOriginal) {
    const key = pairKey(step)
    if (!usedKeys.has(key)) {
      orderedCli.push(step)
      usedKeys.add(key)
    }
  }

  let cliIndex = 0
  const reorderedChain = chain.map((step) => (step.agent === 'claude' ? step : orderedCli[cliIndex++]))

  return { chain: reorderedChain, proposalId: accepted.id }
}
