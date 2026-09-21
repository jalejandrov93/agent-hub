import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { buildExecutionGraph } from '../src/execution-graph.mjs'
import { closeDb } from '../src/storage/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-lineage-'))
}

test('workflow lineage: dispatch receives rootExecutionId and parentExecutionId across dependencies', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const dispatchCalls = []
  const jobRecords = []
  const recordsById = {}

  const mockDispatch = async (params) => {
    dispatchCalls.push(params)
    const jobId = `job-${params.workflowStep}`
    const record = {
      jobId,
      executionId: jobId,
      rootExecutionId: params.rootExecutionId,
      parentExecutionId: params.parentExecutionId,
      status: 'succeeded',
      agent: params.agent,
    }
    jobRecords.push(record)
    recordsById[jobId] = record
    return {
      success: true,
      jobId,
      status: 'succeeded',
      job: record,
      output: `Result of ${params.workflowStep}`,
    }
  }

  const workflow = {
    id: 'wf-lineage-1',
    name: 'two-node pipeline',
    nodes: [
      {
        id: 'node-1',
        type: 'delegate',
        agent: 'agy',
        task: 'first step',
      },
      {
        id: 'node-2',
        type: 'delegate',
        agent: 'codex',
        task: 'second step',
        dependsOn: ['node-1'],
      },
    ],
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    readResultFn: (id) => recordsById[id],
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(dispatchCalls.length, 2)

  // Every dispatch received rootExecutionId === workflow.id
  assert.equal(dispatchCalls[0].rootExecutionId, 'wf-lineage-1')
  assert.equal(dispatchCalls[1].rootExecutionId, 'wf-lineage-1')

  // First node has no parent, second node received parentExecutionId === first node's jobId
  assert.equal(dispatchCalls[0].parentExecutionId, null)
  assert.equal(dispatchCalls[1].parentExecutionId, 'job-node-1')

  // Feeding job records into buildExecutionGraph produces connected edge
  const graph = buildExecutionGraph({ jobs: jobRecords })
  assert.deepEqual(graph.roots, ['job-node-1'])
  assert.equal(graph.edges.length, 1)
  assert.equal(graph.edges[0].from, 'job-node-1')
  assert.equal(graph.edges[0].to, 'job-node-2')

  closeDb(env)
})

test('fanout child receives rootExecutionId === workflow.id and parentExecutionId === null', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const dispatchCalls = []
  const recordsById = {}

  const mockDispatch = async (params) => {
    dispatchCalls.push(params)
    const jobId = `job-${params.workflowStep}`
    const record = {
      jobId,
      executionId: jobId,
      status: 'succeeded',
      rootExecutionId: params.rootExecutionId,
      parentExecutionId: params.parentExecutionId,
    }
    recordsById[jobId] = record
    return {
      success: true,
      jobId,
      status: 'succeeded',
      job: record,
      output: 'Child done',
    }
  }

  const workflow = {
    id: 'wf-fanout-lineage',
    name: 'fanout lineage test',
    nodes: [
      {
        id: 'distribute',
        type: 'fanout',
        items: ['item-a', 'item-b'],
        agent: 'agy',
      },
      {
        id: 'collect',
        type: 'fanin',
        dependsOn: ['distribute'],
      },
    ],
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    readResultFn: (id) => recordsById[id],
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(dispatchCalls.length, 2)
  for (const call of dispatchCalls) {
    assert.equal(call.rootExecutionId, 'wf-fanout-lineage')
    assert.equal(call.parentExecutionId, null)
  }

  closeDb(env)
})
