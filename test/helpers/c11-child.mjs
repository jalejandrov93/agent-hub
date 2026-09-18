/**
 * C1.1 cross-process worker: ejecuta el workflow con un dispatch simulado
 * que duerme 60ms y hace append atómico (O_APPEND) del step a un log
 * compartido. Un step ejecutado dos veces aparece dos veces en el log.
 */
import fs from 'node:fs'
import { runWorkflow } from '../../src/workflow/engine.mjs'

const home = process.env.AGENT_HUB_HOME
const logFile = process.env.C11_LOG
const workflowId = process.argv[2] || 'wf-c11-xproc'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dispatchFn = async (params) => {
  await sleep(60)
  fs.appendFileSync(logFile, `${Date.now()} pid=${process.pid} ${params.workflowStep}\n`, 'utf8')
  return { ok: true, step: params.workflowStep }
}

const workflow = {
  id: workflowId,
  name: 'cross-process test',
  nodes: [
    { id: 'n1', type: 'delegate', task: 'task 1' },
    { id: 'n2', type: 'delegate', task: 'task 2', dependsOn: ['n1'] },
    { id: 'n3', type: 'delegate', task: 'task 3', dependsOn: ['n2'] },
  ],
}

try {
  const result = await runWorkflow({
    workflow,
    env: { AGENT_HUB_HOME: home },
    dispatchFn,
    claimedBy: `xproc_${process.pid}`,
    pollIntervalMs: 10,
  })
  if (result.status !== 'succeeded') {
    console.error(`child ${process.pid}: workflow ${result.status}`)
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  console.error(`child ${process.pid} failed:`, error?.stack ?? error?.message ?? error)
  process.exit(1)
}
