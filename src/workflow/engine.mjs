import crypto from 'node:crypto'
import {
  getDb,
  upsertWorkflow,
  getWorkflow,
  upsertWorkflowNode,
  getWorkflowNode,
  listWorkflowNodes,
  claimWorkflowNode,
} from '../storage/index.mjs'
import { appendEvent } from '../eventlog.mjs'
import { calculateDispatchTimeoutS, dispatch } from '../dispatch.mjs'
import { createWorkflow } from './schema.mjs'
import { NODE_STATUS, isTerminalStatus, assertValidTransition } from './state.mjs'
import { resolveDependencies, evaluateCondition } from './resolver.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Concurrency & Race Condition Resolution (C1.8 / C1.9):
 *
 * We use atomic Compare-And-Swap (CAS) on the `claimed_by` column in `workflow_nodes`:
 *   UPDATE workflow_nodes
 *   SET claimed_by = @claimedBy, status = 'running', attempt = attempt + 1, updated_at = @now
 *   WHERE workflow_id = @workflowId AND step_id = @stepId AND status IN ('pending', 'ready')
 *     AND (claimed_by IS NULL OR claimed_by = '' OR claimed_by = @claimedBy)
 *
 * Why `claimed_by` CAS over a separate leases table:
 * 1. Single source of truth: Node state and claim ownership are updated in a single atomic SQL statement
 *    under SQLite's WAL mode.
 * 2. Eliminates distributed state inconsistency: A separate leases table requires dual-phase updates
 *    (lease acquire -> status update -> lease delete), creating windows for orphaned leases or phantom executions.
 * 3. Idempotent re-entry: If the same scheduler worker retries after transient failure, `claimed_by = @claimedBy`
 *    safely allows continuation without deadlock.
 */

function refreshNodeStates(ctx, workflowId, nodeStates) {
  const rows = listWorkflowNodes(ctx, workflowId)
  for (const row of rows) {
    let result = null
    try {
      result = row.result_json ? JSON.parse(row.result_json) : null
    } catch {
      result = row.result_json
    }
    const current = nodeStates.get(row.step_id)
    nodeStates.set(row.step_id, {
      ...(current || {}),
      status: row.status,
      attempt: row.attempt,
      result: result ?? current?.result ?? null,
      claimed_by: row.claimed_by,
      updated_at: row.updated_at,
    })
  }
}

/**
 * Executes a single node with retry backoff and timeout enforcement.
 */
async function executeNode({
  workflow,
  node,
  ctx,
  env,
  dispatchFn,
  nodeStates,
  claimedBy,
  backoffMs,
}) {
  const maxAttempts = node.maxAttempts ?? 1
  let attempt = nodeStates.get(node.id)?.attempt || 1
  let lastError = null

  appendEvent(
    {
      kind: 'job.started',
      jobId: `${workflow.id}_${node.id}`,
      workflow_id: workflow.id,
      step_id: node.id,
      agent: node.agent,
      model: node.model,
      cwd: node.cwd,
      title: node.task ?? node.id,
    },
    { env }
  )

  while (attempt <= maxAttempts) {
    try {
      let result = null

      if (node.type === 'delegate') {
        // C1.6 timeout calculation
        let timeoutS = node.timeoutS
        if (!timeoutS && typeof calculateDispatchTimeoutS === 'function') {
          try {
            timeoutS = calculateDispatchTimeoutS({
              agent: node.agent,
              model: node.model,
              mode: node.mode,
              taskType: node.taskType,
              attempt,
              env,
            })
          } catch {
            timeoutS = 30
          }
        }
        timeoutS = timeoutS || 30

        const timeoutPromise = new Promise((_, reject) => {
          const timer = setTimeout(() => {
            const err = new Error(`Node "${node.id}" timed out after ${timeoutS}s (attempt ${attempt}/${maxAttempts})`)
            err.code = 'ETIMEDOUT'
            reject(err)
          }, timeoutS * 1000)
          if (timer.unref) timer.unref()
        })

        const execPromise = dispatchFn({
          task: node.task,
          taskType: node.taskType,
          agent: node.agent,
          model: node.model,
          cwd: node.cwd,
          mode: node.mode,
          workflowStep: node.id,
          workflow_id: workflow.id,
          step_id: node.id,
          attempt,
          timeoutS,
          env,
        })

        result = await Promise.race([execPromise, timeoutPromise])
      } else if (node.type === 'fanout') {
        // C1.5 Fanout node generates N children
        let items = []
        if (Array.isArray(node.items)) {
          items = node.items
        } else if (typeof node.items === 'string') {
          const rawSteps = {}
          for (const [id, s] of nodeStates.entries()) {
            rawSteps[id] = s
          }
          try {
            const fn = new Function('steps', `"use strict"; return (${node.items});`)
            const evalItems = fn(rawSteps)
            if (Array.isArray(evalItems)) items = evalItems
          } catch {
            items = []
          }
        } else if (node.dependsOn && node.dependsOn.length > 0) {
          const parentState = nodeStates.get(node.dependsOn[0])
          if (Array.isArray(parentState?.result?.items)) {
            items = parentState.result.items
          } else if (Array.isArray(parentState?.result)) {
            items = parentState.result
          }
        }

        // Execute N children in parallel with distinct workflowStep -> distinct dispatchKey
        const childResults = await Promise.all(
          items.map(async (item, idx) => {
            const childStepId = `${node.id}_${idx}`
            const now = new Date().toISOString()
            upsertWorkflowNode(ctx, {
              workflow_id: workflow.id,
              step_id: childStepId,
              status: NODE_STATUS.RUNNING,
              attempt: 1,
              updated_at: now,
              claimed_by: claimedBy,
            })

            const itemTask =
              typeof item === 'string'
                ? `${node.task ? node.task + ': ' : ''}${item}`
                : `${node.task || 'Process item'} ${JSON.stringify(item)}`

            const childRes = await dispatchFn({
              task: itemTask,
              taskType: node.taskType,
              agent: node.agent,
              model: node.model,
              cwd: node.cwd,
              mode: node.mode,
              workflowStep: childStepId,
              workflow_id: workflow.id,
              step_id: childStepId,
              attempt: 1,
              env,
            })

            upsertWorkflowNode(ctx, {
              workflow_id: workflow.id,
              step_id: childStepId,
              status: NODE_STATUS.SUCCEEDED,
              attempt: 1,
              updated_at: new Date().toISOString(),
              result_json: JSON.stringify(childRes ?? { success: true }),
            })

            return childRes
          })
        )

        result = { items: childResults, count: items.length }
      } else if (node.type === 'fanin') {
        // C1.5 Fanin node aggregates results from all upstream dependencies
        const aggregated = {}
        for (const depId of node.dependsOn) {
          const depState = nodeStates.get(depId)
          aggregated[depId] = depState?.result ?? null
        }
        result = { aggregated }
      } else if (node.type === 'notify') {
        result = { notified: true, stepId: node.id }
      }

      // Transition to SUCCEEDED
      const now = new Date().toISOString()
      upsertWorkflowNode(ctx, {
        workflow_id: workflow.id,
        step_id: node.id,
        status: NODE_STATUS.SUCCEEDED,
        attempt,
        updated_at: now,
        result_json: JSON.stringify(result ?? { success: true }),
      })
      nodeStates.set(node.id, {
        ...nodeStates.get(node.id),
        status: NODE_STATUS.SUCCEEDED,
        attempt,
        result,
        error: null,
      })

      appendEvent(
        {
          kind: 'job.finished',
          jobId: result?.job?.jobId ?? result?.jobId ?? `${workflow.id}_${node.id}`,
          workflow_id: workflow.id,
          step_id: node.id,
          agent: node.agent,
          model: node.model,
          cwd: node.cwd,
          title: node.task ?? node.id,
        },
        { env }
      )

      return
    } catch (err) {
      lastError = err
      if (attempt < maxAttempts) {
        const delay = backoffMs * attempt
        if (delay > 0) await sleep(delay)
        attempt++
        upsertWorkflowNode(ctx, {
          workflow_id: workflow.id,
          step_id: node.id,
          status: NODE_STATUS.RUNNING,
          attempt,
          updated_at: new Date().toISOString(),
        })
        nodeStates.set(node.id, {
          ...nodeStates.get(node.id),
          attempt,
        })
      } else {
        break
      }
    }
  }

  // Attempts exhausted -> FAILED
  const now = new Date().toISOString()
  const errorPayload = {
    error: lastError?.message || String(lastError),
    code: lastError?.code || null,
    attempts: attempt,
  }
  upsertWorkflowNode(ctx, {
    workflow_id: workflow.id,
    step_id: node.id,
    status: NODE_STATUS.FAILED,
    attempt,
    updated_at: now,
    result_json: JSON.stringify(errorPayload),
  })
  nodeStates.set(node.id, {
    ...nodeStates.get(node.id),
    status: NODE_STATUS.FAILED,
    attempt,
    error: lastError,
    result: errorPayload,
  })

  appendEvent(
    {
      kind: 'job.failed',
      jobId: `${workflow.id}_${node.id}`,
      workflow_id: workflow.id,
      step_id: node.id,
      agent: node.agent,
      model: node.model,
      cwd: node.cwd,
      title: node.task ?? node.id,
      summary: lastError?.message,
    },
    { env }
  )
}

/**
 * Runs a workflow DAG to completion.
 *
 * @param {object} params
 * @param {object} [params.workflow] - Workflow definition object
 * @param {string} [params.workflowId] - Workflow ID (for resumption from DB)
 * @param {object} [params.ctx] - DB storage context (from getDb(env))
 * @param {object} [params.env=process.env]
 * @param {Function} [params.dispatchFn=dispatch] - Dispatch function
 * @param {string} [params.claimedBy] - Scheduler worker identity for atomic CAS
 * @param {number} [params.pollIntervalMs=25]
 * @param {number} [params.backoffMs=50]
 * @returns {Promise<{ workflowId: string, status: string, nodes: Record<string, object> }>}
 */
export async function runWorkflow({
  workflow: inputWorkflow,
  workflowId: inputWorkflowId,
  ctx,
  env = process.env,
  dispatchFn = dispatch,
  claimedBy = `scheduler_${crypto.randomUUID()}`,
  pollIntervalMs = 25,
  backoffMs = 50,
} = {}) {
  const dbCtx = ctx || getDb(env)
  let workflow = null
  const isResume = Boolean(!inputWorkflow && inputWorkflowId)

  if (inputWorkflow) {
    workflow = createWorkflow(inputWorkflow)
    upsertWorkflow(dbCtx, {
      id: workflow.id,
      name: workflow.name,
      created_at: workflow.createdAt,
      definition_json: JSON.stringify(workflow),
      status: 'running',
      updated_at: new Date().toISOString(),
    })
  } else if (inputWorkflowId) {
    const row = getWorkflow(dbCtx, inputWorkflowId)
    if (!row) {
      throw new Error(`Workflow not found: ${inputWorkflowId}`)
    }
    workflow = createWorkflow(JSON.parse(row.definition_json))
  } else {
    throw new Error('Either workflow or workflowId must be provided')
  }

  // Load existing node state from DB
  const nodeStates = new Map()
  const existingRows = listWorkflowNodes(dbCtx, workflow.id)
  const existingByStep = new Map(existingRows.map((r) => [r.step_id, r]))

  for (const node of workflow.nodes) {
    const row = existingByStep.get(node.id)
    if (row) {
      let result = null
      try {
        result = row.result_json ? JSON.parse(row.result_json) : null
      } catch {
        result = row.result_json
      }

      let status = row.status

      // On resume after restart: orphaned running nodes are reset to ready
      if (isResume && status === NODE_STATUS.RUNNING) {
        status = NODE_STATUS.READY
        upsertWorkflowNode(dbCtx, {
          workflow_id: workflow.id,
          step_id: node.id,
          status: NODE_STATUS.READY,
          attempt: row.attempt,
          claimed_by: null,
          updated_at: new Date().toISOString(),
        })
      }

      nodeStates.set(node.id, {
        status,
        attempt: row.attempt || 0,
        result,
        error: null,
        claimed_by: isResume && status === NODE_STATUS.READY ? null : row.claimed_by,
      })
    } else {
      const now = new Date().toISOString()
      upsertWorkflowNode(dbCtx, {
        workflow_id: workflow.id,
        step_id: node.id,
        status: NODE_STATUS.PENDING,
        attempt: 0,
        updated_at: now,
      })
      nodeStates.set(node.id, {
        status: NODE_STATUS.PENDING,
        attempt: 0,
        result: null,
        error: null,
        claimed_by: null,
      })
    }
  }

  // Execution loop (wave scheduler)
  while (true) {
    refreshNodeStates(dbCtx, workflow.id, nodeStates)

    const isAllTerminal = workflow.nodes.every((n) => isTerminalStatus(nodeStates.get(n.id)?.status))
    if (isAllTerminal) break

    // 1. Dependency resolution
    const resolution = resolveDependencies({ workflow, nodeStates })

    // 2. Persist skipped transitions
    for (const { node, reason } of resolution.skipped) {
      const current = nodeStates.get(node.id)
      if (current && current.status !== NODE_STATUS.SKIPPED) {
        assertValidTransition(current.status, NODE_STATUS.SKIPPED, node.id)
        const now = new Date().toISOString()
        const skipResult = { skipped: true, reason }
        upsertWorkflowNode(dbCtx, {
          workflow_id: workflow.id,
          step_id: node.id,
          status: NODE_STATUS.SKIPPED,
          attempt: current.attempt,
          updated_at: now,
          result_json: JSON.stringify(skipResult),
        })
        nodeStates.set(node.id, {
          ...current,
          status: NODE_STATUS.SKIPPED,
          result: skipResult,
        })
      }
    }

    // 3. Ready wave execution
    const readyNodes = resolution.ready

    if (readyNodes.length === 0) {
      const anyRunning = Array.from(nodeStates.values()).some((s) => s.status === NODE_STATUS.RUNNING)
      if (anyRunning) {
        await sleep(pollIntervalMs)
        continue
      }
      break
    }

    // 4. Parallel wave execution via Promise.all
    await Promise.all(
      readyNodes.map(async (node) => {
        // Atomic CAS Claim: only one scheduler worker acquires this node (C1.8 / C1.9)
        const currentAttempt = (nodeStates.get(node.id)?.attempt || 0) + 1
        const claimed = claimWorkflowNode(dbCtx, {
          workflowId: workflow.id,
          stepId: node.id,
          claimedBy,
          attempt: currentAttempt,
        })

        if (!claimed) {
          // Another scheduler already claimed or executed this node
          return
        }

        nodeStates.set(node.id, {
          ...nodeStates.get(node.id),
          status: NODE_STATUS.RUNNING,
          attempt: currentAttempt,
          claimed_by: claimedBy,
        })

        await executeNode({
          workflow,
          node,
          ctx: dbCtx,
          env,
          dispatchFn,
          nodeStates,
          claimedBy,
          backoffMs,
        })
      })
    )
  }

  refreshNodeStates(dbCtx, workflow.id, nodeStates)

  const allSucceeded = workflow.nodes.every(
    (n) =>
      nodeStates.get(n.id)?.status === NODE_STATUS.SUCCEEDED ||
      nodeStates.get(n.id)?.status === NODE_STATUS.SKIPPED
  )

  const finalStatus = allSucceeded ? 'succeeded' : 'failed'
  upsertWorkflow(dbCtx, {
    id: workflow.id,
    name: workflow.name,
    status: finalStatus,
    updated_at: new Date().toISOString(),
  })

  return {
    workflowId: workflow.id,
    status: finalStatus,
    nodes: Object.fromEntries(nodeStates.entries()),
  }
}
