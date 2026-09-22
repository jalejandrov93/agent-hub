import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-proposals-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  const bust = `?t=${Date.now()}${Math.random()}`
  return {
    proposals: await import(`../src/proposals.mjs${bust}`),
    config: await import(`../src/config.mjs${bust}`),
    eventlog: await import(`../src/eventlog.mjs${bust}`),
  }
}

function row({ agent, model, mode = 'read', taskType, samples, succeeded, p50Ms = 1000 }) {
  return {
    agent,
    model,
    mode,
    taskType,
    samples,
    succeeded,
    failed: samples - succeeded,
    canceled: 0,
    successRate: samples === 0 ? null : succeeded / samples,
    p50Ms,
    p95Ms: p50Ms,
    errorKinds: {},
    tokensTotal: 0,
    tokensAvg: null,
  }
}

/** Writes a fake terminal job record under runs/, matching the JobRecord shape used by metrics.mjs. */
function writeJobRecord(home, { agent, model, mode = 'read', taskType, status = 'succeeded', ageMsAgo = 0 }) {
  const runsDir = path.join(home, 'runs')
  const jobId = `job-${crypto.randomUUID()}`
  const dir = path.join(runsDir, jobId)
  fs.mkdirSync(dir, { recursive: true })
  const createdAt = new Date(Date.now() - ageMsAgo - 1000).toISOString()
  const updatedAt = new Date(Date.now() - ageMsAgo).toISOString()
  fs.writeFileSync(
    path.join(dir, 'result.json'),
    JSON.stringify({ jobId, agent, model, mode, taskType, status, cwd: '/tmp', title: 't', createdAt, updatedAt })
  )
}

const RECON_MAP = {
  recon: {
    why: 'test',
    chain: [
      { agent: 'agy', model: 'flash-low', mode: 'read' },
      { agent: 'opencode', model: 'muse', mode: 'read' },
      { agent: 'claude', model: 'haiku' },
    ],
  },
}

test('wilson: n=0 gives the widest interval', async () => {
  const { proposals } = await fresh(tmpHome())
  assert.deepEqual(proposals.wilson(0, 0), { low: 0, high: 1 })
})

test('wilson: bounds sit within [0,1] and widen with fewer samples at the same rate', async () => {
  const { proposals } = await fresh(tmpHome())
  const few = proposals.wilson(9, 10)
  const many = proposals.wilson(90, 100)
  assert.ok(few.low >= 0 && few.high <= 1)
  assert.ok(many.low >= 0 && many.high <= 1)
  assert.ok(few.low < many.low, 'fewer samples at the same rate should have a lower (more conservative) lower bound')
  assert.ok(few.high > many.high, 'fewer samples at the same rate should have a higher upper bound')
})

test('computeProposals: no proposal when the primary is below minSamples', async () => {
  const { proposals } = await fresh(tmpHome())
  const metrics = {
    rows: [
      row({ agent: 'agy', model: 'flash-low', taskType: 'recon', samples: 3, succeeded: 3 }),
      row({ agent: 'opencode', model: 'muse', taskType: 'recon', samples: 20, succeeded: 20 }),
    ],
  }
  assert.deepEqual(proposals.computeProposals({ metrics, map: RECON_MAP, minSamples: 10 }), [])
})

test('computeProposals: no proposal when the challenger is below minSamples', async () => {
  const { proposals } = await fresh(tmpHome())
  const metrics = {
    rows: [
      row({ agent: 'agy', model: 'flash-low', taskType: 'recon', samples: 20, succeeded: 10 }),
      row({ agent: 'opencode', model: 'muse', taskType: 'recon', samples: 3, succeeded: 3 }),
    ],
  }
  assert.deepEqual(proposals.computeProposals({ metrics, map: RECON_MAP, minSamples: 10 }), [])
})

test('computeProposals: no proposal when challenger wilson-low does not exceed primary wilson-high', async () => {
  const { proposals } = await fresh(tmpHome())
  const metrics = {
    rows: [
      row({ agent: 'agy', model: 'flash-low', taskType: 'recon', samples: 20, succeeded: 18 }),
      row({ agent: 'opencode', model: 'muse', taskType: 'recon', samples: 20, succeeded: 19 }),
    ],
  }
  assert.deepEqual(proposals.computeProposals({ metrics, map: RECON_MAP, minSamples: 10 }), [])
})

test('computeProposals: proposes promoting a clearly better challenger with correct toOrder/evidence/reason', async () => {
  const { proposals } = await fresh(tmpHome())
  const metrics = {
    rows: [
      row({ agent: 'agy', model: 'flash-low', taskType: 'recon', samples: 14, succeeded: 8 }),
      row({ agent: 'opencode', model: 'muse', taskType: 'recon', samples: 18, succeeded: 18 }),
    ],
  }
  const result = proposals.computeProposals({ metrics, map: RECON_MAP, minSamples: 10 })
  assert.equal(result.length, 1)
  const p = result[0]
  assert.equal(p.taskType, 'recon')
  assert.equal(p.chainHash, proposals.chainHash(RECON_MAP.recon.chain))
  assert.deepEqual(p.fromOrder, [
    { agent: 'agy', model: 'flash-low' },
    { agent: 'opencode', model: 'muse' },
  ])
  assert.deepEqual(p.toOrder, [
    { agent: 'opencode', model: 'muse' },
    { agent: 'agy', model: 'flash-low' },
  ])
  assert.equal(Object.keys(p.evidence).length, 2)
  assert.ok(!('claude:haiku' in p.evidence), 'claude steps must never appear in evidence')
  assert.equal(p.evidence['opencode:muse'].samples, 18)
  assert.equal(p.evidence['agy:flash-low'].samples, 14)
  assert.match(p.reason, /opencode:muse/)
  assert.match(p.reason, /agy:flash-low/)
  assert.match(p.reason, /recon/)
})

test('acceptedOrderFor: claude steps keep their original index; parallelWith travels with its step', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const chain = [
    { agent: 'claude', model: 'haiku' },
    { agent: 'agy', model: 'flash-low', mode: 'read', parallelWith: { agent: 'copilot', model: 'auto', mode: 'read' } },
    { agent: 'opencode', model: 'muse', mode: 'read' },
  ]
  const hash = proposals.chainHash(chain)

  // Seed one accepted proposal directly (bypassing refresh, since we only need acceptedOrderFor here).
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).proposalsFile, {
    version: 1,
    proposals: [
      {
        id: 'prop-1',
        taskType: 'recon',
        chainHash: hash,
        fromOrder: [
          { agent: 'agy', model: 'flash-low' },
          { agent: 'opencode', model: 'muse' },
        ],
        toOrder: [
          { agent: 'opencode', model: 'muse' },
          { agent: 'agy', model: 'flash-low' },
        ],
        evidence: {},
        reason: 'r',
        status: 'accepted',
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      },
    ],
  })

  const env = { AGENT_HUB_HOME: home }
  const applied = proposals.acceptedOrderFor('recon', env, { chain })
  assert.ok(applied)
  assert.equal(applied.proposalId, 'prop-1')
  assert.equal(applied.chain[0].agent, 'claude', 'claude step stays at index 0')
  assert.equal(applied.chain[1].agent, 'opencode', 'best challenger promoted to first CLI slot')
  assert.equal(applied.chain[2].agent, 'agy')
  assert.deepEqual(applied.chain[2].parallelWith, { agent: 'copilot', model: 'auto', mode: 'read' }, 'parallelWith stays attached to its original step')
})

test('acceptedOrderFor: null with no chain, or with no matching accepted proposal', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  assert.equal(proposals.acceptedOrderFor('recon', env), null)
  assert.equal(proposals.acceptedOrderFor('recon', env, { chain: RECON_MAP.recon.chain }), null)
})

test('refreshProposals: persists one pending proposal and emits a proposal.created event', async () => {
  const home = tmpHome()
  const { proposals, eventlog } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }

  for (let i = 0; i < 14; i++) writeJobRecord(home, { agent: 'agy', model: 'flash-low', taskType: 'recon', status: i < 8 ? 'succeeded' : 'failed' })
  for (let i = 0; i < 18; i++) writeJobRecord(home, { agent: 'opencode', model: 'muse', taskType: 'recon', status: 'succeeded' })

  const result = proposals.refreshProposals({ env, map: RECON_MAP })
  assert.equal(result.length, 1)
  assert.equal(result[0].status, 'pending')
  assert.equal(result[0].taskType, 'recon')

  const stored = proposals.listProposals({}, env)
  assert.equal(stored.length, 1)

  const tail = eventlog.readTail({ env })
  assert.ok(tail.some((e) => e.kind === 'proposal.created' && e.taskType === 'recon'))
})

test('refreshProposals: at most one pending proposal per task type', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }

  for (let i = 0; i < 14; i++) writeJobRecord(home, { agent: 'agy', model: 'flash-low', taskType: 'recon', status: i < 8 ? 'succeeded' : 'failed' })
  for (let i = 0; i < 18; i++) writeJobRecord(home, { agent: 'opencode', model: 'muse', taskType: 'recon', status: 'succeeded' })

  proposals.refreshProposals({ env, map: RECON_MAP })
  const second = proposals.refreshProposals({ env, map: RECON_MAP })
  assert.equal(second.filter((p) => p.taskType === 'recon').length, 1)
})

test('refreshProposals: cooldown suppresses a new proposal shortly after rejection, but not after it expires', async () => {
  const home = tmpHome()
  const { proposals, config } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }

  for (let i = 0; i < 14; i++) writeJobRecord(home, { agent: 'agy', model: 'flash-low', taskType: 'recon', status: i < 8 ? 'succeeded' : 'failed' })
  for (let i = 0; i < 18; i++) writeJobRecord(home, { agent: 'opencode', model: 'muse', taskType: 'recon', status: 'succeeded' })

  const [first] = proposals.refreshProposals({ env, map: RECON_MAP })
  proposals.decideProposal(first.id, 'rejected', env)

  const soon = proposals.refreshProposals({ env, map: RECON_MAP, now: new Date() })
  assert.equal(soon.filter((p) => p.status === 'pending' && p.taskType === 'recon').length, 0, 'still in cooldown')

  const later = proposals.refreshProposals({
    env,
    map: RECON_MAP,
    now: new Date(Date.now() + config.PROPOSAL_REJECT_COOLDOWN_MS + 1000),
  })
  assert.equal(later.filter((p) => p.status === 'pending' && p.taskType === 'recon').length, 1, 'cooldown expired')
})

test('refreshProposals: a chainHash change supersedes stale pending/accepted proposals', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }

  for (let i = 0; i < 14; i++) writeJobRecord(home, { agent: 'agy', model: 'flash-low', taskType: 'recon', status: i < 8 ? 'succeeded' : 'failed' })
  for (let i = 0; i < 18; i++) writeJobRecord(home, { agent: 'opencode', model: 'muse', taskType: 'recon', status: 'succeeded' })

  const [pending] = proposals.refreshProposals({ env, map: RECON_MAP })
  assert.equal(pending.status, 'pending')

  const changedMap = {
    recon: {
      why: 'test',
      chain: [
        { agent: 'agy', model: 'flash-low', mode: 'write' }, // mode change flips the hash
        { agent: 'opencode', model: 'muse', mode: 'read' },
        { agent: 'claude', model: 'haiku' },
      ],
    },
  }
  const afterChange = proposals.refreshProposals({ env, map: changedMap })
  const supersededOld = afterChange.find((p) => p.id === pending.id)
  assert.equal(supersededOld.status, 'superseded')
})

test('decideProposal: accept/reject happy paths and error cases', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }

  for (let i = 0; i < 14; i++) writeJobRecord(home, { agent: 'agy', model: 'flash-low', taskType: 'recon', status: i < 8 ? 'succeeded' : 'failed' })
  for (let i = 0; i < 18; i++) writeJobRecord(home, { agent: 'opencode', model: 'muse', taskType: 'recon', status: 'succeeded' })

  const [created] = proposals.refreshProposals({ env, map: RECON_MAP })
  const accepted = proposals.decideProposal(created.id, 'accepted', env)
  assert.equal(accepted.status, 'accepted')
  assert.ok(accepted.decidedAt)

  assert.throws(() => proposals.decideProposal('nope', 'accepted', env), /proposal not found: nope/)
  assert.throws(() => proposals.decideProposal(created.id, 'accepted', env), /proposal not pending/)
  assert.throws(() => proposals.decideProposal(created.id, 'bogus', env), /invalid proposal status/)
})

test('decideProposal: accepting one proposal supersedes an older accepted proposal for the same task type', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())

  const base = { chainHash: 'h', fromOrder: [], toOrder: [], evidence: {}, reason: 'r', createdAt: new Date().toISOString() }
  writeJsonAtomic(paths(env).proposalsFile, {
    version: 1,
    proposals: [
      { ...base, id: 'old', taskType: 'recon', status: 'accepted', decidedAt: new Date().toISOString() },
      { ...base, id: 'new', taskType: 'recon', status: 'pending', decidedAt: null },
    ],
  })

  proposals.decideProposal('new', 'accepted', env)
  const stored = proposals.listProposals({}, env)
  assert.equal(stored.find((p) => p.id === 'old').status, 'superseded')
  assert.equal(stored.find((p) => p.id === 'new').status, 'accepted')
})

// --- add_candidate (T3: model autodiscover) ---

const RECON_VERSIONED_MAP = {
  recon: {
    why: 'test',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      { agent: 'claude', model: 'haiku' },
    ],
  },
}

test('refreshProposals: creates a pending add_candidate proposal for a detected version bump', async () => {
  const home = tmpHome()
  const { proposals, config } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const discovery = { agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }] } }

  const result = proposals.refreshProposals({ env, map: RECON_VERSIONED_MAP, discovery, registry: config.MODEL_REGISTRY })
  const added = result.filter((p) => p.kind === 'add_candidate')
  assert.equal(added.length, 1)
  const p = added[0]
  assert.equal(p.taskType, 'recon')
  assert.equal(p.status, 'pending')
  assert.equal(p.chainHash, proposals.chainHash(RECON_VERSIONED_MAP.recon.chain))
  assert.deepEqual(p.addCandidate, { agent: 'agy', model: 'gemini-3.9-flash-low', mode: 'read' })
  assert.equal(p.replaces, 'gemini-3.8-flash-low')
})

test('refreshProposals: does not duplicate a pending add_candidate proposal on a second refresh', async () => {
  const home = tmpHome()
  const { proposals, config } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const discovery = { agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }] } }

  proposals.refreshProposals({ env, map: RECON_VERSIONED_MAP, discovery, registry: config.MODEL_REGISTRY })
  const second = proposals.refreshProposals({ env, map: RECON_VERSIONED_MAP, discovery, registry: config.MODEL_REGISTRY })
  assert.equal(second.filter((p) => p.kind === 'add_candidate' && p.taskType === 'recon').length, 1)
})

test('refreshProposals: cooldown suppresses a rejected add_candidate proposal from being recreated until it expires', async () => {
  const home = tmpHome()
  const { proposals, config } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const discovery = { agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }] } }

  const [created] = proposals
    .refreshProposals({ env, map: RECON_VERSIONED_MAP, discovery, registry: config.MODEL_REGISTRY })
    .filter((p) => p.kind === 'add_candidate')
  proposals.decideProposal(created.id, 'rejected', env)

  const soon = proposals.refreshProposals({ env, map: RECON_VERSIONED_MAP, discovery, registry: config.MODEL_REGISTRY, now: new Date() })
  assert.equal(soon.filter((p) => p.kind === 'add_candidate' && p.status === 'pending').length, 0, 'still in cooldown')

  const later = proposals.refreshProposals({
    env,
    map: RECON_VERSIONED_MAP,
    discovery,
    registry: config.MODEL_REGISTRY,
    now: new Date(Date.now() + config.PROPOSAL_REJECT_COOLDOWN_MS + 1000),
  })
  assert.equal(later.filter((p) => p.kind === 'add_candidate' && p.status === 'pending').length, 1, 'cooldown expired')
})

test('refreshProposals: an add_candidate proposal never blocks a reorder proposal for the same taskType, and vice versa', async () => {
  const home = tmpHome()
  const { proposals, config } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const discovery = { agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }] } }

  for (let i = 0; i < 14; i++) writeJobRecord(home, { agent: 'agy', model: 'gemini-3.8-flash-low', taskType: 'recon', status: i < 8 ? 'succeeded' : 'failed' })
  for (let i = 0; i < 18; i++) writeJobRecord(home, { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', taskType: 'recon', status: 'succeeded' })

  const result = proposals.refreshProposals({ env, map: RECON_VERSIONED_MAP, discovery, registry: config.MODEL_REGISTRY })
  assert.equal(result.filter((p) => p.kind === 'add_candidate' && p.taskType === 'recon').length, 1)
  assert.equal(result.filter((p) => (p.kind ?? 'reorder') === 'reorder' && p.taskType === 'recon').length, 1)
})

test('effectiveChainFor: appends an accepted add_candidate step at the tail, never displacing index 0', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const chain = RECON_VERSIONED_MAP.recon.chain
  const hash = proposals.chainHash(chain)

  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  writeJsonAtomic(paths(env).proposalsFile, {
    version: 1,
    proposals: [
      {
        id: 'prop-add-1',
        taskType: 'recon',
        kind: 'add_candidate',
        chainHash: hash,
        fromOrder: [],
        toOrder: [],
        addCandidate: { agent: 'agy', model: 'gemini-3.9-flash-low', mode: 'read' },
        replaces: 'gemini-3.8-flash-low',
        evidence: {},
        reason: 'r',
        status: 'accepted',
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      },
    ],
  })

  const effective = proposals.effectiveChainFor('recon', chain, env)
  assert.equal(effective.length, chain.length + 1)
  assert.deepEqual(effective.slice(0, chain.length), chain, 'original chain steps stay in place')
  assert.deepEqual(effective[effective.length - 1], { agent: 'agy', model: 'gemini-3.9-flash-low', mode: 'read' })
})

test('effectiveChainFor: returns the same chain unchanged when there is no accepted add_candidate proposal', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const chain = RECON_VERSIONED_MAP.recon.chain
  assert.deepEqual(proposals.effectiveChainFor('recon', chain, env), chain)
})
