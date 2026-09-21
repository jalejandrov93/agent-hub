import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { closeDb } from '../src/storage/index.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { artifactPath } from '../src/artifacts.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-judge-'))
}

test('engine judge: revision then accept writes judge.json/verification.json and succeeds', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-judge-1',
    name: 'revision then accept',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Run tests with revision',
        maxRevisionAttempts: 2,
        verify: [{ name: 'tests', argv: ['npm', 'test'] }]
      }
    ]
  }

  let commandCalls = 0
  const runCommandFn = async () => {
    commandCalls++
    return {
      stdout: '',
      stderr: '',
      code: commandCalls <= 2 ? 1 : 0,
      timedOut: false
    }
  }

  let dispatchCalls = 0
  const dispatchedTasks = []
  const mockDispatch = async (params) => {
    dispatchCalls++
    dispatchedTasks.push(params?.task)
    return { success: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    runCommandFn
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.step1.status, 'succeeded')
  assert.equal(dispatchCalls, 3, 'dispatchFn must be called EXACTLY 3 times')
  assert.equal(dispatchedTasks.length, 3)
  assert.equal(dispatchedTasks[0].includes('<agent-hub-revision>'), false, 'first dispatch must not have feedback')
  assert.equal(dispatchedTasks[1].includes('<agent-hub-revision>'), true, 'second dispatch must have feedback')
  assert.equal(dispatchedTasks[1].includes('tests'), true, 'second dispatch must include failed check name')
  assert.equal(result.nodes.step1.judge.verdict, 'accepted')

  const judgeJsonPath = artifactPath({ workflowId: workflow.id, stepId: 'step1', name: 'judge.json' }, env)
  assert.ok(fs.existsSync(judgeJsonPath), 'judge.json artifact must exist')
  const writtenJudge = JSON.parse(fs.readFileSync(judgeJsonPath, 'utf8'))
  assert.equal(writtenJudge.verdict, 'accepted')

  const verifyJsonPath = artifactPath({ workflowId: workflow.id, stepId: 'step1', name: 'verification.json' }, env)
  assert.ok(fs.existsSync(verifyJsonPath), 'verification.json artifact must exist')
  const writtenVerification = JSON.parse(fs.readFileSync(verifyJsonPath, 'utf8'))
  assert.equal(writtenVerification.verified, true)

  closeDb(env)
})

test('engine judge: revisions exhausted + required fails with judge verdict rejected', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-judge-2',
    name: 'revisions exhausted + required',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Run tests with required verification and 1 revision attempt',
        maxRevisionAttempts: 1,
        maxAttempts: 1,
        verify: {
          checks: [{ name: 'tests', argv: ['npm', 'test'] }],
          required: true
        }
      }
    ]
  }

  const runCommandFn = async () => ({
    stdout: '',
    stderr: 'always fail',
    code: 1,
    timedOut: false
  })

  let dispatchCalls = 0
  const mockDispatch = async () => {
    dispatchCalls++
    return { success: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    runCommandFn
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.nodes.step1.status, 'failed')
  assert.equal(dispatchCalls, 2, 'dispatchFn must be called exactly 2 times')
  assert.equal(result.nodes.step1.judge?.verdict, 'rejected')

  closeDb(env)
})

test('engine judge: revisions exhausted + not required succeeds with rejected verdict recorded', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-judge-3',
    name: 'revisions exhausted + not required',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Run tests with unrequired verification and 1 revision attempt',
        maxRevisionAttempts: 1,
        maxAttempts: 1,
        verify: {
          checks: [{ name: 'tests', argv: ['npm', 'test'] }],
          required: false
        }
      }
    ]
  }

  const runCommandFn = async () => ({
    stdout: '',
    stderr: 'always fail',
    code: 1,
    timedOut: false
  })

  let dispatchCalls = 0
  const mockDispatch = async () => {
    dispatchCalls++
    return { success: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    runCommandFn
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.step1.status, 'succeeded')
  assert.equal(dispatchCalls, 2, 'dispatchFn must be called exactly 2 times')
  assert.equal(result.nodes.step1.judge?.verdict, 'rejected')

  closeDb(env)
})

test('engine judge: blocked short-circuits without burning revisions', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-judge-4',
    name: 'blocked short-circuits',
    nodes: [
      {
        id: 'up',
        type: 'delegate',
        task: 'Upstream step producing no artifacts'
      },
      {
        id: 'down',
        type: 'delegate',
        task: 'Downstream step needing upstream artifact',
        dependsOn: ['up'],
        maxRevisionAttempts: 3,
        verify: {
          checks: [{ name: 'evidence', artifact: 'brief.md', from: 'up' }],
          required: true
        }
      }
    ]
  }

  let downDispatchCalls = 0
  const mockDispatch = async (params) => {
    const stepId = params.step_id || params.workflowStep
    if (stepId === 'down') {
      downDispatchCalls++
    }
    return { success: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.nodes.down.status, 'failed')
  assert.equal(downDispatchCalls, 1, 'down dispatchFn must be called ONCE')
  assert.equal(result.nodes.down.judge?.verdict, 'blocked')

  closeDb(env)
})
