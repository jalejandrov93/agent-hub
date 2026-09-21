import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { closeDb } from '../src/storage/index.mjs'
import { readTail } from '../src/eventlog.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { manifestPath, writeArtifact, artifactsDir } from '../src/artifacts.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-art-'))
}

test('engine: delegate node creates artifacts dir, appends instruction, writes manifest on success and carries artifacts in job.finished', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-art-1',
    name: 'artifacts test',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Generate report and patch',
        artifacts: ['report.md', 'diff.patch']
      }
    ]
  }

  const expectedDir = artifactsDir({ workflowId: workflow.id, stepId: 'step1' }, env)

  const mockDispatch = async (params) => {
    assert.ok(params.task.includes(expectedDir), 'task must include absolute dir')
    assert.ok(params.task.includes('report.md'), 'task must include report.md')
    assert.ok(params.task.includes('diff.patch'), 'task must include diff.patch')
    assert.ok(fs.existsSync(expectedDir), 'artifacts dir must exist before dispatch')

    fs.writeFileSync(path.join(expectedDir, 'report.md'), '# Report content', 'utf8')
    return { success: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded')

  const mPath = manifestPath({ workflowId: workflow.id, stepId: 'step1' }, env)
  assert.ok(fs.existsSync(mPath), 'manifest file must exist')

  const parsed = JSON.parse(fs.readFileSync(mPath, 'utf8'))
  assert.ok(parsed.present.includes('report.md'))
  assert.ok(parsed.missing.includes('diff.patch'))

  const events = readTail({ n: 20, env })
  const finishedEvent = events.find((e) => e.kind === 'job.finished' && e.step_id === 'step1')
  assert.ok(finishedEvent, 'job.finished event must exist')
  assert.ok(finishedEvent.artifacts, 'job.finished event must carry artifacts')
  assert.equal(finishedEvent.artifacts['report.md'].exists, true)
  assert.equal(finishedEvent.artifacts['diff.patch'].exists, false)

  closeDb(env)
})

test('engine: artifact passing resolves artifact ref in downstream task to file content', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-art-2',
    name: 'artifact passing',
    nodes: [
      {
        id: 'up',
        type: 'delegate',
        task: 'Producer'
      },
      {
        id: 'down',
        type: 'delegate',
        dependsOn: ['up'],
        task: 'Process artifact://wf-art-2/up/brief.md'
      }
    ]
  }

  const mockDispatch = async (params) => {
    if (params.workflowStep === 'up') {
      writeArtifact({
        workflowId: 'wf-art-2',
        stepId: 'up',
        name: 'brief.md',
        content: 'hello from up'
      }, env)
      return { success: true }
    }
    if (params.workflowStep === 'down') {
      assert.ok(params.task.includes('hello from up'), 'task must contain inlined content')
      assert.ok(!params.task.includes('artifact://wf-art-2/up/brief.md'), 'task must not contain raw ref')
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

test('engine: unresolved artifact ref causes delegate node to fail and error message mentions ref', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-art-3',
    name: 'unresolved ref',
    nodes: [
      {
        id: 'broken',
        type: 'delegate',
        task: 'Check artifact://wf-art-3/nope/missing.md'
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
  assert.equal(result.nodes.broken.status, 'failed')

  const errorMsg = result.nodes.broken.result?.error || result.nodes.broken.error?.message || ''
  assert.ok(errorMsg.includes('artifact://wf-art-3/nope/missing.md'), 'error message must mention ref')

  closeDb(env)
})
