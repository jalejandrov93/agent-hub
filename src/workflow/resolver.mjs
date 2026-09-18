import { NODE_STATUS, isTerminalStatus } from './state.mjs'
import { evaluateConditionSafe } from './dsl.mjs'

/**
 * Creates a safe proxy for step outcomes so property lookups do not throw TypeError
 * when intermediate properties are missing.
 * @param {Record<string, any>} stepsMap
 * @returns {Record<string, any>}
 */
function createSafeSteps(stepsMap) {
  const target = {}
  for (const [id, state] of Object.entries(stepsMap)) {
    target[id] = {
      status: state?.status,
      attempt: state?.attempt ?? 0,
      result: state?.result ?? null,
      output: state?.result?.output ?? state?.result ?? null,
      error: state?.error ?? null,
    }
  }

  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) {
        return obj[prop]
      }
      return {
        status: undefined,
        attempt: 0,
        result: null,
        output: null,
        error: null,
      }
    },
  })
}

/**
 * Safely evaluates a simple condition expression against the current step outcomes.
 *
 * Example expressions:
 *   "steps.review.status == 'succeeded'"
 *   "steps.test.status != 'failed'"
 *   "steps.deploy.result.ok === true"
 *   "steps.a.status == 'succeeded' && steps.b.status == 'succeeded'"
 *
 * @param {string | undefined} conditionStr
 * @param {object} context
 * @param {object} context.steps
 * @returns {boolean}
 */
export function evaluateCondition(conditionStr, context = {}) {
  if (!conditionStr || typeof conditionStr !== 'string' || conditionStr.trim() === '') {
    return true
  }

  const steps = context.steps || {}
  try {
    return evaluateConditionSafe(conditionStr, { steps, context })
  } catch {
    return false
  }
}

/**
 * Resolves which pending nodes in a workflow DAG are ready to run or should be skipped.
 *
 * Rules:
 *   - A node is ready when all its `dependsOn` are succeeded (or skipped if condition permits).
 *   - If any dependency failed or canceled, default onFailure behavior propagates: dependents become skipped
 *     (unless the dependent node specifies a condition that explicitly evaluates to true).
 *   - If condition evaluates to false, node transitions to skipped.
 *
 * @param {object} params
 * @param {object} params.workflow - Validated workflow object with `nodes` array
 * @param {Map<string, object>} params.nodeStates - Map of nodeId -> { status, attempt, result, error }
 * @returns {{ ready: Array<object>, skipped: Array<{ node: object, reason: string }>, isComplete: boolean }}
 */
export function resolveDependencies({ workflow, nodeStates }) {
  const ready = []
  const skipped = []

  const rawStepsContext = {}
  for (const node of workflow.nodes) {
    rawStepsContext[node.id] = nodeStates.get(node.id) || { status: NODE_STATUS.PENDING }
  }
  const safeSteps = createSafeSteps(rawStepsContext)
  const evalContext = { steps: safeSteps, workflow }

  for (const node of workflow.nodes) {
    const state = nodeStates.get(node.id) || { status: NODE_STATUS.PENDING }
    if (state.status === NODE_STATUS.READY) {
      ready.push(node)
      continue
    }
    if (state.status !== NODE_STATUS.PENDING) {
      continue
    }

    const deps = node.dependsOn || []
    if (deps.length === 0) {
      // Root node with no dependencies
      if (node.condition) {
        const condPassed = evaluateCondition(node.condition, evalContext)
        if (condPassed) {
          ready.push(node)
        } else {
          skipped.push({ node, reason: 'condition_false' })
        }
      } else {
        ready.push(node)
      }
      continue
    }

    // Check terminal status of all dependencies
    const depRecords = deps.map((depId) => ({
      id: depId,
      state: nodeStates.get(depId) || { status: NODE_STATUS.PENDING },
    }))

    const allTerminal = depRecords.every((d) => isTerminalStatus(d.state.status))
    if (!allTerminal) {
      // Still waiting for upstream dependencies to finish
      continue
    }

    // Check for failed or canceled upstream dependencies
    const failedDep = depRecords.find(
      (d) => d.state.status === NODE_STATUS.FAILED || d.state.status === NODE_STATUS.CANCELED
    )

    if (failedDep) {
      if (node.condition) {
        const condPassed = evaluateCondition(node.condition, evalContext)
        if (condPassed) {
          ready.push(node)
          continue
        }
      }
      // Default: onFailure propagates -> skipped
      skipped.push({
        node,
        reason: `dependency_${failedDep.state.status}:${failedDep.id}`,
      })
      continue
    }

    // Check for skipped dependencies
    const skippedDep = depRecords.find((d) => d.state.status === NODE_STATUS.SKIPPED)
    if (skippedDep) {
      if (node.condition) {
        const condPassed = evaluateCondition(node.condition, evalContext)
        if (condPassed) {
          ready.push(node)
        } else {
          skipped.push({ node, reason: 'condition_false_on_skipped_dep' })
        }
      } else {
        skipped.push({
          node,
          reason: `dependency_skipped:${skippedDep.id}`,
        })
      }
      continue
    }

    // All dependencies succeeded
    if (node.condition) {
      const condPassed = evaluateCondition(node.condition, evalContext)
      if (condPassed) {
        ready.push(node)
      } else {
        skipped.push({ node, reason: 'condition_false' })
      }
    } else {
      ready.push(node)
    }
  }

  const isComplete = workflow.nodes.every((n) => {
    const s = nodeStates.get(n.id)?.status
    return isTerminalStatus(s)
  })

  return {
    ready,
    skipped,
    isComplete,
  }
}
