import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getRole, requirementsForRole } from '../roles.mjs'
import { route } from '../router.mjs'
import { createWorkflow, findCycleInGraph } from '../workflow/schema.mjs'

export const PlanNodeSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    dependsOn: z.array(z.string()).default([]),
    task: z.string().optional(),
    taskType: z.string().optional()
  })
  .passthrough()

export const WorkflowPlanSchema = z
  .object({
    goal: z.string().min(1),
    steps: z.array(PlanNodeSchema).min(1)
  })
  .passthrough()

export function validatePlan(plan, { maxSteps = 12, maxDepth = 10, maxFanout = 20 } = {}) {
  const parsed = WorkflowPlanSchema.safeParse(plan)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'plan',
        message: issue.message
      }))
    }
  }

  const data = parsed.data

  const roleErrors = []
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i]
    if (!getRole(step.role)) {
      roleErrors.push({
        path: `steps.${i}.role`,
        message: `unknown role: "${step.role}"`
      })
    }
  }
  if (roleErrors.length > 0) {
    return { ok: false, errors: roleErrors }
  }

  const idErrors = []
  const seenIds = new Set()
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i]
    if (seenIds.has(step.id)) {
      idErrors.push({
        path: `steps.${i}.id`,
        message: `duplicate step id: "${step.id}"`
      })
    }
    seenIds.add(step.id)
  }
  if (idErrors.length > 0) {
    return { ok: false, errors: idErrors }
  }

  const depErrors = []
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i]
    for (const dep of step.dependsOn) {
      if (!seenIds.has(dep)) {
        depErrors.push({
          path: `steps.${i}.dependsOn`,
          message: `step "${step.id}" depends on unknown step "${dep}"`
        })
      }
    }
  }
  if (depErrors.length > 0) {
    return { ok: false, errors: depErrors }
  }

  const cycle = findCycleInGraph(data.steps)
  if (cycle) {
    return {
      ok: false,
      errors: [
        {
          path: 'steps',
          message: `cycle detected in plan DAG: ${cycle.join(' -> ')}`
        }
      ]
    }
  }

  if (data.steps.length > maxSteps) {
    return {
      ok: false,
      errors: [{
        path: 'steps',
        message: `plan contains ${data.steps.length} steps, exceeding maximum of ${maxSteps}`
      }]
    }
  }

  const boundsErrors = []

  // Calculate DAG depth
  const depths = new Map()
  const calculating = new Set()
  function getDepth(id) {
    if (depths.has(id)) return depths.get(id)
    if (calculating.has(id)) return 0 // cycles handled by findCycleInGraph
    calculating.add(id)
    const step = data.steps.find((s) => s.id === id)
    if (!step || step.dependsOn.length === 0) {
      depths.set(id, 1)
      calculating.delete(id)
      return 1
    }
    let maxDepDepth = 0
    for (const depId of step.dependsOn) {
      const depDepth = getDepth(depId)
      if (depDepth > maxDepDepth) maxDepDepth = depDepth
    }
    const currentDepth = maxDepDepth + 1
    depths.set(id, currentDepth)
    calculating.delete(id)
    return currentDepth
  }

  let maxActualDepth = 0
  for (const step of data.steps) {
    const depth = getDepth(step.id)
    if (depth > maxActualDepth) maxActualDepth = depth
  }

  if (maxActualDepth > maxDepth) {
    boundsErrors.push({
      path: 'steps',
      message: `plan depth of ${maxActualDepth} exceeds maximum of ${maxDepth}`
    })
  }

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i]
    if (step.dependsOn.length > maxFanout) {
      boundsErrors.push({
        path: `steps.${i}.dependsOn`,
        message: `step "${step.id}" depends on ${step.dependsOn.length} steps, exceeds maxFanout of ${maxFanout}`
      })
    }

    if (step.type === 'fanout' && Array.isArray(step.items) && step.items.length > maxFanout) {
      boundsErrors.push({
        path: `steps.${i}.items`,
        message: `step "${step.id}" items length of ${step.items.length} exceeds maxFanout of ${maxFanout}`
      })
    }
  }

  if (boundsErrors.length > 0) {
    return { ok: false, errors: boundsErrors }
  }

  return { ok: true, plan: data }
}

export async function materializePlan({ plan, routeFn = route, env = process.env, maxSteps = 12, maxDepth = 10, maxFanout = 20 } = {}) {
  const validation = validatePlan(plan, { maxSteps, maxDepth, maxFanout })
  if (!validation.ok) {
    const details = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
    throw new Error(`Invalid plan: ${details}`)
  }

  const validPlan = validation.plan
  const nodes = []

  for (const step of validPlan.steps) {
    const role = getRole(step.role)
    const modeFor = role.capabilities.includes('write') ? 'write' : 'read'
    const taskType = step.taskType ?? role.defaultTaskType
    const routed = await routeFn({
      taskType,
      mode: modeFor,
      requirements: requirementsForRole(step.role),
      env
    })

    if (!routed || !routed.primary) {
      throw new Error(`Step "${step.id}" routing failed: primary candidate is null`)
    }

    const { agent, model } = routed.primary
    const node = {
      id: step.id,
      type: 'delegate',
      agent,
      model,
      mode: modeFor,
      task: step.task ?? ('Fulfil the ' + step.role + ' step'),
      dependsOn: step.dependsOn,
      metadata: { role: step.role },
      handoff: {
        required: role.handoffRequired === true,
        ...(role.handoffRequired === true ? { schema: role.handoffSchema } : {})
      }
    }

    nodes.push(node)
  }

  const hash = createHash('sha256').update(validPlan.goal).digest('hex').slice(0, 12)
  const workflowId = `plan-${hash}`

  return createWorkflow({
    id: workflowId,
    name: validPlan.goal,
    nodes
  })
}
