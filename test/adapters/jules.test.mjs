import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  id,
  remote,
  TERMINAL_STATES,
  isTerminalState,
  buildSessionRequest,
  activityLines,
  summarizeActivities,
  sessionState,
  prUrlFromSession,
  branchFromSession,
  sessionUrl,
  buildResponseText,
  classifyError,
} from '../../src/cloud/jules/adapter.mjs'
import { createSession } from '../../src/cloud/jules/client.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'jules')
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const activitiesOf = (name) => readJson(name).activities

test('exposes the jules provider identity', () => {
  assert.equal(id, 'jules')
  assert.equal(remote, true)
})

test('isTerminalState is true only for COMPLETED and FAILED', () => {
  assert.ok(TERMINAL_STATES instanceof Set)
  assert.equal(isTerminalState('COMPLETED'), true)
  assert.equal(isTerminalState('FAILED'), true)
  assert.equal(isTerminalState('IN_PROGRESS'), false)
  assert.equal(isTerminalState(undefined), false)
})

test('buildSessionRequest applies defaults and omits an absent title', () => {
  const request = buildSessionRequest({
    prompt: 'do the thing',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
  })
  assert.deepEqual(request, {
    prompt: 'do the thing',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    requirePlanApproval: false,
    automationMode: 'AUTO_CREATE_PR',
  })
})

test('buildSessionRequest keeps an explicit title, requirePlanApproval and automationMode', () => {
  const request = buildSessionRequest({
    prompt: 'p',
    source: 'sources/github/acme/widgets',
    startingBranch: 'dev',
    title: 'Fix paginate',
    requirePlanApproval: true,
    automationMode: 'AUTO_CREATE_PR',
  })
  assert.equal(request.title, 'Fix paginate')
  assert.equal(request.requirePlanApproval, true)
  assert.equal(request.automationMode, 'AUTO_CREATE_PR')
})

test('buildSessionRequest throws when prompt or source is missing', () => {
  assert.throws(() => buildSessionRequest({ source: 'sources/github/acme/widgets' }), /prompt/)
  assert.throws(() => buildSessionRequest({ prompt: 'p' }), /source/)
})

test('buildSessionRequest is the createSession argument set: spread into createSession it yields the nested wire body', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body })
    return { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: async () => '{}' }
  }
  const request = buildSessionRequest({
    prompt: 'p',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
  })
  assert.equal('sourceContext' in request, false, 'the request set is flat, never the wire body')

  await createSession({ apiKey: 'k', fetchImpl, ...request })
  assert.deepEqual(JSON.parse(calls[0].body), {
    prompt: 'p',
    sourceContext: { source: 'sources/github/acme/widgets', githubRepoContext: { startingBranch: 'main' } },
    requirePlanApproval: false,
    automationMode: 'AUTO_CREATE_PR',
  })
})

test('activityLines renders planGenerated with a header and one numbered line per step', () => {
  assert.deepEqual(activityLines(activitiesOf('activities-plan-generated.json')), [
    '[jules] plan generated: 3 step(s)',
    '[jules]   1. Inspect the repository',
    '[jules]   2. Implement the change',
    '[jules]   3. Run the test suite',
  ])
})

test('activityLines renders a planGenerated with no steps as 0 step(s) and no step lines', () => {
  assert.deepEqual(activityLines([{ planGenerated: {} }]), ['[jules] plan generated: 0 step(s)'])
})

test('activityLines renders planApproved, userMessaged and agentMessaged', () => {
  assert.deepEqual(activityLines(activitiesOf('activities-plan-approved.json')), ['[jules] plan approved'])
  assert.deepEqual(activityLines(activitiesOf('activities-user-messaged.json')), [
    '[jules] user: Please also add a regression test',
  ])
  assert.deepEqual(activityLines(activitiesOf('activities-agent-messaged.json')), [
    '[jules] agent: I updated the parser and added a regression test',
  ])
})

test('activityLines renders progressUpdated with an em-dash description', () => {
  assert.deepEqual(activityLines(activitiesOf('activities-progress-updated.json')), [
    '[jules] progress: Running tests — Executing node --test',
  ])
  assert.deepEqual(activityLines([{ progressUpdated: { title: 'Planning' } }]), ['[jules] progress: Planning'])
})

test('activityLines renders sessionCompleted and its pull request url', () => {
  assert.deepEqual(activityLines(activitiesOf('activities-session-completed.json')), [
    '[jules] session completed',
    '[jules] pull request: https://github.com/acme/widgets/pull/42',
  ])
})

test('activityLines renders sessionFailed with and without a reason', () => {
  assert.deepEqual(activityLines(activitiesOf('activities-session-failed.json')), [
    '[jules] session failed: Tests failed after 3 attempts',
  ])
  assert.deepEqual(activityLines([{ sessionFailed: {} }]), ['[jules] session failed'])
})

test('activityLines appends a change set line after the activity line, counting diff lines', () => {
  assert.deepEqual(activityLines(activitiesOf('activities-change-set.json')), [
    '[jules] agent: Draft change set ready',
    '[jules] change set: Fix off-by-one in paginate() (6 diff lines)',
  ])
})

test('activityLines uses "(no commit message)" and 0 diff lines for a sparse change set', () => {
  assert.deepEqual(activityLines([{ changeSet: {} }]), ['[jules] change set: (no commit message) (0 diff lines)'])
})

test('activityLines falls back to description when no known type key matches', () => {
  assert.deepEqual(activityLines(activitiesOf('activities-unknown.json')), [
    '[jules] Something happened that this client does not model yet',
  ])
})

test('activityLines never throws on malformed entries and skips them silently', () => {
  assert.deepEqual(activityLines([null, 42, 'x', [], { description: '' }, { noType: true }]), [])
})

test('activityLines returns [] for a non-array argument', () => {
  assert.deepEqual(activityLines(null), [])
  assert.deepEqual(activityLines({ activities: [] }), [])
})

test('summarizeActivities returns the documented defaults when nothing matches', () => {
  assert.deepEqual(summarizeActivities([]), {
    lines: [],
    prUrl: null,
    changeSet: null,
    lastAgentMessage: null,
    completed: false,
    failed: false,
    failureMessage: null,
  })
})

test('summarizeActivities collects prUrl, the last change set, the last agent message and completion', () => {
  const activities = [
    ...activitiesOf('activities-plan-generated.json'),
    ...activitiesOf('activities-agent-messaged.json'),
    ...activitiesOf('activities-change-set.json'),
    ...activitiesOf('activities-session-completed.json'),
  ]
  const summary = summarizeActivities(activities)
  assert.equal(summary.prUrl, 'https://github.com/acme/widgets/pull/42')
  assert.deepEqual(summary.changeSet, readJson('activities-change-set.json').activities[0].changeSet)
  assert.equal(summary.lastAgentMessage, 'Draft change set ready')
  assert.equal(summary.completed, true)
  assert.equal(summary.failed, false)
  assert.equal(summary.failureMessage, null)
  assert.equal(summary.lines.length, 9)
})

test('summarizeActivities flags failure and keeps the reason', () => {
  const summary = summarizeActivities(activitiesOf('activities-session-failed.json'))
  assert.equal(summary.failed, true)
  assert.equal(summary.completed, false)
  assert.equal(summary.failureMessage, 'Tests failed after 3 attempts')
})

test('summarizeActivities tolerates garbage without throwing', () => {
  const summary = summarizeActivities([null, 'x', 7])
  assert.equal(summary.completed, false)
  assert.equal(summary.failed, false)
})

test('sessionState reads session.state and defaults to UNKNOWN', () => {
  assert.equal(sessionState(readJson('session-completed.json')), 'COMPLETED')
  assert.equal(sessionState({ state: 'IN_PROGRESS' }), 'IN_PROGRESS')
  assert.equal(sessionState({}), 'UNKNOWN')
  assert.equal(sessionState(null), 'UNKNOWN')
})

test('prUrlFromSession finds the first url across array or single-object outputs', () => {
  assert.equal(prUrlFromSession(readJson('session-completed.json')), 'https://github.com/acme/widgets/pull/42')
  assert.equal(prUrlFromSession({ outputs: { pullRequest: { uri: 'https://x/pull/1' } } }), 'https://x/pull/1')
  assert.equal(prUrlFromSession({ outputs: [{ url: 'https://x/plain' }] }), 'https://x/plain')
})

test('prUrlFromSession returns null and never throws when outputs are missing or malformed', () => {
  assert.equal(prUrlFromSession({}), null)
  assert.equal(prUrlFromSession(null), null)
  assert.equal(prUrlFromSession({ outputs: 'nope' }), null)
  assert.equal(prUrlFromSession({ outputs: [{}] }), null)
})

test('branchFromSession probes each output shape in the documented order', () => {
  assert.equal(branchFromSession({ outputs: [{ pullRequest: { headRef: 'jules/headref' } }] }), 'jules/headref')
  assert.equal(branchFromSession({ outputs: [{ pullRequest: { head: { ref: 'jules/head-ref' } } }] }), 'jules/head-ref')
  assert.equal(branchFromSession({ outputs: [{ pullRequest: { branch: 'jules/pr-branch' } }] }), 'jules/pr-branch')
  assert.equal(branchFromSession({ outputs: [{ branch: 'jules/output-branch' }] }), 'jules/output-branch')
  assert.equal(branchFromSession({ branch: 'jules/session-branch' }), 'jules/session-branch')
  assert.equal(branchFromSession({ workingBranch: 'jules/working-branch' }), 'jules/working-branch')
})

test('branchFromSession prefers an earlier probe over a later one when both are present', () => {
  const session = {
    outputs: [{ pullRequest: { headRef: 'head-ref', head: { ref: 'nested-ref' }, branch: 'pr-branch' }, branch: 'output-branch' }],
    branch: 'session-branch',
    workingBranch: 'working-branch',
  }
  assert.equal(branchFromSession(session), 'head-ref')
})

test('branchFromSession accepts a single output object exactly like an array', () => {
  assert.equal(branchFromSession({ outputs: { pullRequest: { headRef: 'solo' } } }), 'solo')
})

test('branchFromSession returns null when nothing matches or the shape is malformed', () => {
  assert.equal(branchFromSession(readJson('session-completed.json')), null)
  assert.equal(branchFromSession({ outputs: [{ pullRequest: { headRef: '' } }] }), null)
  assert.equal(branchFromSession({ outputs: [{ pullRequest: {} }] }), null)
  assert.equal(branchFromSession({ outputs: 'nope' }), null)
  assert.equal(branchFromSession({ outputs: [{}] }), null)
  assert.equal(branchFromSession({}), null)
  assert.equal(branchFromSession(null), null)
})

test('sessionUrl returns the web url only when it is a non-empty string', () => {
  assert.equal(sessionUrl(readJson('session-running.json')), 'https://jules.google.com/session/sess-running-1')
  assert.equal(sessionUrl({ url: '' }), null)
  assert.equal(sessionUrl({}), null)
})

test('buildResponseText renders the full section order with blank-line separators and no trailing newline', () => {
  const session = readJson('session-completed.json')
  const summary = {
    lines: [],
    prUrl: null,
    changeSet: { baseCommitId: 'x', unifiedDiff: '', suggestedCommitMessage: 'Fix off-by-one in paginate()' },
    lastAgentMessage: 'Done, tests pass',
    completed: true,
    failed: false,
    failureMessage: null,
  }
  const expected = [
    'Jules session sess-completed-1 (COMPLETED)',
    'Pull request: https://github.com/acme/widgets/pull/42',
    'Change set: Fix off-by-one in paginate()',
    'Done, tests pass',
    'Session URL: https://jules.google.com/session/sess-completed-1',
  ].join('\n\n')
  const text = buildResponseText({ session, summary })
  assert.equal(text, expected)
  assert.equal(text.endsWith('\n'), false)
})

test('buildResponseText degrades to a bare header when everything else is missing', () => {
  const summary = summarizeActivities([])
  assert.equal(buildResponseText({ session: {}, summary }), 'Jules session unknown (UNKNOWN)')
})

test('buildResponseText renders the failure reason and omits the PR section for a failed session', () => {
  const session = readJson('session-failed.json')
  const summary = summarizeActivities(activitiesOf('activities-session-failed.json'))
  const text = buildResponseText({ session, summary })
  assert.ok(text.startsWith('Jules session sess-failed-1 (FAILED)'))
  assert.ok(text.includes('Failure: Tests failed after 3 attempts'))
  assert.ok(text.includes('Session URL: https://jules.google.com/session/sess-failed-1'))
  assert.ok(!text.includes('Pull request:'))
})

test('classifyError returns null for a healthy completed session', () => {
  const session = readJson('session-completed.json')
  const summary = summarizeActivities(activitiesOf('activities-session-completed.json'))
  assert.equal(classifyError({ session, summary }), null)
})

test('classifyError reports timeout first when the caller timed out', () => {
  const error = classifyError({ timedOut: true, apiError: { status: 429 } })
  assert.equal(error.kind, 'timeout')
  assert.equal(error.retriable, true)
})

test('classifyError maps 429 to a retriable quota error', () => {
  const error = classifyError({ apiError: { status: 429 } })
  assert.equal(error.kind, 'quota')
  assert.equal(error.retriable, true)
})

test('classifyError maps 401 and 403 to a non-retriable auth error', () => {
  assert.equal(classifyError({ apiError: { status: 401 } }).kind, 'auth')
  const forbidden = classifyError({ apiError: { status: 403 } })
  assert.equal(forbidden.kind, 'auth')
  assert.equal(forbidden.retriable, false)
})

test('classifyError maps a FAILED session to remote_failed with the reason', () => {
  const session = readJson('session-failed.json')
  const summary = summarizeActivities(activitiesOf('activities-session-failed.json'))
  const error = classifyError({ session, summary })
  assert.equal(error.kind, 'remote_failed')
  assert.equal(error.retriable, false)
  assert.match(error.message, /Tests failed after 3 attempts/)
})

test('classifyError falls back to crash for any other API error', () => {
  const error = classifyError({ apiError: { status: 500 } })
  assert.equal(error.kind, 'crash')
  assert.equal(error.retriable, false)
})
