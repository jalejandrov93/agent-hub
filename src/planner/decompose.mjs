import { validatePlan, materializePlan } from './plan.mjs'

export async function decompose({ intent, runPlanner, routeFn, env = process.env, maxSteps = 12 } = {}) {
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    return {
      ok: false,
      errors: [{ path: 'intent', message: 'intent must be a non-empty string' }]
    }
  }

  if (typeof runPlanner !== 'function') {
    return {
      ok: false,
      errors: [{ path: 'runPlanner', message: 'runPlanner is required and must be a function' }]
    }
  }

  let rawPlan
  try {
    rawPlan = await runPlanner({ intent, env })
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: 'planner', message: err?.message || String(err) }]
    }
  }

  const validation = validatePlan(rawPlan)
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    }
  }

  const plan = validation.plan
  if (plan.steps.length > maxSteps) {
    return {
      ok: false,
      errors: [
        {
          path: 'steps',
          message: `plan contains ${plan.steps.length} steps, exceeding maximum of ${maxSteps}`
        }
      ]
    }
  }

  let workflow
  try {
    workflow = await materializePlan({ plan, ...(routeFn ? { routeFn } : {}), env })
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: 'materialize', message: err?.message || String(err) }]
    }
  }

  return {
    ok: true,
    plan,
    workflow
  }
}
