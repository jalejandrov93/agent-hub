import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { dispatch, createExecutionHandle } from '../src/dispatch.mjs'

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-agys-test-'))
  const env = { ...process.env, AGENT_HUB_HOME: home }
  delete env.AGENT_HUB_AGYS
  delete env.AGENT_HUB_AGYS_PROFILE
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

function fakeRoute(candidate = { agent: 'agy', model: 'gemini-3.8-flash' }, fallbacks = []) {
  return {
    routeFn: async () => ({ primary: candidate, fallbacks }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  }
}

test('agy + injected resolveProfileFn returning { profile: "work", status: "selected" } -> startJobFn receives profile and profileStatus', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-1', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    await dispatch({
      task: 'test-agy-profile',
      taskType: 'recon',
      cwd: '/tmp/test-agy',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.equal(resolveCalls, 1)
    assert.ok(capturedArgs, 'startJobFn was called')
    assert.equal(capturedArgs.profile, 'work')
    assert.equal(capturedArgs.profileStatus, 'selected')
  } finally {
    cleanup()
  }
})

test('non-agy candidate (e.g. opencode) -> resolveProfileFn is NEVER called and captured profile is null', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-2', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    await dispatch({
      task: 'test-non-agy',
      taskType: 'recon',
      cwd: '/tmp/test-non-agy',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'opencode', model: 'opencode/muse-spark' }),
    })

    assert.equal(resolveCalls, 0, 'resolveProfileFn must never be called for non-agy candidate')
    assert.ok(capturedArgs, 'startJobFn was called')
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)
  } finally {
    cleanup()
  }
})

test('default resolveProfileFn with env AGENT_HUB_AGYS=off -> captured profile/profileStatus are null', async () => {
  const { env, cleanup } = makeTempHome()
  env.AGENT_HUB_AGYS = 'off'
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-3', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    await dispatch({
      task: 'test-default-agys',
      taskType: 'recon',
      cwd: '/tmp/test-default-agys',
      env,
      startJobFn: mockStartJob,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.ok(capturedArgs, 'startJobFn was called')
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)
  } finally {
    cleanup()
  }
})

test('the memo: dispatch retry re-running agy candidate calls resolveProfileFn at most once', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    const capturedList = []
    const mockStartJob = async (args) => {
      capturedList.push(args)
      if (capturedList.length === 1) {
        return {
          job: {
            jobId: 'j-retry-1',
            agent: args.agent,
            model: args.model,
            status: 'failed',
            errorKind: 'network',
            error: 'Connection reset',
          },
          done: Promise.resolve(),
        }
      }
      return {
        job: {
          jobId: 'j-retry-2',
          agent: args.agent,
          model: args.model,
          status: 'queued',
        },
        done: Promise.resolve(),
      }
    }

    await dispatch({
      task: 'test-memo-retry',
      taskType: 'recon',
      cwd: '/tmp/test-memo-retry',
      category: 'crash',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.equal(capturedList.length, 2, 'startJobFn called twice across retry')
    assert.equal(resolveCalls, 1, 'resolveProfileFn must be called at most once across retries for the same agent')
    assert.equal(capturedList[0].profile, 'work')
    assert.equal(capturedList[0].profileStatus, 'selected')
    assert.equal(capturedList[1].profile, 'work')
    assert.equal(capturedList[1].profileStatus, 'selected')
  } finally {
    cleanup()
  }
})

test('the memo: dispatch fallback re-running agy candidate calls resolveProfileFn at most once', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    const capturedList = []
    const mockStartJob = async (args) => {
      capturedList.push(args)
      if (capturedList.length === 1) {
        return {
          job: {
            jobId: 'j-fallback-1',
            agent: args.agent,
            model: args.model,
            status: 'failed',
            errorKind: 'quota',
            error: 'Rate limit exceeded',
          },
          done: Promise.resolve(),
        }
      }
      return {
        job: {
          jobId: 'j-fallback-2',
          agent: args.agent,
          model: args.model,
          status: 'queued',
        },
        done: Promise.resolve(),
      }
    }

    await dispatch({
      task: 'test-memo-fallback',
      taskType: 'recon',
      cwd: '/tmp/test-memo-fallback',
      category: 'quality',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute(
        { agent: 'agy', model: 'gemini-3.8-flash' },
        [{ agent: 'agy', model: 'gemini-2.5-flash' }]
      ),
    })

    assert.equal(capturedList.length, 2, 'startJobFn called twice across fallback')
    assert.equal(resolveCalls, 1, 'resolveProfileFn must be called at most once across fallbacks for the same agent')
    assert.equal(capturedList[0].profile, 'work')
    assert.equal(capturedList[0].profileStatus, 'selected')
    assert.equal(capturedList[1].profile, 'work')
    assert.equal(capturedList[1].profileStatus, 'selected')
  } finally {
    cleanup()
  }
})

test('error or malformed resolveProfileFn result falls back to nulls without throwing', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-err', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    // Throwing resolver
    await dispatch({
      task: 'test-throwing-resolver',
      taskType: 'recon',
      cwd: '/tmp/test-throwing',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: async () => {
        throw new Error('agys CLI crashed')
      },
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.ok(capturedArgs)
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)

    // Malformed resolver returning invalid shape
    capturedArgs = null
    await dispatch({
      task: 'test-malformed-resolver',
      taskType: 'recon',
      cwd: '/tmp/test-malformed',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: async () => 'unexpected string',
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.ok(capturedArgs)
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)
  } finally {
    cleanup()
  }
})

test('createExecutionHandle returns profile from job or null when absent', () => {
  const handleWithProfile = createExecutionHandle({ job: { jobId: 'j1', profile: 'work' } })
  assert.equal(handleWithProfile.profile, 'work')

  const handleWithoutProfile = createExecutionHandle({ job: { jobId: 'j1' } })
  assert.equal(handleWithoutProfile.profile, null)

  const handleNoJob = createExecutionHandle()
  assert.equal(handleNoJob.profile, null)
})
