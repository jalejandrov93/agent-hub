import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { adapterFor } from '../src/adapters/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-agys-'))
}

async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  return { ...jobrunner, jobstore }
}

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  process.nextTick(() => child.emit('close', 0, null))
  return child
}

// startJob is SYNCHRONOUS and must stay so: delegate()/dispatch() read
// `startJob(...).job` immediately. Profile resolution is therefore env-based
// (AGENT_HUB_AGYS_PROFILE) or an explicit parameter — never a promise.

test('startJob wraps agy in agys when AGENT_HUB_AGYS_PROFILE is set', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'say hello',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS_PROFILE: 'work' },
  })
  await done

  assert.equal(captured.length, 1)
  assert.equal(captured[0].cmd, 'agys')
  assert.equal(captured[0].args[0], 'run')
  assert.equal(captured[0].args[1], 'work')
  assert.equal(captured[0].args[2], '--')
  assert.ok(captured[0].args.includes('--model'))
  // The -low suffix becomes an explicit --effort so agys does not inject its own.
  assert.ok(captured[0].args.includes('gemini-3.8-flash'))
  assert.deepEqual(captured[0].args.slice(captured[0].args.indexOf('--effort'), captured[0].args.indexOf('--effort') + 2), ['--effort', 'low'])
  assert.ok(captured[0].args.includes('say hello'))

  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, 'work')
  assert.equal(record.profileStatus, 'selected')
  assert.equal(job.profile, 'work')
  assert.equal(job.profileStatus, 'selected')
})

test('startJob honors an explicit profile/profileStatus parameter', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'fallback',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'backup',
    profileStatus: 'fallback',
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(captured[0].cmd, 'agys')
  assert.deepEqual(captured[0].args.slice(0, 3), ['run', 'backup', '--'])
  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, 'backup')
  assert.equal(record.profileStatus, 'fallback')
})

test('startJob with agy and no agys env spawns plain agy with null profile fields', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'plain agy',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(captured[0].cmd, 'agy')
  assert.ok(!captured[0].args.includes('run'))
  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, null)
  assert.equal(record.profileStatus, null)
})

test('a non-agy agent ignores AGENT_HUB_AGYS_PROFILE entirely', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'opencode',
    model: 'opencode/muse-spark-1.3-contributor-free',
    task: 'not agy',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS_PROFILE: 'work' },
  })
  await done

  assert.notEqual(captured[0].cmd, 'agys')
  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, null)
  assert.equal(record.profileStatus, null)
})

test('startJob with AGENT_HUB_AGYS=auto and a faked sync resolver spawns agys run <profile> -- ...', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const fakeResolver = ({ env }) => {
    if (env?.AGENT_HUB_AGYS === 'auto') {
      return { profile: 'auto-picked', status: 'selected' }
    }
    return { profile: null, status: null }
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'auto task',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    resolveAgyProfileSyncFn: fakeResolver,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
  })
  await done

  assert.equal(captured.length, 1)
  assert.equal(captured[0].cmd, 'agys')
  assert.deepEqual(captured[0].args.slice(0, 3), ['run', 'auto-picked', '--'])
  assert.ok(captured[0].args.includes('--model'))
  assert.ok(captured[0].args.includes('gemini-3.8-flash'))
  assert.ok(captured[0].args.includes('--effort'))

  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, 'auto-picked')
  assert.equal(record.profileStatus, 'selected')
  assert.equal(job.profile, 'auto-picked')
  assert.equal(job.profileStatus, 'selected')
})

test('startJob with faked sync resolver without agys env stays plain agy', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const fakeResolver = ({ env }) => {
    if (env?.AGENT_HUB_AGYS === 'auto') {
      return { profile: 'auto-picked', status: 'selected' }
    }
    return { profile: null, status: null }
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'plain task',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    resolveAgyProfileSyncFn: fakeResolver,
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(captured.length, 1)
  assert.equal(captured[0].cmd, 'agy')
  assert.ok(!captured[0].args.includes('run'))

  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, null)
  assert.equal(record.profileStatus, null)
})

test('job.started and job.finished events carry resolved profile and profileStatus', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    const child = fakeChild()
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({ status: 'SUCCESS', response: 'all good' }))
    })
    return child
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'test events profile',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'work',
    profileStatus: 'selected',
    env: { AGENT_HUB_HOME: home },
  })
  await done

  const eventsFile = path.join(home, 'events.jsonl')
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse)
  const started = lines.find((e) => e.kind === 'job.started' && e.jobId === job.jobId)
  const finished = lines.find((e) => e.kind === 'job.finished' && e.jobId === job.jobId)

  assert.ok(started, 'job.started event was emitted')
  assert.equal(started.profile, 'work')
  assert.equal(started.profileStatus, 'selected')

  assert.ok(finished, 'job.finished event was emitted')
  assert.equal(finished.profile, 'work')
  assert.equal(finished.profileStatus, 'selected')
})

test('job.failed event carries resolved profile and profileStatus when job fails', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    throw new Error('spawn crash')
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'test fail events profile',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'backup',
    profileStatus: 'fallback',
    env: { AGENT_HUB_HOME: home },
  })
  await done

  const eventsFile = path.join(home, 'events.jsonl')
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse)
  const failed = lines.find((e) => e.kind === 'job.failed' && e.jobId === job.jobId)

  assert.ok(failed, 'job.failed event was emitted')
  assert.equal(failed.profile, 'backup')
  assert.equal(failed.profileStatus, 'fallback')
})

