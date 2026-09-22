import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { createServer } from '../src/dashboard.mjs'
import { createJob, updateResult } from '../src/jobstore.mjs'
import { DiffStatsResponse } from '../src/schemas.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dashboard-diffstats-'))
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeGitRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dashboard-diffstats-repo-'))
  git(['init', '-q'], cwd)
  git(['config', 'user.email', 'test@test.local'], cwd)
  git(['config', 'user.name', 'Test'], cwd)
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x\n')
  git(['add', '-A'], cwd)
  git(['commit', '-q', '-m', 'init'], cwd)
  return cwd
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: '127.0.0.1' } },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let parsed = null
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode, body: parsed })
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

test('GET /api/jobs/:id/diff-stats returns the persisted snapshot for a terminal job', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { AGENT_HUB_HOME: home }
  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'write', env })
  const diffStats = {
    baseCommit: 'abc123',
    additions: 3,
    deletions: 1,
    filesChanged: 1,
    files: [{ path: 'a.txt', additions: 3, deletions: 1, binary: false }],
    truncated: false,
    computedAt: new Date().toISOString(),
    error: null,
  }
  updateResult(job.jobId, { status: 'succeeded', diffStats }, env)

  const server = createServer({ env })
  const port = await listen(server)
  t.after(() => server.close())

  const res = await request(port, `/api/jobs/${job.jobId}/diff-stats`)
  assert.equal(res.status, 200)
  assert.equal(DiffStatsResponse.safeParse(res.body).success, true)
  assert.deepEqual(res.body.diffStats, diffStats)
})

test('GET /api/jobs/:id/diff-stats computes live stats for a running write-mode job', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const repo = makeGitRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const baseCommit = git(['rev-parse', 'HEAD'], repo).trim()

  const env = { AGENT_HUB_HOME: home }
  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: repo, title: 't', mode: 'write', env })
  updateResult(job.jobId, { status: 'running', diffBase: baseCommit }, env)

  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\nCHANGED\n')

  const server = createServer({ env })
  const port = await listen(server)
  t.after(() => server.close())

  const res = await request(port, `/api/jobs/${job.jobId}/diff-stats`)
  assert.equal(res.status, 200)
  assert.equal(DiffStatsResponse.safeParse(res.body).success, true)
  assert.ok(res.body.diffStats)
  assert.equal(res.body.diffStats.error, null)
  assert.equal(res.body.diffStats.filesChanged, 1)
})

test('GET /api/jobs/:id/diff-stats returns null for a read-mode job', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { AGENT_HUB_HOME: home }
  const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', env })
  updateResult(job.jobId, { status: 'running' }, env)

  const server = createServer({ env })
  const port = await listen(server)
  t.after(() => server.close())

  const res = await request(port, `/api/jobs/${job.jobId}/diff-stats`)
  assert.equal(res.status, 200)
  assert.equal(res.body.diffStats, null)
})

test('GET /api/jobs/:id/diff-stats for an unknown job returns 404', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { AGENT_HUB_HOME: home }
  const server = createServer({ env })
  const port = await listen(server)
  t.after(() => server.close())

  const res = await request(port, '/api/jobs/does-not-exist/diff-stats')
  assert.equal(res.status, 404)
})
