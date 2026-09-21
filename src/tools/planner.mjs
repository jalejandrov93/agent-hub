import { validatePlan, materializePlan } from '../planner/plan.mjs'
import { decompose } from '../planner/decompose.mjs'
import { runWorkflow } from '../workflow/engine.mjs'

/**
 * Plans a task and returns a validated plan plus its materialized workflow.
 *
 * Two entry points, because the orchestrator usually IS the planner:
 * - `plan` supplied: validate + materialize what the caller wrote (no model
 *   involved). This is the MCP path: Claude/OpenCode plan, agent-hub checks
 *   and materializes.
 * - `intent` only: delegate to an injected `plannerFn` (library use / tests).
 *   With no planner configured this fails closed with a clear message.
 * It NEVER executes anything.
 */
export async function planTaskTool({ intent, plan = null, plannerFn, maxSteps = 12, env = process.env, routeFn } = {}) {
  if (plan != null) {
    const validation = validatePlan(plan)
    if (!validation.ok) {
      return { ok: false, errors: validation.errors }
    }
    try {
      const workflow = await materializePlan({
        plan: validation.plan,
        env,
        ...(routeFn ? { routeFn } : {})
      })
      return { ok: true, plan: validation.plan, workflow }
    } catch (err) {
      return { ok: false, errors: [{ path: 'materialize', message: err?.message || String(err) }] }
    }
  }

  if (typeof plannerFn !== 'function') {
    return {
      ok: false,
      errors: [
        {
          path: 'plannerFn',
          message: 'no planner configured: pass an explicit plan object (the calling orchestrator plans) or inject a plannerFn'
        }
      ]
    }
  }

  return decompose({
    intent,
    runPlanner: plannerFn,
    maxSteps,
    env,
    ...(routeFn ? { routeFn } : {})
  })
}

export async function executePlanTool({ plan, approve, runWorkflowFn = runWorkflow, env = process.env, routeFn } = {}) {
  if (approve !== true) {
    return {
      ok: false,
      error: 'approval required: pass approve:true after reviewing the plan'
    }
  }

  const validation = validatePlan(plan)
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    }
  }

  let workflow
  try {
    workflow = await materializePlan({
      plan: validation.plan,
      env,
      ...(routeFn ? { routeFn } : {})
    })
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: 'materialize', message: err?.message || String(err) }]
    }
  }

  const result = await runWorkflowFn({ workflow, env })
  return {
    ok: true,
    workflowId: result.workflowId,
    status: result.status,
    nodes: result.nodes
  }
}
