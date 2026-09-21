import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  artifactsDir,
  collectManifest,
  readArtifact,
  resolveArtifactRefs,
  writeArtifact,
  writeManifest,
} from '../artifacts.mjs'
import { validateHandoff, resolveHandoffSchema } from '../handoff.mjs'
import { writeHandoff, readHandoff } from '../context.mjs'
import {
  getDb,
  upsertWorkflow,
  getWorkflow,
  upsertWorkflowNode,
  getWorkflowNode,
  listWorkflowNodes,
  claimWorkflowNode,
  publishWorkflowNodeReady,
} from '../storage/index.mjs'
import { appendEvent } from '../eventlog.mjs'
import { resolveHarness } from '../harness/registry.mjs'
import { calculateDispatchTimeoutS, dispatch, waitExecution as defaultWaitExecution } from '../dispatch.mjs'
import { readResult as readJobResult, updateResult } from '../jobstore.mjs'
import { runVerification, normalizeVerifyConfig } from '../verify.mjs'
import { judgeVerdict } from '../judge.mjs'
import { buildRevisionFeedback } from '../revision.mjs'
import { createWorkflow } from './schema.mjs'
import { NODE_STATUS, WAITING_REASONS, isTerminalStatus, assertValidTransition } from './state.mjs'
import { resolveDependencies, evaluateCondition } from './resolver.mjs'
import { evaluateValue } from './dsl.mjs'

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

/** Default claim-lease TTL: a running node owned by someone else may only be
 * revived after this long without an update. */
export const CLAIM_LEASE_TTL_MS = 30_000

/**
 * Normalizes a node's handoff configuration.
 * undefined/null/false -> null
 * true -> { required: false, schema: 'BaseHandoff' }
 * object -> { required: value.required === true, schema: typeof value.schema === 'string' ? value.schema : 'BaseHandoff' }
 * An unknown schema name throws via resolveHandoffSchema.
 * @param {object} node
 * @returns {{ required: boolean, schema: string } | null}
 */
export function normalizeHandoffConfig(node) {
  const value = node?.handoff
  if (value === undefined || value === null || value === false) {
    return null
  }
  if (value === true) {
    return { required: false, schema: 'BaseHandoff' }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const schema = typeof value.schema === 'string' ? value.schema : 'BaseHandoff'
    const schemaObj = resolveHandoffSchema(schema)
    if (!schemaObj) {
      throw new Error(`unknown handoff schema: ${schema}`)
    }
    return {
      required: value.required === true,
      schema,
    }
  }
  return null
}

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
 * C1.1: única vía ready→running. Asserts the transition, then performs the
 * atomic CAS. Returns true when this worker now owns the node.
 * A node still PENDING is not claimed here: the wave publishes it READY
 * first through the conditional publish (which never clobbers a claim).
 */
export function claimNode(ctx, { workflowId, stepId, claimedBy, attempt }) {
  const row = getWorkflowNode(ctx, workflowId, stepId)
  const current = row?.status ?? NODE_STATUS.PENDING
  if (current !== NODE_STATUS.READY) return false
  assertValidTransition(current, NODE_STATUS.RUNNING, stepId)
  return claimWorkflowNode(ctx, { workflowId, stepId, claimedBy, attempt })
}

/**
 * C1.1: vía para el resto de transiciones. Always asserts validity first.
 */
export function transitionNode(ctx, { workflowId, stepId, from, to, attempt, resultJson = null, claimedBy = null }) {
  const row = getWorkflowNode(ctx, workflowId, stepId)
  const current = from ?? row?.status
  assertValidTransition(current, to, stepId)
  const now = new Date().toISOString()
  upsertWorkflowNode(ctx, {
    workflow_id: workflowId,
    step_id: stepId,
    status: to,
    attempt: attempt ?? row?.attempt ?? 0,
    updated_at: now,
    claimed_by: claimedBy ?? row?.claimed_by ?? null,
    ...(resultJson !== null ? { result_json: resultJson } : {}),
  })
  return getWorkflowNode(ctx, workflowId, stepId)
}

function isHandleLike(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.abort === 'function' && typeof value.jobId === 'string') return true
  if (value.__handle && typeof value.__handle?.jobId === 'string') return true
  return false
}

function unwrapHandle(value) {
  if (!value || typeof value !== 'object') return null
  if (value.__handle && typeof value.__handle?.jobId === 'string') return value.__handle
  if (typeof value.abort === 'function' && typeof value.jobId === 'string') return value
  if (value.job && typeof value.job.jobId === 'string' && typeof value.abort === 'function') return value
  return null
}

/**
 * A dispatch result that carries a jobId but no handle protocol (bare job
 * record, or {job} without abort) is a PENDING execution, never a final
 * result. Live validation proved the old fallthrough marked a freshly-queued
 * record SUCCEEDED. Wrap it as a minimal handle so it goes through
 * waitForHandleTerminal like everything else; an already-terminal record
 * resolves immediately there.
 */
function pendingJobHandle(value) {
  if (!value || typeof value !== 'object') return null
  const jobId =
    (typeof value.jobId === 'string' && value.jobId) ||
    (value.job && typeof value.job.jobId === 'string' && value.job.jobId) ||
    null
  if (!jobId) return null
  return { jobId }
}

/**
 * Resolves a fanout `items` expression without `new Function`/`eval`.
 * Array => as-is; string => C1.1 DSL value expression evaluated against
 * current step states (must yield an array); otherwise falls back to the
 * parent result items when dependsOn is set.
 */
export function resolveFanoutItems({ node, nodeStates }) {
  if (Array.isArray(node.items)) return node.items
  if (typeof node.items === 'string') {
    const rawSteps = {}
    for (const [id, s] of nodeStates.entries()) {
      rawSteps[id] = s
    }
    try {
      const value = evaluateValue(node.items, { steps: rawSteps })
      if (Array.isArray(value)) return value
    } catch {
      // fall through to empty
    }
    return []
  }
  if (node.dependsOn && node.dependsOn.length > 0) {
    const parentState = nodeStates.get(node.dependsOn[0])
    if (Array.isArray(parentState?.result?.items)) {
      return parentState.result.items
    } else if (Array.isArray(parentState?.result)) {
      return parentState.result
    }
  }
  return []
}

/**
 * Executes a single node with retry backoff and timeout enforcement.
 *
 * C1.1 delegate semantics: dispatch() returns a handle; waitExecution()
 * observes the job record until a REAL terminal status. SUCCEEDED is
 * persisted only after terminal success — a still-pending job never
 * advances the node. Timeouts abort the handle, confirm the record, and
 * retry with attempt+1. Waiting (AWAITING_* / PAUSED) persists WAITING and
 * resumes without re-dispatching.
 */
async function executeNode({
  workflow,
  node,
  ctx,
  env,
  dispatchFn,
  runCommandFn = null,
  nodeStates,
  claimedBy,
  backoffMs,
  waitExecutionFn = defaultWaitExecution,
  readResultFn = null,
  onWaiting = null,
  waitingTimeoutS = 300,
  pollIntervalMs = 25,
}) {
  const handoffConfig = normalizeHandoffConfig(node)
  const maxAttempts = node.maxAttempts ?? 1
  let attempt = nodeStates.get(node.id)?.attempt || 1
  const maxRevisionAttempts = Number.isInteger(node.maxRevisionAttempts) && node.maxRevisionAttempts > 0 ? node.maxRevisionAttempts : 0
  let revision = 0
  let revisionFeedback = ''
  let lastError = null
  const readRecord = readResultFn ?? ((jobId) => readJobResult(jobId, env))
  // Harness defaults from env for the started event (emitted before the
  // dispatch returns); once dispatchFn answers, its harness/waitMode win.
  const defaultProfile = resolveHarness({ env })
  let nodeHarness = defaultProfile.id
  let nodeWaitMode = defaultProfile.delegation.defaultWaitMode
  const adoptHarness = (value) => {
    nodeHarness = value?.harness ?? value?.job?.harness ?? nodeHarness
    nodeWaitMode = value?.waitMode ?? value?.job?.waitMode ?? nodeWaitMode
  }

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
      harness: nodeHarness,
      waitMode: nodeWaitMode,
    },
    { env }
  )

  const declared = node.type === 'delegate' && Array.isArray(node.artifacts) ? node.artifacts : []

  while (attempt <= maxAttempts) {
    try {
      let result = null

      if (node.type === 'delegate') {
        const resolved = resolveArtifactRefs(node.task ?? '', { env })
        if (resolved.missing.length > 0) {
          throw new Error('unresolved artifact ref: ' + resolved.missing[0])
        }
        let dispatchedTask = resolved.text
        if (revisionFeedback) {
          dispatchedTask = revisionFeedback + '\n\n' + dispatchedTask
        }

        const deps = Array.isArray(node.dependsOn) ? node.dependsOn : []
        const upstreamHandoffs = []
        for (const depId of deps) {
          const depHandoff = nodeStates.get(depId)?.handoff
          if (depHandoff) {
            let json = JSON.stringify(depHandoff, null, 0)
            if (json.length > 4000) {
              json = json.slice(0, 4000) + '...'
            }
            upstreamHandoffs.push(`${depId}: ${json}`)
          }
        }
        if (upstreamHandoffs.length > 0) {
          dispatchedTask =
            dispatchedTask +
            '\n\n' +
            'Upstream context:\n' +
            upstreamHandoffs.join('\n')
        }

        if (declared.length > 0) {
          const dir = artifactsDir({ workflowId: workflow.id, stepId: node.id }, env)
          fs.mkdirSync(dir, { recursive: true })
          dispatchedTask =
            dispatchedTask +
            '\n\n' +
            'Evidence artifacts: write these files to ' +
            dir +
            ' (absolute path), one file per name, exactly these filenames: ' +
            declared.join(', ') +
            '. Do not write any other file there.'
        }

        if (handoffConfig) {
          const dir = artifactsDir({ workflowId: workflow.id, stepId: node.id }, env)
          fs.mkdirSync(dir, { recursive: true })
          const schemaObj = resolveHandoffSchema(handoffConfig.schema)
          const requiresStr = schemaObj?.requires ? schemaObj.requires.join(', ') : 'summary'
          dispatchedTask =
            dispatchedTask +
            '\n\n' +
            'Structured handoff: also write handoff.json to ' +
            dir +
            ' (absolute path): a JSON object with summary (a non-empty string) and the arrays findings/decisions/constraints/changedFiles/openQuestions/artifacts (arrays of strings). ' +
            'Required fields for schema ' +
            handoffConfig.schema +
            ': ' +
            requiresStr +
            '.'
        }

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
        const attemptDeadline = Date.now() + timeoutS * 1000

        // Sin await previo: el timeout cubre el dispatch mismo (los mocks
        // legacy cuelgan dentro del dispatch, igual que antes).
        const dispatchPromise = Promise.resolve().then(() =>
          dispatchFn({
            task: dispatchedTask,
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
        )
        const timeoutPromise = new Promise((_, reject) => {
          const timer = setTimeout(() => {
            const err = new Error(`Node "${node.id}" timed out after ${timeoutS}s (attempt ${attempt}/${maxAttempts})`)
            err.code = 'ETIMEDOUT'
            reject(err)
          }, timeoutS * 1000)
          if (timer.unref) timer.unref()
        })

        const dispatched = await Promise.race([dispatchPromise, timeoutPromise])
        // Evita unhandled rejection si el dispatch pierde la carrera y falla tarde.
        dispatchPromise.catch(() => {})
        adoptHarness(dispatched)

        const handle = unwrapHandle(dispatched) ?? pendingJobHandle(dispatched)
        if (!handle) {
          // Legacy dispatch (valor plano, sin jobId): el resultado ya está aquí.
          result = dispatched
        } else {
          // C1.1: espera el record terminal REAL con el presupuesto restante
          // del intento; nunca avanza sobre un pendiente.
          const remainingS = Math.max(0.05, (attemptDeadline - Date.now()) / 1000)
          result = await waitForHandleTerminal({
            workflow,
            node,
            ctx,
            env,
            handle,
            timeoutS: remainingS,
            attempt,
            maxAttempts,
            nodeStates,
            claimedBy,
            waitExecutionFn,
            readRecord,
            onWaiting,
            waitingTimeoutS,
            pollIntervalMs,
          })
        }
      } else if (node.type === 'fanout') {
        // C1.5 Fanout node generates N children (C1.1: no new Function)
        const items = resolveFanoutItems({ node, nodeStates })

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

            const childHandle = unwrapHandle(childRes) ?? pendingJobHandle(childRes)
            adoptHarness(childRes)
            let finalChild = childRes
            if (childHandle) {
              finalChild = await waitForHandleTerminal({
                workflow,
                node: { ...node, id: childStepId },
                ctx,
                env,
                handle: childHandle,
                timeoutS: node.timeoutS || 30,
                attempt: 1,
                maxAttempts: 1,
                nodeStates,
                claimedBy,
                waitExecutionFn,
                readRecord,
                onWaiting,
                waitingTimeoutS,
                pollIntervalMs,
              })
            }

            upsertWorkflowNode(ctx, {
              workflow_id: workflow.id,
              step_id: childStepId,
              status: NODE_STATUS.SUCCEEDED,
              attempt: 1,
              updated_at: new Date().toISOString(),
              result_json: JSON.stringify(finalChild ?? { success: true }),
            })

            return finalChild
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

      let verification = null
      let judge = null
      if (node.type === 'delegate' && normalizeVerifyConfig(node)) {
        verification = await runVerification({
          node,
          workflowId: workflow.id,
          stepId: node.id,
          cwd: node.cwd ?? null,
          env,
          runCommandFn: runCommandFn ?? undefined,
        })
        if (verification) {
          try {
            writeArtifact(
              {
                workflowId: workflow.id,
                stepId: node.id,
                name: 'verification.json',
                content: JSON.stringify(verification, null, 2),
              },
              env
            )
          } catch {}
          judge = judgeVerdict({
            verification,
            stepId: node.id,
            revision,
            maxRevisionAttempts,
            required: verification.required,
          })
          try {
            writeArtifact(
              {
                workflowId: workflow.id,
                stepId: node.id,
                name: 'judge.json',
                content: JSON.stringify(judge, null, 2),
              },
              env
            )
          } catch {}
        }
      }
      const jobId = result?.job?.jobId ?? result?.jobId ?? null
      if (judge && jobId) { try { updateResult(jobId, { verified: verification.verified, judge_verdict: judge.verdict, revision }, env) } catch {} }
      if (judge && judge.verdict === 'needs_revision') {
        const err = new Error(judge.reason)
        err.code = 'REVISION_REQUESTED'
        err.judge = judge
        err.verification = verification
        throw err
      }
      if (judge && (judge.verdict === 'rejected' || judge.verdict === 'blocked') && judge.required) {
        const err = new Error(judge.reason)
        err.code = 'JUDGE_REJECTED'
        err.judge = judge
        err.verification = verification
        throw err
      }

      let producedHandoff = null
      if (node.type === 'delegate' && handoffConfig) {
        let handoffRaw = null
        try {
          const art = readArtifact({ workflowId: workflow.id, stepId: node.id, name: 'handoff.json' }, env)
          if (art?.content) {
            handoffRaw = JSON.parse(art.content)
          }
        } catch {}

        const validation = validateHandoff(handoffRaw, { schema: handoffConfig.schema })
        if (validation.ok) {
          producedHandoff = writeHandoff(
            {
              workflowId: workflow.id,
              stepId: node.id,
              handoff: validation.value,
              schema: handoffConfig.schema,
            },
            env
          )
        } else {
          if (handoffConfig.required) {
            const err = new Error('handoff required: ' + JSON.stringify(validation.errors))
            err.code = 'HANDOFF_INVALID'
            throw err
          }
        }
      }

      // Transition to SUCCEEDED (only reachable after a real terminal outcome)
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
        ...(verification ? { verification } : {}),
        ...(judge ? { judge } : {}),
        ...(producedHandoff ? { handoff: producedHandoff } : {}),
        revision,
      })

      let manifest = null
      if (node.type === 'delegate' && declared.length > 0) {
        manifest = collectManifest({ workflowId: workflow.id, stepId: node.id, declared }, env)
        writeManifest({ workflowId: workflow.id, stepId: node.id }, manifest, env)
      }

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
          harness: nodeHarness,
          waitMode: nodeWaitMode,
          ...(manifest ? { artifacts: manifest.artifacts } : {}),
          ...(verification ? { verification } : {}),
          ...(judge ? { judge } : {}),
          ...(producedHandoff ? { handoff: producedHandoff } : {}),
          revision,
        },
        { env }
      )

      return
    } catch (err) {
      lastError = err
      if (err.code === 'REVISION_REQUESTED' && revision < maxRevisionAttempts) {
        revisionFeedback = buildRevisionFeedback({ judge: err.judge, verification: err.verification })
        revision++
        attempt = 1
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
          revision,
        })
        continue
      }
      if (err.code === 'REVISION_REQUESTED' || err.code === 'JUDGE_REJECTED') {
        break
      }
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
    ...(lastError?.verification ? { verification: lastError.verification } : {}),
    ...(lastError?.judge ? { judge: lastError.judge } : {}),
    revision,
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
    ...(lastError?.judge ? { judge: lastError.judge } : {}),
    revision,
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
      harness: nodeHarness,
      waitMode: nodeWaitMode,
      ...(lastError?.verification ? { verification: lastError.verification } : {}),
      ...(lastError?.judge ? { judge: lastError.judge } : {}),
      revision,
    },
    { env }
  )
}

/**
 * Waits for a dispatch handle until terminal, handling waiting/timeout.
 * - terminal succeeded -> returns the record (node may advance)
 * - terminal failed/canceled -> throws (retry/fail path)
 * - waiting -> persists WAITING, blocks until external resume to running
 *   (no re-dispatch), then waits again
 * - local timeout -> abort + confirm + throw ETIMEDOUT (retry attempt+1)
 */
async function waitForHandleTerminal({
  workflow,
  node,
  ctx,
  env,
  handle,
  timeoutS,
  attempt,
  maxAttempts,
  nodeStates,
  claimedBy,
  waitExecutionFn,
  readRecord,
  onWaiting,
  waitingTimeoutS,
  pollIntervalMs,
}) {
  const jobId = handle.jobId ?? handle?.job?.jobId
  const waitStart = Date.now()
  for (;;) {
    const elapsedS = (Date.now() - waitStart) / 1000
    const remainingS = Math.max(1, timeoutS - elapsedS)
    const outcome = await waitExecutionFn(handle, {
      timeoutS: remainingS,
      pollIntervalMs,
      readResultFn: readRecord,
      onWaiting: async ({ record, reason }) => {
        await onWaiting?.({ workflowId: workflow.id, stepId: node.id, record, reason })
      },
    })

    if (outcome?.aborted) {
      const err = new Error(`Node "${node.id}" aborted (attempt ${attempt}/${maxAttempts})`)
      err.code = 'EABORTED'
      throw err
    }

    if (outcome?.waiting) {
      const reason = outcome.reason ?? 'external_event'
      // running -> waiting (persisted; scheduler holds the claim)
      assertValidTransition(NODE_STATUS.RUNNING, NODE_STATUS.WAITING, node.id)
      const now = new Date().toISOString()
      upsertWorkflowNode(ctx, {
        workflow_id: workflow.id,
        step_id: node.id,
        status: NODE_STATUS.WAITING,
        attempt,
        updated_at: now,
        claimed_by: claimedBy,
        result_json: JSON.stringify({ waiting: true, waitReason: reason, jobId, remoteState: outcome.remoteState ?? null }),
      })
      nodeStates.set(node.id, {
        ...nodeStates.get(node.id),
        status: NODE_STATUS.WAITING,
        attempt,
        result: { waiting: true, waitReason: reason, jobId },
      })
      await onWaiting?.({ workflowId: workflow.id, stepId: node.id, record: outcome.record, reason })

      // Block until an external actor resumes (waiting -> running) without
      // dispatching again. Bounded so a forgotten wait still surfaces.
      const resumeDeadline = Date.now() + Math.max(1, waitingTimeoutS) * 1000
      for (;;) {
        await sleep(Math.max(10, pollIntervalMs))
        const row = getWorkflowNode(ctx, workflow.id, node.id)
        if (!row || row.status !== NODE_STATUS.WAITING) {
          const current = row?.status
          if (current === NODE_STATUS.RUNNING) break // resumed: wait on the same handle again
          if (current === NODE_STATUS.CANCELED) {
            const err = new Error(`Node "${node.id}" canceled while waiting`)
            err.code = 'ECANCELED'
            throw err
          }
          if (current === NODE_STATUS.FAILED) {
            const err = new Error(`Node "${node.id}" failed while waiting`)
            err.code = 'EWAITFAILED'
            throw err
          }
          break
        }
        if (Date.now() >= resumeDeadline) {
          try { await handle.abort?.() } catch {}
          const err = new Error(`Node "${node.id}" waiting timed out after ${waitingTimeoutS}s (attempt ${attempt}/${maxAttempts})`)
          err.code = 'ETIMEDOUT'
          throw err
        }
      }
      continue
    }

    if (outcome?.timedOut) {
      // Local deadline: abort the handle, confirm the record, retry attempt+1.
      let confirmed = null
      try {
        await handle.abort?.()
      } catch {}
      try {
        confirmed = readRecord(jobId)
      } catch {}
      if (confirmed && ['succeeded', 'failed', 'canceled'].includes(confirmed.status)) {
        if (confirmed.status === 'succeeded') return confirmed
        const err = new Error(`Node "${node.id}" confirmed ${confirmed.status} after abort: ${confirmed.error ?? ''}`)
        err.code = confirmed.status === 'canceled' ? 'ECANCELED' : 'EABORTED'
        err.record = confirmed
        throw err
      }
      const err = new Error(`Node "${node.id}" timed out after ${timeoutS}s (attempt ${attempt}/${maxAttempts})`)
      err.code = 'ETIMEDOUT'
      throw err
    }

    const status = outcome?.status ?? outcome?.record?.status
    const record = outcome?.record ?? null
    if (status === 'succeeded') {
      return record ?? { success: true, jobId }
    }
    if (status === 'failed' || status === 'canceled') {
      const err = new Error(
        `Node "${node.id}" execution ${status}: ${record?.error ?? record?.errorKind ?? 'unknown'} (attempt ${attempt}/${maxAttempts})`
      )
      err.code = status === 'canceled' ? 'ECANCELED' : 'EEXECFAILED'
      err.record = record
      throw err
    }
    // Unknown outcome shape: treat as timeout so the retry path engages.
    const err = new Error(`Node "${node.id}" wait returned unknown outcome (attempt ${attempt}/${maxAttempts})`)
    err.code = 'ETIMEDOUT'
    throw err
  }
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
  runCommandFn = null,
  claimedBy = `scheduler_${crypto.randomUUID()}`,
  pollIntervalMs = 25,
  backoffMs = 50,
  waitExecutionFn = defaultWaitExecution,
  readResultFn = null,
  onWaiting = null,
  waitingTimeoutS = 300,
  leaseTtlMs = CLAIM_LEASE_TTL_MS,
  isOwnerAlive = null,
} = {}) {
  const dbCtx = ctx || getDb(env)
  let workflow = null
  const isResume = Boolean(!inputWorkflow && inputWorkflowId)
  // Liveness probe: by default any foreign owner is assumed dead (a resume
  // means this process restarted and the old holder is gone). Pass an
  // explicit isOwnerAlive(owner, me) for precise AND semantics with the
  // lease check below.
  const ownerAlive = typeof isOwnerAlive === 'function' ? isOwnerAlive : () => false
  // Sin probe explícito, un dueño foráneo se asume muerto (resume tras
  // reinicio: el holder anterior desapareció con el proceso). Con probe
  // explícito rige el AND estricto: lease expirado Y dueño muerto.
  const hasExplicitProbe = typeof isOwnerAlive === 'function'

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
      let claimed = row.claimed_by

      // On resume: orphaned running nodes revive to ready ONLY when the
      // lease expired AND the owner is dead; otherwise re-adopt without
      // re-executing. Waiting nodes are always re-adopted (never reset).
      if (isResume && status === NODE_STATUS.RUNNING) {
        const owner = row.claimed_by
        if (owner && owner !== claimedBy && !ownerAlive(owner, claimedBy)) {
          const updatedAt = Date.parse(row.updated_at ?? '') || 0
          const leaseExpired = Date.now() - updatedAt > leaseTtlMs
          if (leaseExpired || !hasExplicitProbe) {
            assertValidTransition(NODE_STATUS.RUNNING, NODE_STATUS.READY, node.id)
            status = NODE_STATUS.READY
            upsertWorkflowNode(dbCtx, {
              workflow_id: workflow.id,
              step_id: node.id,
              status: NODE_STATUS.READY,
              attempt: row.attempt,
              claimed_by: null,
              updated_at: new Date().toISOString(),
            })
            claimed = null
          }
        } else if (!owner || owner === claimedBy) {
          // Same owner (or unclaimed): keep running, re-adopt silently.
        }
      }

      let existingHandoff = null
      try {
        existingHandoff = readHandoff({ workflowId: workflow.id, stepId: node.id }, env)
      } catch {}

      nodeStates.set(node.id, {
        status,
        attempt: row.attempt || 0,
        result,
        error: null,
        claimed_by: status === NODE_STATUS.READY ? null : (status === row.status ? claimed : claimed),
        ...(existingHandoff ? { handoff: existingHandoff } : {}),
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
      const anyActive = Array.from(nodeStates.values()).some(
        (s) => s.status === NODE_STATUS.RUNNING || s.status === NODE_STATUS.WAITING
      )
      if (anyActive) {
        await sleep(pollIntervalMs)
        continue
      }
      break
    }

    // 4. Parallel wave execution via Promise.all
    await Promise.all(
      readyNodes.map(async (node) => {
        // Publish PENDING -> READY through a CONDITIONAL update (only from
        // pending): it can never overwrite another scheduler's running
        // claim, so the CAS claim below stays the single winner gate.
        publishWorkflowNodeReady(dbCtx, { workflowId: workflow.id, stepId: node.id })
        const published = getWorkflowNode(dbCtx, workflow.id, node.id)
        if (published?.status === NODE_STATUS.READY) {
          nodeStates.set(node.id, { ...nodeStates.get(node.id), status: NODE_STATUS.READY })
        }
        // Atomic CAS Claim via claimNode: única vía ready→running (C1.8 / C1.9)
        const currentAttempt = (nodeStates.get(node.id)?.attempt || 0) + 1
        const claimed = claimNode(dbCtx, {
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
          runCommandFn,
          nodeStates,
          claimedBy,
          backoffMs,
          waitExecutionFn,
          readResultFn,
          onWaiting,
          waitingTimeoutS,
          pollIntervalMs,
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
  const existingWorkflow = getWorkflow(dbCtx, workflow.id)
  const previousStatus = existingWorkflow?.status

  upsertWorkflow(dbCtx, {
    id: workflow.id,
    name: workflow.name,
    status: finalStatus,
    updated_at: new Date().toISOString(),
  })

  if (!isTerminalStatus(previousStatus)) {
    const counts = {
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      canceled: 0,
    }
    for (const state of nodeStates.values()) {
      counts.total++
      if (state?.status === NODE_STATUS.SUCCEEDED) counts.succeeded++
      else if (state?.status === NODE_STATUS.FAILED) counts.failed++
      else if (state?.status === NODE_STATUS.SKIPPED) counts.skipped++
      else if (state?.status === NODE_STATUS.CANCELED) counts.canceled++
    }

    appendEvent(
      {
        kind: 'workflow.completed',
        workflow_id: workflow.id,
        status: finalStatus,
        counts,
      },
      { env }
    )
  }

  return {
    workflowId: workflow.id,
    status: finalStatus,
    nodes: Object.fromEntries(nodeStates.entries()),
  }
}

export { isHandleLike }
