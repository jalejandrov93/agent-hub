import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  initDb,
  reserveDispatchKey,
  getDispatchReservation,
  releaseDispatchReservation,
  resetDbInstances,
} from '../src/storage/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-reservation-'))
}

afterEach(() => {
  resetDbInstances()
})

function sqliteCtx() {
  const ctx = initDb(tmpHome())
  assert.equal(ctx.backend, 'sqlite')
  return ctx
}

function jsonCtx() {
  return { backend: 'json', stateHome: tmpHome() }
}

const backends = [
  ['sqlite', sqliteCtx],
  ['json fallback', jsonCtx],
]

for (const [label, makeCtx] of backends) {
  test(`reserveDispatchKey (${label}): a fresh key is reserved and a duplicate is rejected with the first job`, () => {
    const ctx = makeCtx()

    const first = reserveDispatchKey(ctx, { dispatchKey: 'dk-1', jobId: 'job-a' })
    assert.equal(first.reserved, true)
    assert.equal(first.existingJobId, null)

    const second = reserveDispatchKey(ctx, { dispatchKey: 'dk-1', jobId: 'job-b' })
    assert.equal(second.reserved, false)
    assert.equal(second.existingJobId, 'job-a')
    assert.ok(second.existingCreatedAt)

    // the loser must not have overwritten the winner
    const row = getDispatchReservation(ctx, 'dk-1')
    assert.equal(row.job_id, 'job-a')
  })

  test(`getDispatchReservation / releaseDispatchReservation (${label}): row disappears after release and the key can be reserved again`, () => {
    const ctx = makeCtx()

    const reserved = reserveDispatchKey(ctx, { dispatchKey: 'dk-2', jobId: 'job-c' })
    assert.equal(reserved.reserved, true)

    const row = getDispatchReservation(ctx, 'dk-2')
    assert.equal(row.dispatch_key, 'dk-2')
    assert.equal(row.job_id, 'job-c')

    assert.equal(releaseDispatchReservation(ctx, 'dk-2'), true)

    assert.equal(getDispatchReservation(ctx, 'dk-2'), null)
    assert.equal(releaseDispatchReservation(ctx, 'dk-2'), false)

    const again = reserveDispatchKey(ctx, { dispatchKey: 'dk-2', jobId: 'job-d' })
    assert.equal(again.reserved, true)
    assert.equal(getDispatchReservation(ctx, 'dk-2').job_id, 'job-d')
  })

  test(`releaseDispatchReservation (${label}): T2 conditional release with the wrong observed jobId keeps the row`, () => {
    const ctx = makeCtx()

    reserveDispatchKey(ctx, { dispatchKey: 'dk-cas', jobId: 'job-new-holder' })

    // A dispatcher that observed a STALE holder (job-old-holder) must not
    // delete the reservation once someone else has already taken it over.
    const released = releaseDispatchReservation(ctx, 'dk-cas', 'job-old-holder')
    assert.equal(released, false, "a conditional release with the wrong jobId must not delete the row")

    const row = getDispatchReservation(ctx, 'dk-cas')
    assert.ok(row, 'the new holder reservation must survive')
    assert.equal(row.job_id, 'job-new-holder')
  })

  test(`releaseDispatchReservation (${label}): T2 conditional release with the matching observed jobId deletes the row`, () => {
    const ctx = makeCtx()

    reserveDispatchKey(ctx, { dispatchKey: 'dk-cas-2', jobId: 'job-stale-holder' })

    const released = releaseDispatchReservation(ctx, 'dk-cas-2', 'job-stale-holder')
    assert.equal(released, true, "a conditional release with the matching jobId must delete the row")
    assert.equal(getDispatchReservation(ctx, 'dk-cas-2'), null)
  })

  test(`reserveDispatchKey (${label}): a key is reserved even without a jobId`, () => {
    const ctx = makeCtx()

    const reserved = reserveDispatchKey(ctx, { dispatchKey: 'dk-3' })
    assert.equal(reserved.reserved, true)

    const row = getDispatchReservation(ctx, 'dk-3')
    assert.equal(row.job_id, null)
    assert.ok(row.created_at)

    const dup = reserveDispatchKey(ctx, { dispatchKey: 'dk-3', jobId: 'job-e' })
    assert.equal(dup.reserved, false)
    assert.equal(dup.existingJobId, null)
  })
}

test('reserveDispatchKey: distinct keys are independent', () => {
  const ctx = sqliteCtx()

  assert.equal(reserveDispatchKey(ctx, { dispatchKey: 'a', jobId: 'job-1' }).reserved, true)
  assert.equal(reserveDispatchKey(ctx, { dispatchKey: 'b', jobId: 'job-2' }).reserved, true)
  assert.equal(getDispatchReservation(ctx, 'a').job_id, 'job-1')
  assert.equal(getDispatchReservation(ctx, 'b').job_id, 'job-2')

  releaseDispatchReservation(ctx, 'a')
  assert.equal(getDispatchReservation(ctx, 'a'), null)
  assert.equal(getDispatchReservation(ctx, 'b').job_id, 'job-2')
})
