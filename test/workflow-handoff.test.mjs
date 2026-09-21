import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { closeDb } from '../src/storage/index.mjs'
import { readTail } from '../src/eventlog.mjs'
import { runWorkflow, normalizeHandoffConfig } from '../src/workflow/engine.mjs'
import { writeArtifact } from '../src/artifacts.mjs'
import { readHandoff } from '../src/context.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-handoff-'))
}

test('engine handoff: required + valid persists handoff, returns summary in readHandoff, and carries handoff in job.finished', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-handoff-1',
    name: 'required + valid handoff',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Conduct research',
        handoff: { required: true, schema: 'ResearchHandoff' }
      }
    ]
  }

  const mockDispatch = async (params) => {
    writeArtifact(
      {
        workflowId: workflow.id,
        stepId: params.workflowStep,
        name: 'handoff.json',
        content: JSON.stringify({
          summary: 'Research findings summary',
          findings: ['finding 1', 'finding 2']
        })
      },
      env
    )
    return { success: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.step1.status, 'succeeded')

  const saved = readHandoff({ workflowId: workflow.id, stepId: 'step1' }, env)
  assert.ok(saved, 'readHandoff must return persisted handoff')
  assert.equal(saved.summary, 'Research findings summary')

  const events = readTail({ n: 20, env })
  const finishedEvent = events.find((e) => e.kind === 'job.finished' && e.step_id === 'step1')
  assert.ok(finishedEvent, 'job.finished event must exist')
  assert.ok(finishedEvent.handoff, 'job.finished event must carry handoff')
  assert.equal(finishedEvent.handoff.summary, 'Research findings summary')

  closeDb(env)
})

test('engine handoff: required + invalid/missing fails node with error containing handoff required', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-handoff-2',
    name: 'required + missing handoff',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Conduct research without handoff',
        handoff: { required: true, schema: 'ResearchHandoff' }
      }
    ]
  }

  const mockDispatch = async () => ({ success: true })

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.nodes.step1.status, 'failed')

  const errorMsg = result.nodes.step1.result?.error || result.nodes.step1.error?.message || ''
  assert.ok(errorMsg.includes('handoff required'), 'error message must contain "handoff required"')

  closeDb(env)
})

test('engine handoff: handoff:true (not required) with nothing written succeeds with no handoff recorded', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-handoff-3',
    name: 'optional handoff not written',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Optional handoff step',
        handoff: true
      }
    ]
  }

  const mockDispatch = async () => ({ success: true })

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.step1.status, 'succeeded')

  const saved = readHandoff({ workflowId: workflow.id, stepId: 'step1' }, env)
  assert.equal(saved, null, 'no handoff should be recorded')
  assert.equal(result.nodes.step1.handoff, undefined)

  closeDb(env)
})

test('engine handoff: upstream injection appends upstream handoff summary to downstream task', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-handoff-4',
    name: 'upstream injection',
    nodes: [
      {
        id: 'up',
        type: 'delegate',
        task: 'Upstream task',
        handoff: true
      },
      {
        id: 'down',
        type: 'delegate',
        dependsOn: ['up'],
        task: 'Downstream task'
      }
    ]
  }

  const mockDispatch = async (params) => {
    if (params.workflowStep === 'up') {
      writeArtifact(
        {
          workflowId: workflow.id,
          stepId: 'up',
          name: 'handoff.json',
          content: JSON.stringify({ summary: 'upstream analysis summary' })
        },
        env
      )
      return { success: true }
    }
    if (params.workflowStep === 'down') {
      assert.ok(params.task.includes('upstream analysis summary'), 'downstream task must contain up summary')
      return { success: true }
    }
    throw new Error(`Unexpected step: ${params.workflowStep}`)
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.up.status, 'succeeded')
  assert.equal(result.nodes.down.status, 'succeeded')

  closeDb(env)
})

test('engine handoff: DSL condition steps.<depId>.handoff.<field> runs when true and skips when false', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-handoff-5',
    name: 'dsl condition on handoff',
    nodes: [
      {
        id: 'up',
        type: 'delegate',
        task: 'Upstream task',
        handoff: true
      },
      {
        id: 'downTrue',
        type: 'delegate',
        dependsOn: ['up'],
        condition: 'steps.up.handoff.summary == \'the target summary\'',
        task: 'Runs when true'
      },
      {
        id: 'downFalse',
        type: 'delegate',
        dependsOn: ['up'],
        condition: 'steps.up.handoff.summary == \'non matching summary\'',
        task: 'Skipped when false'
      }
    ]
  }

  const mockDispatch = async (params) => {
    if (params.workflowStep === 'up') {
      writeArtifact(
        {
          workflowId: workflow.id,
          stepId: 'up',
          name: 'handoff.json',
          content: JSON.stringify({ summary: 'the target summary' })
        },
        env
      )
      return { success: true }
    }
    if (params.workflowStep === 'downTrue') {
      return { success: true }
    }
    if (params.workflowStep === 'downFalse') {
      throw new Error('downFalse should not have run')
    }
    throw new Error(`Unexpected step: ${params.workflowStep}`)
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.up.status, 'succeeded')
  assert.equal(result.nodes.downTrue.status, 'succeeded')
  assert.equal(result.nodes.downFalse.status, 'skipped')

  closeDb(env)
})

test('normalizeHandoffConfig: handles null, undefined, false, true, valid object, and throws on unknown schema', () => {
  assert.equal(normalizeHandoffConfig(null), null)
  assert.equal(normalizeHandoffConfig({}), null)
  assert.equal(normalizeHandoffConfig({ handoff: null }), null)
  assert.equal(normalizeHandoffConfig({ handoff: false }), null)
  assert.deepEqual(normalizeHandoffConfig({ handoff: true }), { required: false, schema: 'BaseHandoff' })
  assert.deepEqual(normalizeHandoffConfig({ handoff: { required: true, schema: 'ResearchHandoff' } }), {
    required: true,
    schema: 'ResearchHandoff'
  })
  assert.deepEqual(normalizeHandoffConfig({ handoff: { required: false } }), {
    required: false,
    schema: 'BaseHandoff'
  })
  assert.throws(
    () => normalizeHandoffConfig({ handoff: { schema: 'NoSuchSchema' } }),
    /unknown handoff schema: NoSuchSchema/
  )
})

test('engine handoff: upstream injection truncates JSON longer than 4000 chars with trailing ...', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const longFindings = Array.from({ length: 15 }, (_, i) => 'f'.repeat(300) + `-${i}`)
  const workflow = {
    id: 'wf-handoff-6',
    name: 'upstream truncation',
    nodes: [
      {
        id: 'up',
        type: 'delegate',
        task: 'Upstream task',
        handoff: { schema: 'ResearchHandoff' }
      },
      {
        id: 'down',
        type: 'delegate',
        dependsOn: ['up'],
        task: 'Downstream task'
      }
    ]
  }

  const mockDispatch = async (params) => {
    if (params.workflowStep === 'up') {
      writeArtifact(
        {
          workflowId: workflow.id,
          stepId: 'up',
          name: 'handoff.json',
          content: JSON.stringify({ summary: 'long upstream summary', findings: longFindings })
        },
        env
      )
      return { success: true }
    }
    if (params.workflowStep === 'down') {
      assert.ok(params.task.includes('Upstream context:\nup: {'), 'task must have upstream block')
      assert.ok(params.task.includes('...'), 'long json must have trailing ...')
      return { success: true }
    }
    throw new Error(`Unexpected step: ${params.workflowStep}`)
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded')
  closeDb(env)
})

