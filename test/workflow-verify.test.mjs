import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { closeDb } from '../src/storage/index.mjs'
import { readTail } from '../src/eventlog.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { writeArtifact, artifactPath } from '../src/artifacts.mjs'
import { createJob, updateResult, readResult } from '../src/jobstore.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-ver-'))
}

test('engine verify: verified pass writes verification.json, updates job.finished and job record', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const job = createJob({ workflow_id: 'wf-ver-1', step_id: 'step1', env })
  const jobId = job.jobId
  updateResult(jobId, { status: 'succeeded' }, env)

  const workflow = {
    id: 'wf-ver-1',
    name: 'verified pass test',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Run with verification',
        verify: [{ name: 'tests', argv: ['npm', 'test'] }]
      }
    ]
  }

  const runCommandFn = async () => ({
    stdout: '',
    stderr: '',
    code: 0,
    timedOut: false
  })

  const mockDispatch = async () => ({
    success: true,
    jobId
  })

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    runCommandFn
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.step1.status, 'succeeded')
  assert.equal(result.nodes.step1.verification?.verified, true)

  const verifyJsonPath = artifactPath({ workflowId: workflow.id, stepId: 'step1', name: 'verification.json' }, env)
  assert.ok(fs.existsSync(verifyJsonPath), 'verification.json artifact must exist')
  const writtenVerification = JSON.parse(fs.readFileSync(verifyJsonPath, 'utf8'))
  assert.equal(writtenVerification.verified, true)

  const events = readTail({ n: 20, env })
  const finishedEvent = events.find((e) => e.kind === 'job.finished' && e.step_id === 'step1')
  assert.ok(finishedEvent, 'job.finished event must exist')
  assert.equal(finishedEvent.verification?.verified, true)

  const jobRecord = readResult(jobId, env)
  assert.equal(jobRecord.verified, true)

  closeDb(env)
})

test('engine verify: required + failure is fatal and NOT retried', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-ver-2',
    name: 'verify failure fatal and not retried',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Run tests with required verification',
        maxAttempts: 3,
        verify: {
          checks: [{ name: 'tests', argv: ['npm', 'test'] }],
          required: true
        }
      }
    ]
  }

  let commandCalls = 0
  const runCommandFn = async () => {
    commandCalls++
    return {
      stdout: '',
      stderr: 'test suite failed',
      code: 1,
      timedOut: false
    }
  }

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
  assert.equal(commandCalls, 1, 'runCommandFn must be called exactly once (no retry)')
  assert.equal(dispatchCalls, 1, 'dispatchFn must be called exactly once')

  const stepResult = result.nodes.step1.result
  assert.ok(stepResult, 'step result must exist')
  assert.ok(stepResult.verification, 'step result must carry verification')
  const testsCheck = stepResult.verification.checks.find((c) => c.name === 'tests')
  assert.ok(testsCheck, 'tests check must exist')
  assert.equal(testsCheck.passed, false)

  const errorMsg = stepResult.error || result.nodes.step1.error?.message || ''
  assert.ok(errorMsg.startsWith('verification failed:'), 'error message starts with verification failed:')

  const events = readTail({ n: 20, env })
  const failedEvent = events.find((e) => e.kind === 'job.failed' && e.step_id === 'step1')
  assert.ok(failedEvent, 'job.failed event must exist')
  assert.equal(failedEvent.verification?.verified, false)

  closeDb(env)
})

test('engine verify: artifact check passes when written and fails when missing', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  // 3a: passes when written
  const workflowPass = {
    id: 'wf-ver-3a',
    name: 'artifact check pass',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Generate report',
        artifacts: ['report.md'],
        verify: [{ name: 'evidence', artifact: 'report.md' }]
      }
    ]
  }

  const mockDispatchPass = async () => {
    writeArtifact(
      {
        workflowId: 'wf-ver-3a',
        stepId: 'step1',
        name: 'report.md',
        content: '# Pass'
      },
      env
    )
    return { success: true }
  }

  const throwingRunCommandFn = async () => {
    throw new Error('runCommandFn should not be called for artifact check')
  }

  const resultPass = await runWorkflow({
    workflow: workflowPass,
    env,
    dispatchFn: mockDispatchPass,
    runCommandFn: throwingRunCommandFn
  })

  assert.equal(resultPass.status, 'succeeded')
  assert.equal(resultPass.nodes.step1.status, 'succeeded')
  assert.equal(resultPass.nodes.step1.verification?.verified, true)

  const verifyJsonPath = artifactPath({ workflowId: 'wf-ver-3a', stepId: 'step1', name: 'verification.json' }, env)
  assert.ok(fs.existsSync(verifyJsonPath), 'verification.json must exist')
  const json = JSON.parse(fs.readFileSync(verifyJsonPath, 'utf8'))
  assert.equal(json.verified, true)

  // 3b: fails when missing and required: true
  const workflowFail = {
    id: 'wf-ver-3b',
    name: 'artifact check fail',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Generate report missing',
        artifacts: ['report.md'],
        verify: {
          checks: [{ name: 'evidence', artifact: 'report.md' }],
          required: true
        }
      }
    ]
  }

  const mockDispatchFail = async () => ({ success: true })

  const resultFail = await runWorkflow({
    workflow: workflowFail,
    env,
    dispatchFn: mockDispatchFail,
    runCommandFn: throwingRunCommandFn
  })

  assert.equal(resultFail.status, 'failed')
  assert.equal(resultFail.nodes.step1.status, 'failed')
  assert.equal(resultFail.nodes.step1.result?.verification?.verified, false)

  closeDb(env)
})

test('engine verify: diff/scope check detects forbidden changes or passes clean diff', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  // 4a: fails when diff contains forbidden path
  const workflowDiff = {
    id: 'wf-ver-4a',
    name: 'diff check fail',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Scope check',
        verify: {
          checks: [{ name: 'scope', forbid: ['src/generated'] }],
          required: true
        }
      }
    ]
  }

  const runCommandFail = async () => ({
    stdout: 'src/generated/x.js\n',
    stderr: '',
    code: 0,
    timedOut: false
  })

  const resultFail = await runWorkflow({
    workflow: workflowDiff,
    env,
    dispatchFn: async () => ({ success: true }),
    runCommandFn: runCommandFail
  })

  assert.equal(resultFail.status, 'failed')
  assert.equal(resultFail.nodes.step1.status, 'failed')
  const scopeCheck = resultFail.nodes.step1.result?.verification?.checks.find((c) => c.name === 'scope')
  assert.ok(scopeCheck, 'scope check must exist in verification')
  assert.equal(scopeCheck.passed, false)
  assert.ok(scopeCheck.forbidden.includes('src/generated/x.js'))

  // 4b: passes when diff is clean
  const workflowClean = {
    id: 'wf-ver-4b',
    name: 'diff check pass',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Scope check clean',
        verify: {
          checks: [{ name: 'scope', forbid: ['src/generated'] }],
          required: true
        }
      }
    ]
  }

  const runCommandPass = async () => ({
    stdout: 'src/app.js\n',
    stderr: '',
    code: 0,
    timedOut: false
  })

  const resultPass = await runWorkflow({
    workflow: workflowClean,
    env,
    dispatchFn: async () => ({ success: true }),
    runCommandFn: runCommandPass
  })

  assert.equal(resultPass.status, 'succeeded')
  assert.equal(resultPass.nodes.step1.status, 'succeeded')
  assert.equal(resultPass.nodes.step1.verification?.verified, true)

  closeDb(env)
})
