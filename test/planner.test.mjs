import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLES, getRole } from '../src/roles.mjs'
import { knownTaskTypes } from '../src/router.mjs'
import { WorkflowSchema } from '../src/workflow/schema.mjs'
import { validatePlan, materializePlan } from '../src/planner/plan.mjs'
import { decompose } from '../src/planner/decompose.mjs'

test('validatePlan: rejects missing goal', () => {
  const result = validatePlan({
    steps: [{ id: 'step-1', role: 'ARCHITECT' }]
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0)
})

test('validatePlan: rejects an unknown role', () => {
  const result = validatePlan({
    goal: 'Build something',
    steps: [{ id: 'step-1', role: 'NON_EXISTENT_ROLE' }]
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.message.includes('unknown role') || e.message.includes('NON_EXISTENT_ROLE')))
})

test('validatePlan: rejects duplicate ids', () => {
  const result = validatePlan({
    goal: 'Build something',
    steps: [
      { id: 'step-1', role: 'ARCHITECT' },
      { id: 'step-1', role: 'IMPLEMENTER' }
    ]
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.message.includes('duplicate')))
})

test('validatePlan: rejects unknown dependsOn', () => {
  const result = validatePlan({
    goal: 'Build something',
    steps: [
      { id: 'step-1', role: 'ARCHITECT', dependsOn: ['missing-step'] }
    ]
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.message.includes('unknown step') || e.message.includes('missing-step')))
})

test('validatePlan: rejects a cycle', () => {
  const result = validatePlan({
    goal: 'Build something',
    steps: [
      { id: 'step-1', role: 'ARCHITECT', dependsOn: ['step-2'] },
      { id: 'step-2', role: 'IMPLEMENTER', dependsOn: ['step-1'] }
    ]
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.message.includes('cycle') || e.message.includes('Cycle')))
})

test('validatePlan: accepts a valid plan', () => {
  const plan = {
    goal: 'Ship feature',
    steps: [
      { id: 'arch', role: 'ARCHITECT' },
      { id: 'impl', role: 'IMPLEMENTER', dependsOn: ['arch'] }
    ]
  }
  const result = validatePlan(plan)
  assert.equal(result.ok, true)
  assert.equal(result.plan.goal, 'Ship feature')
  assert.equal(result.plan.steps.length, 2)
})

test('materializePlan: with injected routeFn yields WorkflowSchema-valid workflow with correct node attributes', async () => {
  const plan = {
    goal: 'Deliver planner slice',
    steps: [
      { id: 'plan-step', role: 'PLANNER' },
      { id: 'impl-step', role: 'IMPLEMENTER', dependsOn: ['plan-step'] }
    ]
  }

  const calls = []
  const mockRoute = async ({ taskType, mode, requirements }) => {
    calls.push({ taskType, mode, requirements })
    if (taskType === 'architecture') {
      return { primary: { agent: 'claude', model: 'opus' } }
    }
    if (taskType === 'mechanical-edit') {
      return { primary: { agent: 'opencode', model: 'deepseek/deepseek-v4-flash' } }
    }
    return { primary: { agent: 'copilot', model: 'auto' } }
  }

  const wf = await materializePlan({ plan, routeFn: mockRoute })

  // Assert WorkflowSchema validity
  const parsed = WorkflowSchema.safeParse(wf)
  assert.equal(parsed.success, true, 'workflow satisfies WorkflowSchema')
  assert.equal(wf.name, 'Deliver planner slice')
  assert.ok(wf.id.startsWith('plan-'))
  assert.equal(wf.id.length, 5 + 12) // 'plan-' + 12 hex chars

  // Node 1: PLANNER
  const plannerNode = wf.nodes.find((n) => n.id === 'plan-step')
  assert.ok(plannerNode)
  assert.equal(plannerNode.type, 'delegate')
  assert.equal(plannerNode.agent, 'claude')
  assert.equal(plannerNode.model, 'opus')
  assert.equal(plannerNode.mode, 'read')
  assert.equal(plannerNode.task, 'Fulfil the PLANNER step')
  assert.deepEqual(plannerNode.metadata, { role: 'PLANNER' })
  assert.equal(plannerNode.handoff?.schema, undefined, 'no handoff schema on PLANNER step')

  // Node 2: IMPLEMENTER
  const implementerNode = wf.nodes.find((n) => n.id === 'impl-step')
  assert.ok(implementerNode)
  assert.equal(implementerNode.type, 'delegate')
  assert.equal(implementerNode.agent, 'opencode')
  assert.equal(implementerNode.model, 'deepseek/deepseek-v4-flash')
  assert.equal(implementerNode.mode, 'write')
  assert.equal(implementerNode.task, 'Fulfil the IMPLEMENTER step')
  assert.deepEqual(implementerNode.metadata, { role: 'IMPLEMENTER' })
  assert.equal(implementerNode.handoff?.schema, 'ImplementationHandoff', 'handoff schema on IMPLEMENTER step')
  assert.equal(implementerNode.handoff?.required, true)
})

test('materializePlan: throws naming the step when routeFn returns primary null', async () => {
  const plan = {
    goal: 'Fail routing',
    steps: [{ id: 'step-fail', role: 'ARCHITECT' }]
  }

  const failingRoute = async () => ({ primary: null })

  await assert.rejects(
    async () => {
      await materializePlan({ plan, routeFn: failingRoute })
    },
    (err) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /step-fail/)
      return true
    }
  )
})

test('decompose: returns ok for a valid plan', async () => {
  const runPlanner = async ({ intent }) => ({
    goal: intent,
    steps: [
      { id: 's1', role: 'ARCHITECT', task: 'Design things' }
    ]
  })

  const res = await decompose({ intent: 'Create API', runPlanner })
  assert.equal(res.ok, true)
  assert.ok(res.plan)
  assert.ok(res.workflow)
  assert.equal(res.workflow.nodes.length, 1)
})

test('decompose: fails closed (no workflow) for an invalid plan', async () => {
  const runPlanner = async () => ({
    goal: 'Missing steps',
    steps: []
  })

  const res = await decompose({ intent: 'Create API', runPlanner })
  assert.equal(res.ok, false)
  assert.equal(res.workflow, undefined)
  assert.ok(res.errors.length > 0)
})

test('decompose: fails closed (no workflow) for an over-maxSteps plan', async () => {
  const runPlanner = async ({ intent }) => ({
    goal: intent,
    steps: [
      { id: 's1', role: 'ARCHITECT' },
      { id: 's2', role: 'IMPLEMENTER' },
      { id: 's3', role: 'TEST_ANALYST' }
    ]
  })

  const res = await decompose({ intent: 'Big task', runPlanner, maxSteps: 2 })
  assert.equal(res.ok, false)
  assert.equal(res.workflow, undefined)
  assert.ok(res.errors.some((e) => e.message.includes('exceeding maximum') || e.message.includes('maxSteps') || e.message.includes('steps')))
})

test('decompose: fails closed (no workflow) for a throwing planner', async () => {
  const runPlanner = async () => {
    throw new Error('Planner LLM context exhausted')
  }

  const res = await decompose({ intent: 'Create API', runPlanner })
  assert.equal(res.ok, false)
  assert.equal(res.workflow, undefined)
  assert.ok(res.errors.some((e) => e.message.includes('Planner LLM context exhausted')))
})

test('ROLES includes PLANNER and every role defaultTaskType is in knownTaskTypes()', () => {
  assert.ok('PLANNER' in ROLES)
  assert.ok(ROLES.PLANNER)
  const role = getRole('PLANNER')
  assert.ok(role)
  assert.equal(role.name, 'PLANNER')
  assert.deepEqual(role.capabilities, [])
  assert.equal(role.handoffSchema, 'BaseHandoff')
  assert.equal(role.handoffRequired, false)
  assert.deepEqual(role.acceptance, ['the plan validates against WorkflowPlan'])

  const taskTypes = knownTaskTypes()
  for (const name of Object.getOwnPropertyNames(ROLES)) {
    const r = ROLES[name]
    assert.ok(typeof r.defaultTaskType === 'string', `${name} has defaultTaskType string`)
    assert.ok(taskTypes.includes(r.defaultTaskType), `${name} defaultTaskType "${r.defaultTaskType}" is in knownTaskTypes()`)
  }
})
