import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getDb, closeDb, listWorkflowNodes } from '../src/storage/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('C1.1 cross-proceso: 2 schedulers, mismo DB, cada nodo exactamente una vez', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-c11-xproc-'))
  const logFile = path.join(home, 'dispatch.log')
  fs.writeFileSync(logFile, '', 'utf8')
  const childPath = path.join(HERE, 'helpers', 'c11-child.mjs')

  const runChild = () =>
    new Promise((resolve, reject) => {
      const child = fork(childPath, ['wf-c11-xproc'], {
        env: { ...process.env, AGENT_HUB_HOME: home, C11_LOG: logFile },
        stdio: 'inherit',
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('child scheduler timed out'))
      }, 60_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(code)
        else reject(new Error(`child exited with code ${code}`))
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

  await Promise.all([runChild(), runChild()])

  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  // El log guarda "<ts> pid=<pid> <step>"; la última columna es el step.
  const steps = lines.map((l) => l.split(' ').at(-1))
  for (const step of ['n1', 'n2', 'n3']) {
    const count = steps.filter((s) => s === step).length
    if (count !== 1) {
      console.error(`DUPLICATE-DIAG log:\n${lines.join('\n')}`)
    }
    assert.equal(count, 1, `nodo ${step} debe ejecutarse exactamente una vez (visto ${count}x)`)
  }

  const ctx = getDb({ AGENT_HUB_HOME: home })
  const rows = listWorkflowNodes(ctx, 'wf-c11-xproc')
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.equal(row.status, 'succeeded', `nodo ${row.step_id} debe terminar succeeded`)
  }
  closeDb({ AGENT_HUB_HOME: home })
  fs.rmSync(home, { recursive: true, force: true })
})
