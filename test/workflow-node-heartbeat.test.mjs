import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb, closeDb, getWorkflowNode } from '../src/storage/index.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-node-heartbeat-'))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('T7: a running node heartbeats its lease so a slow job is not mistaken for a dead owner', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-heartbeat',
    name: 'heartbeat',
    nodes: [{ id: 'slow', type: 'delegate', task: 'slow', maxAttempts: 1 }],
  }

  // Sample the node's lease timestamp while the job is still running.
  const samples = []
  const dispatchFn = async () => {
    for (let i = 0; i < 3; i++) {
      await sleep(150)
      samples.push(getWorkflowNode(getDb(env), workflow.id, 'slow')?.updated_at)
    }
    return { ok: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn,
    leaseTtlMs: 200,
    heartbeatMs: 60,
    pollIntervalMs: 10,
    backoffMs: 1,
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(samples.length, 3)
  assert.ok(samples.every(Boolean), `every sample must read the node row, got ${JSON.stringify(samples)}`)
  assert.equal(
    new Set(samples).size,
    samples.length,
    `the lease timestamp must advance while the job runs, got ${JSON.stringify(samples)}`
  )
  closeDb(env)
})

test('T7: a peer scheduler does not steal a node whose owner is still heartbeating', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-heartbeat-peer',
    name: 'heartbeat peer',
    nodes: [{ id: 'slow', type: 'delegate', task: 'slow', maxAttempts: 2 }],
  }

  let ownerDispatches = 0
  const ownerRun = runWorkflow({
    workflow,
    env,
    leaseTtlMs: 200,
    heartbeatMs: 60,
    pollIntervalMs: 10,
    backoffMs: 1,
    dispatchFn: async () => {
      ownerDispatches++
      await sleep(1200)
      return { ok: true }
    },
  })

  // The peer arrives well after the original lease would have expired (200ms)
  // but while the owner is still working.
  await sleep(500)

  let peerDispatches = 0
  const peerResult = await runWorkflow({
    workflowId: 'wf-heartbeat-peer',
    env,
    leaseTtlMs: 200,
    heartbeatMs: 60,
    pollIntervalMs: 10,
    stallTimeoutS: 0.4,
    dispatchFn: async () => {
      peerDispatches++
      return { ok: true }
    },
  })

  assert.equal(peerDispatches, 0, 'a heartbeating owner must never be preempted')
  assert.equal(
    peerResult.status,
    'succeeded',
    'the peer must observe the live owner finishing rather than fail as stalled'
  )

  const ownerResult = await ownerRun
  assert.equal(ownerResult.status, 'succeeded')
  assert.equal(ownerDispatches, 1)
  closeDb(env)
})
