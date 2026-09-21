import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { computeDispatchKey } from '../src/dispatch.mjs'
import { writeArtifact } from '../src/artifacts.mjs'
import { closeDb } from '../src/storage/index.mjs'
import { CORPUS } from './corpus.mjs'

export async function runScenario({ scenario, env = process.env } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-bench-'))
  const scenarioEnv = { ...env, AGENT_HUB_HOME: home }

  const dispatches = []
  const inFlightKeys = new Set()
  const completedKeys = new Set()
  let duplicateDispatches = 0

  const stepCallCounts = {}
  const stepDispatchCount = {}
  let lastDispatchedStepId = null

  const mockDispatch = async (params) => {
    const stepId = params.workflowStep || params.step_id || params.id || 'unknown'
    lastDispatchedStepId = stepId
    stepDispatchCount[stepId] = (stepDispatchCount[stepId] || 0) + 1

    const dispatchKey = computeDispatchKey({
      task: params.task,
      cwd: params.cwd,
      taskType: params.taskType,
      workflowStep: params.workflowStep || params.step_id,
      workflowId: params.workflow_id
    })

    dispatches.push({ stepId, dispatchKey })

    if (inFlightKeys.has(dispatchKey) || completedKeys.has(dispatchKey)) {
      duplicateDispatches++
    }
    inFlightKeys.add(dispatchKey)

    const stepPlan =
      scenario.dispatch?.[stepId] ||
      scenario.dispatch?.[stepId.replace(/_\d+$/, '')] ||
      {}

    const resultsPlan = stepPlan.results
    let outcome = 'succeed'
    if (Array.isArray(resultsPlan)) {
      const callIdx = (stepCallCounts[stepId] = (stepCallCounts[stepId] || 0) + 1) - 1
      outcome = resultsPlan[callIdx] ?? resultsPlan[resultsPlan.length - 1] ?? 'succeed'
    } else if (typeof resultsPlan === 'string') {
      outcome = resultsPlan
    } else if (typeof resultsPlan === 'function') {
      outcome = await resultsPlan(params)
    }

    try {
      if (outcome === 'fail' || outcome?.fail === true) {
        throw new Error(outcome?.error || `Step "${stepId}" simulated failure`)
      }

      if (stepPlan.artifacts && typeof stepPlan.artifacts === 'object') {
        for (const [name, content] of Object.entries(stepPlan.artifacts)) {
          writeArtifact(
            {
              workflowId: params.workflow_id,
              stepId,
              name,
              content: typeof content === 'string' ? content : JSON.stringify(content)
            },
            scenarioEnv
          )
        }
      }

      completedKeys.add(dispatchKey)
      return typeof outcome === 'object' ? outcome : { success: true, stepId }
    } finally {
      inFlightKeys.delete(dispatchKey)
    }
  }

  const runCommandFn = async (cmd, args, opts) => {
    const stepId = lastDispatchedStepId
    const stepPlan =
      scenario.dispatch?.[stepId] ||
      scenario.dispatch?.[stepId?.replace(/_\d+$/, '')] ||
      {}

    const vPlan = stepPlan.verification
    let outcome = 'pass'
    if (Array.isArray(vPlan)) {
      const dispatchIdx = (stepDispatchCount[stepId] || 1) - 1
      outcome = vPlan[dispatchIdx] ?? vPlan[vPlan.length - 1] ?? 'pass'
    } else if (typeof vPlan === 'string') {
      outcome = vPlan
    } else if (typeof vPlan === 'function') {
      outcome = await vPlan({ cmd, args, opts, stepId })
    }

    const passed = outcome === 'pass' || outcome === 0 || outcome === true
    return {
      stdout: passed ? 'verification passed' : '',
      stderr: passed ? '' : 'verification failed',
      code: passed ? 0 : 1,
      timedOut: false
    }
  }

  try {
    const workflowResult = await runWorkflow({
      workflow: scenario.workflow,
      env: scenarioEnv,
      dispatchFn: mockDispatch,
      runCommandFn,
      backoffMs: 1,
      pollIntervalMs: 5
    })

    const nodes = {}
    const verifications = {}
    const judges = {}
    let primaryVerification = null
    let primaryJudge = null

    for (const [sId, sState] of Object.entries(workflowResult.nodes || {})) {
      nodes[sId] = {
        status: sState.status,
        attempt: sState.attempt ?? 1,
        revision: sState.revision ?? 0,
        ...(sState.error ? { error: sState.error } : {}),
        ...(sState.result ? { result: sState.result } : {})
      }
      if (sState.verification) {
        verifications[sId] = sState.verification
        primaryVerification = sState.verification
      }
      if (sState.judge) {
        judges[sId] = sState.judge
        primaryJudge = sState.judge
      }
    }

    const verification = {
      ...verifications,
      ...(primaryVerification ? { verified: primaryVerification.verified, checks: primaryVerification.checks } : {})
    }

    const judge = {
      ...judges,
      ...(primaryJudge ? { verdict: primaryJudge.verdict, reason: primaryJudge.reason } : {})
    }

    return {
      id: scenario.id,
      status: workflowResult.status,
      nodes,
      dispatches,
      duplicateDispatches,
      verification,
      judge
    }
  } finally {
    try {
      closeDb(scenarioEnv)
    } catch {}
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch {}
  }
}

export function summarize(results = []) {
  let completed = 0
  let verified = 0
  let failed = 0
  let duplicates = 0

  for (const r of results) {
    if (r.status === 'succeeded' || r.status === 'completed') {
      completed++
    } else {
      failed++
    }
    const isVerified =
      r.verification?.verified === true ||
      Object.values(r.verification || {}).some((v) => v?.verified === true) ||
      Object.values(r.nodes || {}).some((n) => n?.verification?.verified === true)
    if (isVerified) {
      verified++
    }
    duplicates += Number(r.duplicateDispatches) || 0
  }

  return {
    total: results.length,
    completed,
    verified,
    failed,
    duplicates
  }
}

export async function runCorpus({ scenarios = CORPUS, env = process.env } = {}) {
  const results = []
  for (const scenario of scenarios) {
    const res = await runScenario({ scenario, env })
    results.push(res)
  }
  const summary = summarize(results)
  return {
    generatedAt: new Date().toISOString(),
    scenarios: results,
    summary
  }
}

const isDirectExecution = () => {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  } catch {
    return process.argv[1].endsWith('bench/run.mjs')
  }
}

if (isDirectExecution()) {
  if (process.env.AGENT_HUB_LIVE === '1') {
    console.log('AGENT_HUB_LIVE=1: Live benchmark mode is not implemented yet.')
    process.exit(0)
  }
  try {
    const report = await runCorpus()
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.stderr.write(
      `\nBenchmark summary: ${report.summary.completed}/${report.summary.total} completed, ` +
      `${report.summary.verified} verified, ${report.summary.failed} failed, ` +
      `${report.summary.duplicates} duplicates.\n`
    )
  } catch (err) {
    console.error('Benchmark execution failed:', err)
    process.exit(1)
  }
}
