import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TASK_TYPES,
  EVENT_KINDS,
  LEARNING_TEXT_MAX,
  TaskType,
  JobRecord,
  AgentStatusRow,
  HubEvent,
  StateResponse,
  ConfigResponse,
  MetricsResponse,
  ProposalsFile,
  LearningsFile,
  LearningInput,
  RouteResult,
  JobResultResponse,
  DelegateResponse,
  RemoteInfo,
} from '../src/schemas.mjs'
import { DELEGATION_MAP } from '../src/router.mjs'
import { VALID_KINDS } from '../src/eventlog.mjs'
import { LEARNING_TEXT_MAX as CONFIG_LEARNING_TEXT_MAX } from '../src/config.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'v2')
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

test('TASK_TYPES matches the delegation map keys exactly', () => {
  assert.deepEqual([...TASK_TYPES].sort(), Object.keys(DELEGATION_MAP).sort())
})

test('EVENT_KINDS matches the event log kinds, including proposal and learning kinds', () => {
  assert.deepEqual([...EVENT_KINDS].sort(), [...VALID_KINDS].sort())
  for (const kind of ['proposal.created', 'proposal.decided', 'learning.proposed', 'learning.decided']) {
    assert.ok(EVENT_KINDS.includes(kind), kind)
  }
})

test('LEARNING_TEXT_MAX is the same in the browser-safe schemas and the server config', () => {
  assert.equal(LEARNING_TEXT_MAX, CONFIG_LEARNING_TEXT_MAX)
})

test('schemas.mjs imports nothing but zod, so the dashboard can bundle it', () => {
  const source = fs.readFileSync(new URL('../src/schemas.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['zod'])
})

test('a live /api/state capture parses, and unknown extra fields are kept', () => {
  const state = fixture('state.json')
  const parsed = StateResponse.parse(state)
  assert.equal(parsed.jobs.length, state.jobs.length)
  assert.ok(parsed.jobs.some((j) => j.status === 'failed'))
  const withExtra = JobRecord.parse({ ...state.jobs[0], somethingNew: 1 })
  assert.equal(withExtra.somethingNew, 1)
})

test('a live /api/config capture parses', () => {
  const config = ConfigResponse.parse(fixture('config.json'))
  assert.ok(config.delegationMap.recon.chain.length > 0)
})

test('agent rows and events accept every status and kind seen live', () => {
  const state = fixture('state.json')
  for (const row of state.agents) AgentStatusRow.parse(row)
  for (const event of state.events) HubEvent.parse(event)
})

test('v2 job fields parse: taskType, turnDepth, timeoutSource, learningIds', () => {
  const base = fixture('state.json').jobs[0]
  const job = JobRecord.parse({ ...base, taskType: 'recon', turnDepth: 2, timeoutSource: 'adaptive', learningIds: ['l-1'] })
  assert.equal(job.taskType, 'recon')
  assert.throws(() => JobRecord.parse({ ...base, taskType: 'not-a-task' }))
  assert.throws(() => TaskType.parse('free text'))
})

test('metrics, proposals and learnings fixtures parse', () => {
  MetricsResponse.parse(fixture('metrics.json'))
  ProposalsFile.parse(fixture('proposals.json'))
  LearningsFile.parse(fixture('learnings.json'))
})

test('LearningInput rejects empty and over-long text', () => {
  assert.throws(() => LearningInput.parse({ text: '' }))
  assert.throws(() => LearningInput.parse({ text: 'x'.repeat(LEARNING_TEXT_MAX + 1) }))
  assert.equal(LearningInput.parse({ text: 'agy hangs on X', agent: 'agy' }).agent, 'agy')
})

test('RemoteInfo requires only provider and sessionId, everything else nullable/optional', () => {
  const remote = RemoteInfo.parse({ provider: 'jules', sessionId: 'sess-1' })
  assert.equal(remote.provider, 'jules')
  assert.equal(remote.sessionId, 'sess-1')

  const full = RemoteInfo.parse({
    provider: 'jules',
    accountId: null,
    sessionId: 'sess-1',
    sessionUrl: 'https://jules.google.com/session/sess-1',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    state: 'IN_PROGRESS',
    prUrl: null,
    activityCursor: 'tok-2',
    seenActivityIds: ['a1', 'a2'],
    lastPolledAt: '2026-09-15T00:00:00.000Z',
  })
  assert.equal(full.state, 'IN_PROGRESS')

  assert.throws(() => RemoteInfo.parse({ sessionId: 'sess-1' }), /provider/)
  assert.throws(() => RemoteInfo.parse({ provider: 'jules' }), /sessionId/)
})

test('JobRecord accepts an optional remote block for a Jules job, and is unaffected for a local job', () => {
  const base = fixture('state.json').jobs[0]
  const remoteJob = JobRecord.parse({ ...base, agent: 'jules', model: 'jules', remote: { provider: 'jules', sessionId: 'sess-1' } })
  assert.equal(remoteJob.remote.sessionId, 'sess-1')

  const localJob = JobRecord.parse(base)
  assert.equal(localJob.remote, undefined)
})

test('tool response schemas accept current outputs', () => {
  RouteResult.parse({
    primary: { agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' },
    fallbacks: [{ agent: 'claude', model: 'haiku' }],
    skipped: [{ agent: 'copilot', model: 'auto', reason: 'breaker_open' }],
    discovery: { agy: { binPath: '/usr/bin/agy', version: '1.2.3', modelCount: 14, checkedAt: '2026-09-15T00:00:00.000Z', error: null }, opencode: null },
    reason: 'why',
  })
  RouteResult.parse({ primary: null, fallbacks: [], skipped: [], discovery: {}, reason: 'none', appliedProposal: { id: 'p-1' } })
  JobResultResponse.parse({ text: 'x', truncated: false, fullPath: '/tmp/r.txt', tokens: null, costUsd: null, sessionId: null, status: 'succeeded', errorKind: null })
  DelegateResponse.parse({ jobId: null, status: 'failed', errorKind: 'worktree_denied' })
  DelegateResponse.parse({ jobId: 'j', status: 'running', errorKind: null, parentJobId: 'p', turnDepth: 5, warning: 'deep' })
})
