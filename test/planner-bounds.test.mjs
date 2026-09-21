import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from '../src/planner/plan.mjs'
import { planTaskTool } from '../src/tools/planner.mjs'

test('planner bounds: planTaskTool rejects over-limit explicit plan with default maxSteps', async () => {
  const steps = []
  for (let i = 0; i < 13; i++) {
    steps.push({ id: `s${i}`, role: 'ARCHITECT' })
  }
  const res = await planTaskTool({
    plan: { goal: 'Too many steps', steps }
  })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.message.includes('exceeding maximum of 12')))
})

test('planner bounds: validates maxDepth and rejects deeper chains', async () => {
  const steps = []
  for (let i = 0; i < 11; i++) {
    steps.push({
      id: `s${i}`,
      role: 'ARCHITECT',
      dependsOn: i > 0 ? [`s${i - 1}`] : []
    })
  }
  const res = await validatePlan({ goal: 'Deep', steps }, { maxDepth: 10, maxSteps: 50 })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.message.includes('plan depth of 11 exceeds maximum of 10')))
})

test('planner bounds: validates maxFanout and rejects large dependsOn', async () => {
  const res = await validatePlan({
    goal: 'Wide',
    steps: [
      ...Array.from({ length: 21 }).map((_, i) => ({ id: `dep${i}`, role: 'ARCHITECT' })),
      { id: 'wide', role: 'IMPLEMENTER', dependsOn: Array.from({ length: 21 }).map((_, i) => `dep${i}`) }
    ]
  }, { maxFanout: 20, maxSteps: 50 })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.message.includes('exceeds maxFanout of 20')))
})

test('planner bounds: validates maxFanout and rejects large items', async () => {
  const res = await validatePlan({
    goal: 'Wide items',
    steps: [
      { id: 'wide', role: 'IMPLEMENTER', taskType: 'fanout', type: 'fanout', items: Array.from({ length: 21 }).map((_, i) => i) }
    ]
  }, { maxFanout: 20, maxSteps: 50 })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.message.includes('exceeds maxFanout of 20')))
})

test('planner bounds: valid plan passes and materializes', async () => {
  const res = await planTaskTool({
    plan: {
      goal: 'Valid',
      steps: [
        { id: 's1', role: 'ARCHITECT' },
        { id: 's2', role: 'IMPLEMENTER', dependsOn: ['s1'] }
      ]
    },
    routeFn: async () => ({ primary: { agent: 'a', model: 'm' } })
  })
  assert.equal(res.ok, true)
  assert.ok(res.workflow)
  assert.equal(res.workflow.nodes.length, 2)
})
