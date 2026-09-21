import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HubEvent } from '../src/schemas.mjs'
import { buildSubagentEvent, appendEventLine } from '../integrations/opencode/event-line.mjs'
import agentHubMonitorPlugin from '../integrations/opencode/agent-hub-monitor.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-ocmon-test-'))
}

test('buildSubagentEvent builds start and stop events for a child session with parentID', () => {
  const fixedNow = '2026-09-20T22:00:00.000Z'
  const childSession = {
    id: 'child-session-1',
    parentID: 'root-session-0',
    title: 'code-reviewer',
    agent: 'review-agent',
    model: 'claude-sonnet-4-6',
    directory: '/workspace/project',
  }

  const startEvent = buildSubagentEvent({
    phase: 'start',
    session: childSession,
    now: () => fixedNow,
  })

  assert.ok(startEvent, 'start event should be created for child session')
  assert.equal(startEvent.ts, fixedNow)
  assert.equal(startEvent.source, 'opencode')
  assert.equal(startEvent.kind, 'subagent.start')
  assert.equal(startEvent.title, 'code-reviewer')
  assert.equal(startEvent.sessionId, 'child-session-1')
  assert.equal(startEvent.parentSessionId, 'root-session-0')
  assert.equal(startEvent.cwd, '/workspace/project')

  // Verify it validates against HubEvent schema
  const parsedStart = HubEvent.safeParse(startEvent)
  assert.ok(parsedStart.success, `startEvent failed HubEvent schema: ${JSON.stringify(parsedStart.error?.issues)}`)

  const stopEvent = buildSubagentEvent({
    phase: 'stop',
    session: childSession,
    now: () => fixedNow,
  })

  assert.ok(stopEvent, 'stop event should be created for child session')
  assert.equal(stopEvent.ts, fixedNow)
  assert.equal(stopEvent.source, 'opencode')
  assert.equal(stopEvent.kind, 'subagent.stop')
  assert.equal(stopEvent.title, 'code-reviewer')
  assert.equal(stopEvent.sessionId, 'child-session-1')

  const parsedStop = HubEvent.safeParse(stopEvent)
  assert.ok(parsedStop.success, `stopEvent failed HubEvent schema: ${JSON.stringify(parsedStop.error?.issues)}`)
})

test('buildSubagentEvent supports explicit parent parameter', () => {
  const childSessionWithoutParentProp = {
    id: 'child-session-2',
    title: 'test-runner',
    agent: 'tester',
  }
  const parentObj = { id: 'parent-session-99' }

  const event = buildSubagentEvent({
    phase: 'start',
    session: childSessionWithoutParentProp,
    parent: parentObj,
  })

  assert.ok(event, 'event should be created when parent object is provided')
  assert.equal(event.kind, 'subagent.start')
  assert.equal(event.sessionId, 'child-session-2')
  assert.equal(event.parentSessionId, 'parent-session-99')
})

test('buildSubagentEvent falls back to agent when title is absent', () => {
  const childSession = {
    id: 'child-session-3',
    parentID: 'root-0',
    agent: 'recon-worker',
  }

  const event = buildSubagentEvent({
    phase: 'start',
    session: childSession,
  })

  assert.ok(event)
  assert.equal(event.title, 'recon-worker')
})

test('buildSubagentEvent returns null for root session without a parent', () => {
  const rootSession = {
    id: 'root-session-1',
    parentID: null,
    title: 'main user session',
    agent: 'default',
  }

  const startEvent = buildSubagentEvent({
    phase: 'start',
    session: rootSession,
    parent: null,
  })
  assert.equal(startEvent, null, 'root session must return null (no-op)')

  const stopEvent = buildSubagentEvent({
    phase: 'stop',
    session: { id: 'root-session-2' },
  })
  assert.equal(stopEvent, null, 'root session without parentID must return null (no-op)')
})

test('appendEventLine appends exactly one line per call to specified file', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'events.jsonl')

  const event1 = {
    ts: '2026-09-20T22:01:00.000Z',
    source: 'opencode',
    kind: 'subagent.start',
    title: 'child-1',
    sessionId: 'c1',
  }
  const event2 = {
    ts: '2026-09-20T22:01:05.000Z',
    source: 'opencode',
    kind: 'subagent.stop',
    title: 'child-1',
    sessionId: 'c1',
  }

  const res1 = appendEventLine({ file, event: event1 })
  assert.ok(res1)

  const res2 = appendEventLine({ file, event: event2 })
  assert.ok(res2)

  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  assert.equal(lines.length, 2, 'should append exactly 2 lines')

  const parsed1 = JSON.parse(lines[0])
  assert.equal(parsed1.kind, 'subagent.start')
  assert.equal(parsed1.sessionId, 'c1')

  const parsed2 = JSON.parse(lines[1])
  assert.equal(parsed2.kind, 'subagent.stop')
  assert.equal(parsed2.sessionId, 'c1')
})

test('appendEventLine defaults to AGENT_HUB_HOME/events.jsonl when file is omitted', () => {
  const dir = tmpDir()
  const expectedFile = path.join(dir, 'events.jsonl')

  const event = {
    ts: '2026-09-20T22:01:00.000Z',
    source: 'opencode',
    kind: 'subagent.start',
    title: 'child-env',
  }

  appendEventLine({ event, env: { AGENT_HUB_HOME: dir } })

  assert.ok(fs.existsSync(expectedFile))
  const content = fs.readFileSync(expectedFile, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).title, 'child-env')
})

test('appendEventLine is a no-op when event is null or undefined', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'events.jsonl')

  const resNull = appendEventLine({ file, event: null })
  assert.equal(resNull, null)

  const resUndef = appendEventLine({ file, event: undefined })
  assert.equal(resUndef, null)

  assert.equal(fs.existsSync(file), false, 'file should not be created for null event')
})

test('OpenCode monitor plugin subscribes to events and emits start/stop only for children', async () => {
  const dir = tmpDir()
  const eventsFile = path.join(dir, 'events.jsonl')

  // Instantiate the plugin
  const plugin = typeof agentHubMonitorPlugin === 'function'
    ? await agentHubMonitorPlugin({ directory: dir })
    : (agentHubMonitorPlugin?.server ? await agentHubMonitorPlugin.server({ directory: dir }) : agentHubMonitorPlugin)

  assert.ok(plugin, 'plugin instance should exist')
  assert.ok(typeof plugin.event === 'function', 'plugin should provide an event hook')

  const env = { AGENT_HUB_HOME: dir }

  // 1. Root session created -> no-op
  await plugin.event({
    event: {
      type: 'session.created',
      properties: {
        info: {
          id: 'root-session',
          parentID: null,
          title: 'Root prompt',
          directory: dir,
        },
      },
    },
    env,
    file: eventsFile,
  })

  assert.equal(fs.existsSync(eventsFile), false, 'root session creation must not write any events')

  // 2. Child session created -> subagent.start
  await plugin.event({
    event: {
      type: 'session.created',
      properties: {
        info: {
          id: 'child-sub-1',
          parentID: 'root-session',
          title: 'explore-code',
          agent: 'explore',
          directory: dir,
        },
      },
    },
    env,
    file: eventsFile,
  })

  assert.ok(fs.existsSync(eventsFile), 'events.jsonl should be created on child start')
  let lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  let e1 = JSON.parse(lines[0])
  assert.equal(e1.kind, 'subagent.start')
  assert.equal(e1.source, 'opencode')
  assert.equal(e1.sessionId, 'child-sub-1')
  assert.equal(e1.parentSessionId, 'root-session')
  assert.equal(e1.title, 'explore-code')

  // 3. Child session idle -> subagent.stop
  await plugin.event({
    event: {
      type: 'session.idle',
      properties: {
        sessionID: 'child-sub-1',
      },
    },
    env,
    file: eventsFile,
  })

  lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  let e2 = JSON.parse(lines[1])
  assert.equal(e2.kind, 'subagent.stop')
  assert.equal(e2.source, 'opencode')
  assert.equal(e2.sessionId, 'child-sub-1')

  // 4. Repeated idle for same child should not duplicate subagent.stop if already stopped
  await plugin.event({
    event: {
      type: 'session.idle',
      properties: {
        sessionID: 'child-sub-1',
      },
    },
    env,
    file: eventsFile,
  })

  lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2, 'duplicate idle should not append another stop event')

  // 5. Another child session created and then deleted -> subagent.stop
  await plugin.event({
    event: {
      type: 'session.created',
      properties: {
        info: {
          id: 'child-sub-2',
          parentID: 'root-session',
          title: 'research-task',
          agent: 'research',
          directory: dir,
        },
      },
    },
    env,
    file: eventsFile,
  })

  await plugin.event({
    event: {
      type: 'session.deleted',
      properties: {
        info: {
          id: 'child-sub-2',
        },
      },
    },
    env,
    file: eventsFile,
  })

  lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 4, 'should have start and stop for child 2')
  let e3 = JSON.parse(lines[2])
  let e4 = JSON.parse(lines[3])
  assert.equal(e3.kind, 'subagent.start')
  assert.equal(e3.sessionId, 'child-sub-2')
  assert.equal(e4.kind, 'subagent.stop')
  assert.equal(e4.sessionId, 'child-sub-2')
})
