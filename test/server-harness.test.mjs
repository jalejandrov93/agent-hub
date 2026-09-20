import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listMcpTools } from '../src/index.mjs'

test('dispatch expone waitMode/harness opcionales; delegate no espera', () => {
  const tools = listMcpTools()
  const dispatch = tools.find((t) => t.name === 'dispatch')
  assert.ok(dispatch)
  assert.match(dispatch.description, /waitMode/)
  assert.match(dispatch.description, /waiting/)
  const delegate = tools.find((t) => t.name === 'delegate')
  assert.ok(delegate)
  assert.match(delegate.description, /never waits/)
})

test('job_wait y jules_wait documentan waiting≠failure e interact/supervise', () => {
  const tools = listMcpTools()
  const jobWait = tools.find((t) => t.name === 'job_wait')
  assert.ok(jobWait)
  assert.match(jobWait.description, /waiting/)
  const julesWait = tools.find((t) => t.name === 'jules_wait')
  assert.ok(julesWait)
  assert.match(julesWait.description, /jules_interact never restarts observation/)
  assert.match(julesWait.description, /jules_supervise.*lease|lease.*jules_supervise/)
})
