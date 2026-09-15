import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { extractLastJsonLine } from '../src/adapters/base.mjs'
import { adapterFor } from '../src/adapters/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-'))
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepoWithSecondaryWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-repo-'))
  const primary = path.join(base, 'primary')
  const secondary = path.join(base, 'secondary')
  fs.mkdirSync(primary)
  git(['init', '-q'], primary)
  git(['config', 'user.email', 'test@test.local'], primary)
  git(['config', 'user.name', 'Test'], primary)
  fs.writeFileSync(path.join(primary, 'a.txt'), 'x')
  git(['add', '-A'], primary)
  git(['commit', '-q', '-m', 'init'], primary)
  git(['worktree', 'add', secondary, '-b', 'wt-branch'], primary)
  return { primary, secondary }
}

/** A fake adapter driving `node -e <script>` instead of a real CLI. */
function fakeAdapter(script) {
  return {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', script],
    parseResult: (stdout) => {
      const json = extractLastJsonLine(stdout)
      if (!json || json.status !== 'SUCCESS') return { ok: false }
      return { ok: true, text: json.response, tokens: json.usage?.total_tokens ?? null, sessionId: json.conversation_id ?? null }
    },
    classifyError: (stdout, exitInfo = {}) => {
      if (exitInfo.timedOut) return { kind: 'timeout', retriable: true, message: 'fake timeout' }
      const json = extractLastJsonLine(stdout)
      if (!json) return { kind: 'crash', retriable: false, message: 'no JSON' }
      if (json.status !== 'SUCCESS') return { kind: 'crash', retriable: false, message: `status=${json.status}` }
      return null
    },
    listModels: () => [],
  }
}

const SUCCESS_SCRIPT = `console.log(JSON.stringify({status:"SUCCESS",response:"PONG",usage:{total_tokens:5},conversation_id:"c1"}))`
const FAIL_SCRIPT = `console.log(JSON.stringify({status:"CANCELED",response:""}))`
const HANG_SCRIPT = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`

/** Import jobrunner + its sibling modules fresh, all pinned to the same AGENT_HUB_HOME. */
async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  const eventlog = await import('../src/eventlog.mjs?t=' + tag)
  return { ...jobrunner, jobstore, eventlog }
}

/** A minimal fake child_process.ChildProcess: closes on the next tick, never spawns anything real. */
function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  process.nextTick(() => child.emit('close', 0, null))
  return child
}

test('a successful read job ends up succeeded, with text/tokens recorded and a job.finished event', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 'Reply exactly: PONG',
    cwd: '/tmp',
    mode: 'read',
    title: 't',
    adapterFor: (a) => adapters[a],
  })
  assert.equal(job.status, 'running')
  await done

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'succeeded')
  assert.equal(finalResult.tokens, 5)
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'PONG')

  const events = eventlog.readTail({ n: 20 })
  const kinds = events.filter((e) => e.jobId === job.jobId).map((e) => e.kind)
  assert.deepEqual(kinds, ['job.queued', 'job.started', 'job.finished'])
})

test('a failing read job (CANCELED) ends up failed with errorKind and a job.failed event', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(FAIL_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a] })
  await done

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'failed')
  assert.equal(finalResult.errorKind, 'crash')

  const events = eventlog.readTail({ n: 20 })
  assert.ok(events.some((e) => e.jobId === job.jobId && e.kind === 'job.failed'))
})

test('a write-mode job in a primary worktree is rejected before spawning anything', async () => {
  const home = tmpHome()
  const { primary } = makeRepoWithSecondaryWorktree()
  const { startJob } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: primary, mode: 'write', adapterFor: (a) => adapters[a] })
  await done

  assert.equal(job.status, 'failed')
  assert.equal(job.errorKind, 'worktree_denied')
})

test('a write-mode job in a secondary worktree is allowed and releases its lock on completion', async () => {
  const home = tmpHome()
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { startJob, jobstore } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const first = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(first.job.status, 'running')
  await first.done
  assert.equal(jobstore.readResult(first.job.jobId).status, 'succeeded')

  // The lock must be released: a second write-mode job to the same cwd succeeds too.
  const second = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  await second.done
  assert.equal(jobstore.readResult(second.job.jobId).status, 'succeeded')
})

test('a second concurrent write-mode job to the same locked cwd is rejected immediately', async () => {
  const home = tmpHome()
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { startJob } = await freshModules(home)
  const adapters = { fake: fakeAdapter(`setTimeout(() => console.log(JSON.stringify({status:"SUCCESS",response:"PONG"})), 300)`) }

  const first = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(first.job.status, 'running')

  const second = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(second.job.status, 'failed')
  assert.equal(second.job.errorKind, 'locked')

  await first.done
})

test('cancelJob kills the process group and marks the job canceled', async () => {
  const home = tmpHome()
  const { startJob, cancelJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(HANG_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', timeoutS: 30, adapterFor: (a) => adapters[a] })
  assert.equal(job.status, 'running')

  await new Promise((r) => setTimeout(r, 200)) // let the child install its SIGTERM handler
  const canceled = await cancelJob(job.jobId)
  assert.equal(canceled.status, 'canceled')
  assert.equal(jobstore.readResult(job.jobId).status, 'canceled')

  const events = eventlog.readTail({ n: 20 })
  assert.ok(events.some((e) => e.jobId === job.jobId && e.kind === 'job.canceled'))

  // Drain the background finishJob chain (it still runs once the SIGKILLed
  // child's own exit event fires) before the next test mutates the shared
  // process.env.AGENT_HUB_HOME — otherwise it reads the wrong AGENT_HUB_HOME.
  await done
})

test('startJob passes {model,prompt,cwd,mode,timeoutS} through the REAL adapterFor into buildArgv for agy and opencode, in both read and write mode', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()
  const captured = []
  const spawn = (cmd, args) => {
    captured.push({ cmd, args })
    return fakeChild()
  }

  const cases = [
    { agent: 'agy', mode: 'read', model: 'gemini-3.8-flash-low', cwd: '/tmp' },
    { agent: 'agy', mode: 'write', model: 'gemini-3.8-flash-low', cwd: secondary },
    { agent: 'opencode', mode: 'read', model: 'opencode/muse-spark-1.3-contributor-free', cwd: '/tmp' },
    { agent: 'opencode', mode: 'write', model: 'deepseek/deepseek-v4-flash', cwd: secondary },
  ]

  for (const c of cases) {
    const { done } = startJob({ agent: c.agent, model: c.model, task: 'hi', cwd: c.cwd, mode: c.mode, adapterFor, spawn })
    await done
  }

  const agyRead = captured.find((c) => c.cmd === 'agy' && c.args.includes('plan'))
  assert.ok(agyRead, 'agy read mode must reach buildArgv as --mode plan')
  const agyWrite = captured.find((c) => c.cmd === 'agy' && c.args.includes('accept-edits'))
  assert.ok(agyWrite, 'agy write mode must reach buildArgv as --mode accept-edits')

  const ocRead = captured.find((c) => c.cmd === 'opencode' && c.args.includes('plan'))
  assert.ok(ocRead, 'opencode read mode must reach buildArgv as --agent plan')
  assert.ok(!ocRead.args.includes('--auto'), 'opencode read mode must never get --auto')

  const ocWrite = captured.find((c) => c.cmd === 'opencode' && c.args.includes('build'))
  assert.ok(ocWrite, 'opencode write mode must reach buildArgv as --agent build')
  assert.ok(ocWrite.args.includes('--auto'), 'opencode write mode must get --auto (regression: jobrunner used to call opencode.buildArgv with {agentMode,write} that jobrunner never sent)')
})

test('startJob hard-kills only after timeoutS + KILL_GRACE_S, giving agy\'s own --print-timeout room to fire and flush first', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const { KILL_GRACE_S } = await import('../src/config.mjs?t=' + Date.now())
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }
  let capturedTimeoutMs = null
  const runWithTimeout = (child, opts) => {
    capturedTimeoutMs = opts.timeoutMs
    return { exitPromise: new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, timedOut: false }))) }
  }

  const { done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 'Reply exactly: PONG',
    cwd: '/tmp',
    mode: 'read',
    timeoutS: 100,
    adapterFor: (a) => adapters[a],
    runWithTimeout,
  })
  await done

  assert.equal(capturedTimeoutMs, (100 + KILL_GRACE_S) * 1000)
})

test('a failed job with partialText/sessionId on its error persists both — response.txt keeps the partial text, sessionId lets job_reply resume the abandoned turn', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const adapterWithPartial = {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', `console.log(JSON.stringify({status:"SUCCESS",response:"",conversation_id:"sess-xyz"}))`],
    parseResult: () => ({ ok: true, text: '' }),
    classifyError: () => ({ kind: 'timeout', retriable: true, message: 'abandoned', partialText: 'partial answer so far', sessionId: 'sess-xyz' }),
    listModels: () => [],
  }
  const adapters = { fake: adapterWithPartial }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a] })
  await done

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'failed')
  assert.equal(finalResult.errorKind, 'timeout')
  assert.equal(finalResult.sessionId, 'sess-xyz')
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'partial answer so far')
})

test('cancelJob never leaves a spurious job.failed event alongside job.canceled (finishJob races the kill)', async () => {
  const home = tmpHome()
  const { startJob, cancelJob, eventlog } = await freshModules(home)
  // Exits almost immediately once SIGTERM lands, so finishJob's own exit
  // handler races cancelJob's status update as tightly as possible.
  const adapters = { fake: fakeAdapter(`process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', timeoutS: 30, adapterFor: (a) => adapters[a] })
  await new Promise((r) => setTimeout(r, 150))
  await cancelJob(job.jobId)
  await done // drain the racing finishJob chain deterministically

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  const kinds = events.map((e) => e.kind)
  assert.ok(kinds.includes('job.canceled'))
  assert.ok(!kinds.includes('job.failed'), `expected no spurious job.failed, got: ${kinds.join(', ')}`)
})
