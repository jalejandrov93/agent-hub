import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { closeDb } from '../src/storage/index.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { artifactPath, artifactsDir, writeArtifact } from '../src/artifacts.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-fan-ev-'))
}

test('fanout: children produce evidence artifacts and pass verification', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-fan-ev-1',
    name: 'fanout evidence pass',
    nodes: [
      {
        id: 'fan',
        type: 'fanout',
        task: 'Process item',
        items: ['item1', 'item2'],
        artifacts: ['report.md'],
        verify: [{ name: 'ok', argv: ['x'] }]
      }
    ]
  }

  const dispatchedTasks = []
  const mockDispatch = async (params) => {
    dispatchedTasks.push(params)
    const expectedDir = artifactsDir({ workflowId: workflow.id, stepId: params.workflowStep }, env)
    assert.ok(params.task.includes(expectedDir), `task must include artifacts dir: ${expectedDir}`)
    assert.ok(params.task.includes('report.md'), 'task must mention report.md')
    assert.ok(fs.existsSync(expectedDir), 'artifacts dir must exist before dispatch')

    writeArtifact({
      workflowId: workflow.id,
      stepId: params.workflowStep,
      name: 'report.md',
      content: `# Report for ${params.workflowStep}`
    }, env)

    return { done: params.workflowStep }
  }

  const runCommandFn = async () => ({
    stdout: 'ok',
    stderr: '',
    code: 0,
    timedOut: false
  })

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    runCommandFn
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.fan.status, 'succeeded')
  assert.equal(result.nodes.fan.result.count, 2)
  assert.equal(dispatchedTasks.length, 2)

  for (const stepId of ['fan_0', 'fan_1']) {
    const childNode = result.nodes[stepId]
    assert.ok(childNode, `child node ${stepId} must exist in result.nodes`)
    assert.equal(childNode.status, 'succeeded')
    assert.equal(childNode.verification?.verified, true)
    assert.equal(childNode.judge?.verdict, 'accepted')

    const vPath = artifactPath({ workflowId: workflow.id, stepId, name: 'verification.json' }, env)
    assert.ok(fs.existsSync(vPath), `verification.json must exist for ${stepId}`)
    const vContent = JSON.parse(fs.readFileSync(vPath, 'utf8'))
    assert.equal(vContent.verified, true)

    const jPath = artifactPath({ workflowId: workflow.id, stepId, name: 'judge.json' }, env)
    assert.ok(fs.existsSync(jPath), `judge.json must exist for ${stepId}`)
  }

  closeDb(env)
})

test('fanout: failing children fail and fanout node ends FAILED naming failing child ids', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-fan-ev-2',
    name: 'fanout evidence fail',
    nodes: [
      {
        id: 'fan',
        type: 'fanout',
        task: 'Process item',
        items: ['itemA', 'itemB'],
        artifacts: ['report.md'],
        verify: {
          checks: [{ name: 'failing_check', argv: ['fail_cmd'] }],
          required: true
        }
      }
    ]
  }

  const mockDispatch = async (params) => {
    return { done: params.workflowStep }
  }

  const runCommandFn = async () => ({
    stdout: '',
    stderr: 'command failed',
    code: 1,
    timedOut: false
  })

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    runCommandFn
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.nodes.fan.status, 'failed')

  const fanError = result.nodes.fan.result?.error || result.nodes.fan.error?.message || ''
  assert.ok(fanError.includes('fan_0'), `fanout error must name fan_0: ${fanError}`)
  assert.ok(fanError.includes('fan_1'), `fanout error must name fan_1: ${fanError}`)

  assert.equal(result.nodes.fan_0.status, 'failed')
  assert.equal(result.nodes.fan_1.status, 'failed')
  assert.equal(result.nodes.fan_0.verification?.verified, false)
  assert.equal(result.nodes.fan_1.verification?.verified, false)

  closeDb(env)
})

test('fanout: without artifacts/verify keeps working exactly as before', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-fan-ev-3',
    name: 'fanout vanilla',
    nodes: [
      {
        id: 'fan',
        type: 'fanout',
        task: 'Vanilla fanout',
        items: ['first', 'second']
      }
    ]
  }

  const dispatchedTasks = []
  const mockDispatch = async (params) => {
    dispatchedTasks.push(params)
    return { ok: true, step: params.workflowStep }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.fan.status, 'succeeded')
  assert.equal(result.nodes.fan.result.count, 2)
  assert.deepEqual(result.nodes.fan.result.items, [
    { ok: true, step: 'fan_0' },
    { ok: true, step: 'fan_1' }
  ])
  assert.equal(result.nodes.fan_0.status, 'succeeded')
  assert.equal(result.nodes.fan_1.status, 'succeeded')

  closeDb(env)
})
