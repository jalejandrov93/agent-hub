import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { listJobs } from '../src/jobstore.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dispatch-reservation-'))
}

const dispatchModuleUrl = new URL('../src/dispatch.mjs', import.meta.url).href
const jobstoreModuleUrl = new URL('../src/jobstore.mjs', import.meta.url).href

// Two or more OS processes dispatching the SAME key at the same instant share
// one job. In-process dedup cannot help here and the recent-runs scan misses
// because no job exists yet, so only the store-backed reservation can gate it.
//
// startJobFn creates the real job record (exactly what jobrunner does) and then
// returns, so the job is resolvable by the losers without spawning a CLI.
const childScript = `
import { dispatch } from ${JSON.stringify(dispatchModuleUrl)}
import { createJob } from ${JSON.stringify(jobstoreModuleUrl)}

const deadline = Number(process.env.RACE_DEADLINE)
while (Date.now() < deadline) { /* barrier: release every child together */ }

let out
try {
  const res = await dispatch({
    task: 'same-task',
    cwd: process.env.RACE_CWD,
    taskType: 'recon',
    dispatchKey: process.env.RACE_KEY,
    env: process.env,
    waitMode: 'none',
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
    startJobFn: async (args) => {
      const job = createJob({ ...args, title: args.title ?? 'race' })
      await new Promise((r) => setTimeout(r, 150))
      return { job, done: Promise.resolve() }
    },
  })
  out = { jobId: res.jobId ?? res.job?.jobId ?? res.handle?.jobId ?? null }
} catch (err) {
  out = { error: String(err && err.message ? err.message : err) }
}
process.stdout.write(JSON.stringify(out))
`

function runChild(home, deadline, key, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: {
        ...process.env,
        AGENT_HUB_HOME: home,
        RACE_DEADLINE: String(deadline),
        RACE_KEY: key,
        RACE_CWD: cwd,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => {
      let parsed = null
      try { parsed = JSON.parse(stdout) } catch { /* leave null */ }
      resolve({ code, parsed, stdout, stderr })
    })
  })
}

test('T6: concurrent dispatches with the same key from separate processes create exactly one job', async () => {
  const home = tmpHome()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dispatch-cwd-'))
  const env = { ...process.env, AGENT_HUB_HOME: home }
  const key = `race-dispatch-key-${Date.now()}`
  const children = 4

  const deadline = Date.now() + 1500
  const results = await Promise.all(
    Array.from({ length: children }, () => runChild(home, deadline, key, cwd))
  )

  const errored = results.filter((r) => r.code !== 0 || !r.parsed || r.parsed.error)
  assert.deepEqual(
    errored.map((r) => ({ code: r.code, parsed: r.parsed, stderr: r.stderr.slice(0, 300) })),
    [],
    'every child must complete without error'
  )

  const jobs = listJobs(env)
  assert.equal(jobs.length, 1, `exactly one job may be created for one dispatch key, got ${jobs.length}`)

  const jobIds = new Set(results.map((r) => r.parsed.jobId))
  assert.equal(jobIds.size, 1, `every process must share the same job, got ${JSON.stringify([...jobIds])}`)
  assert.equal([...jobIds][0], jobs[0].jobId)
})

test('T6: a reservation whose job already failed does not block a fresh dispatch', async () => {
  const home = tmpHome()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dispatch-cwd-'))
  const env = { ...process.env, AGENT_HUB_HOME: home }
  const key = `stale-key-${Date.now()}`

  // A dead reservation whose job is terminal-failed: the next caller must be
  // able to dispatch again instead of sharing a corpse.
  const { getDb, reserveDispatchKey } = await import('../src/storage/index.mjs')
  const { createJob, updateResult } = await import('../src/jobstore.mjs')
  const ctx = getDb(env)
  const failed = createJob({ agent: 'agy', model: 'gemini-3.8-flash', task: 't', cwd, title: 'stale', dispatchKey: key, executionId: 'exec_dead', env })
  updateResult(failed.jobId, { status: 'failed', errorKind: 'crash', error: 'seed' }, env)
  reserveDispatchKey(ctx, { dispatchKey: key, jobId: 'exec_dead' })

  const { dispatch } = await import('../src/dispatch.mjs')
  const res = await dispatch({
    task: 'fresh-task',
    cwd,
    taskType: 'recon',
    dispatchKey: key,
    env,
    waitMode: 'none',
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
    startJobFn: async (args) => {
      const job = createJob({ ...args, title: 'fresh' })
      return { job, done: Promise.resolve() }
    },
  })

  const jobId = res.jobId ?? res.job?.jobId ?? null
  assert.ok(jobId, 'a fresh dispatch must produce a job')
  assert.notEqual(jobId, failed.jobId, 'it must not share the failed job')
})
