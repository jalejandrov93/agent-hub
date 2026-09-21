import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTaskTool, executePlanTool } from '../src/tools/planner.mjs'

const mockRoute = async () => ({
  primary: { agent: 'agy', model: 'gemini-3.8-flash-low' }
})

test('planTaskTool: returns a validated plan and workflow with an injected planner', async () => {
  const plannerFn = async ({ intent }) => ({
    goal: intent,
    steps: [
      { id: 'arch', role: 'ARCHITECT' },
      { id: 'impl', role: 'IMPLEMENTER', dependsOn: ['arch'] }
    ]
  })

  const res = await planTaskTool({
    intent: 'Create user dashboard',
    plannerFn,
    routeFn: mockRoute
  })

  assert.equal(res.ok, true)
  assert.equal(res.plan.goal, 'Create user dashboard')
  assert.equal(res.plan.steps.length, 2)
  assert.ok(res.workflow)
  assert.equal(res.workflow.name, 'Create user dashboard')
  assert.ok(res.workflow.id.startsWith('plan-'))
  assert.equal(res.workflow.nodes.length, 2)
})

test('planTaskTool: fails closed (no workflow) for an invalid plan', async () => {
  const plannerFn = async ({ intent }) => ({
    goal: intent,
    steps: [
      { id: 's1', role: 'NON_EXISTENT_ROLE' }
    ]
  })

  const res = await planTaskTool({
    intent: 'Broken plan task',
    plannerFn,
    routeFn: mockRoute
  })

  assert.equal(res.ok, false)
  assert.equal(res.workflow, undefined)
  assert.ok(Array.isArray(res.errors))
  assert.ok(res.errors.some((e) => e.message.includes('unknown role')))
})

test('planTaskTool: fails closed (no workflow) for an oversized plan exceeding maxSteps', async () => {
  const plannerFn = async ({ intent }) => ({
    goal: intent,
    steps: [
      { id: 's1', role: 'ARCHITECT' },
      { id: 's2', role: 'IMPLEMENTER' },
      { id: 's3', role: 'TEST_ANALYST' }
    ]
  })

  const res = await planTaskTool({
    intent: 'Oversized task',
    plannerFn,
    maxSteps: 2,
    routeFn: mockRoute
  })

  assert.equal(res.ok, false)
  assert.equal(res.workflow, undefined)
  assert.ok(Array.isArray(res.errors))
  assert.ok(res.errors.some((e) => e.message.includes('exceeding maximum') || e.message.includes('steps')))
})

test('planTaskTool: fails closed (no workflow) for a throwing planner', async () => {
  const plannerFn = async () => {
    throw new Error('LLM rate limit reached')
  }

  const res = await planTaskTool({
    intent: 'Throwing planner task',
    plannerFn,
    routeFn: mockRoute
  })

  assert.equal(res.ok, false)
  assert.equal(res.workflow, undefined)
  assert.ok(Array.isArray(res.errors))
  assert.ok(res.errors.some((e) => e.message.includes('LLM rate limit reached')))
})

test('planTaskTool: fails closed when plannerFn is missing or not a function', async () => {
  const res = await planTaskTool({
    intent: 'Missing planner',
    routeFn: mockRoute
  })

  assert.equal(res.ok, false)
  assert.equal(res.workflow, undefined)
  assert.ok(Array.isArray(res.errors))
  assert.ok(res.errors.length > 0)
})

test('executePlanTool: refuses execution without approve:true and does not call runWorkflowFn (counter stays 0)', async () => {
  let runCount = 0
  const mockRunWorkflow = async () => {
    runCount++
    return { workflowId: 'wf-123', status: 'succeeded', nodes: {} }
  }

  const validPlan = {
    goal: 'Valid plan',
    steps: [{ id: 's1', role: 'ARCHITECT' }]
  }

  const resFalse = await executePlanTool({
    plan: validPlan,
    approve: false,
    runWorkflowFn: mockRunWorkflow
  })
  assert.equal(resFalse.ok, false)
  assert.equal(resFalse.error, 'approval required: pass approve:true after reviewing the plan')
  assert.equal(runCount, 0)

  const resUndef = await executePlanTool({
    plan: validPlan,
    runWorkflowFn: mockRunWorkflow
  })
  assert.equal(resUndef.ok, false)
  assert.equal(resUndef.error, 'approval required: pass approve:true after reviewing the plan')
  assert.equal(runCount, 0)

  const resTruthyString = await executePlanTool({
    plan: validPlan,
    approve: 'true',
    runWorkflowFn: mockRunWorkflow
  })
  assert.equal(resTruthyString.ok, false)
  assert.equal(resTruthyString.error, 'approval required: pass approve:true after reviewing the plan')
  assert.equal(runCount, 0)
})

test('executePlanTool: with approve:true and a valid plan calls runWorkflowFn and returns workflowId, status, and nodes', async () => {
  let runCount = 0
  let capturedArgs = null
  const mockRunWorkflow = async ({ workflow, env }) => {
    runCount++
    capturedArgs = { workflow, env }
    return {
      workflowId: workflow.id,
      status: 'succeeded',
      nodes: { s1: { status: 'succeeded' } }
    }
  }

  const validPlan = {
    goal: 'Ship slice',
    steps: [{ id: 's1', role: 'ARCHITECT' }]
  }

  const res = await executePlanTool({
    plan: validPlan,
    approve: true,
    runWorkflowFn: mockRunWorkflow,
    routeFn: mockRoute
  })

  assert.equal(res.ok, true)
  assert.equal(runCount, 1)
  assert.ok(res.workflowId.startsWith('plan-'))
  assert.equal(res.status, 'succeeded')
  assert.deepEqual(res.nodes, { s1: { status: 'succeeded' } })
  assert.equal(capturedArgs.workflow.id, res.workflowId)
})

test('executePlanTool: with approve:true and an invalid plan fails closed without running runWorkflowFn (counter stays 0)', async () => {
  let runCount = 0
  const mockRunWorkflow = async () => {
    runCount++
    return { workflowId: 'wf-123', status: 'succeeded', nodes: {} }
  }

  const invalidPlan = {
    goal: 'Invalid plan',
    steps: [{ id: 's1', role: 'NON_EXISTENT_ROLE' }]
  }

  const res = await executePlanTool({
    plan: invalidPlan,
    approve: true,
    runWorkflowFn: mockRunWorkflow,
    routeFn: mockRoute
  })

  assert.equal(res.ok, false)
  assert.equal(runCount, 0)
  assert.ok(Array.isArray(res.errors))
  assert.ok(res.errors.some((e) => e.message.includes('unknown role')))
})

test('executePlanTool: fails closed on invalid plan structure without running runWorkflowFn (counter stays 0)', async () => {
  let runCount = 0
  const mockRunWorkflow = async () => {
    runCount++
    return { workflowId: 'wf-123', status: 'succeeded', nodes: {} }
  }

  const res = await executePlanTool({
    plan: { invalidStructure: true },
    approve: true,
    runWorkflowFn: mockRunWorkflow,
    routeFn: mockRoute
  })

  assert.equal(res.ok, false)
  assert.equal(runCount, 0)
  assert.ok(Array.isArray(res.errors))
  assert.ok(res.errors.length > 0)
})
