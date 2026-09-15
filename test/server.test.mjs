import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')

async function connect() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-server-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    // Startup discovery (src/startup.mjs) spawns real agy/opencode/copilot
    // processes in the background once the server boots for real; this
    // suite must never do that, so every spawned server disables it.
    env: { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_DISABLE_STARTUP_DISCOVERY: '1' },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

test('the server boots over stdio and exposes the full tool set', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['agents_status', 'delegate', 'job_cancel', 'job_reply', 'job_result', 'job_status', 'job_wait', 'route']
    )
  } finally {
    await close()
  }
})

test('listTools() resolves quickly — startup discovery (background CLI spawns) never blocks the stdio handshake', async () => {
  const { client, close } = await connect()
  try {
    const startedAt = Date.now()
    await client.listTools()
    assert.ok(Date.now() - startedAt < 2000, 'the handshake + first tool call should never wait on CLI discovery')
  } finally {
    await close()
  }
})

test('delegate requires agent, model, task and cwd', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const delegateTool = tools.find((t) => t.name === 'delegate')
    const required = delegateTool.inputSchema.required ?? []
    for (const field of ['agent', 'model', 'task', 'cwd']) {
      assert.ok(required.includes(field), `delegate.inputSchema should require "${field}"`)
    }
  } finally {
    await close()
  }
})

test('route only accepts known task types', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const routeTool = tools.find((t) => t.name === 'route')
    const taskTypeSchema = routeTool.inputSchema.properties.taskType
    assert.ok(Array.isArray(taskTypeSchema.enum) && taskTypeSchema.enum.length > 0)
  } finally {
    await close()
  }
})

test('job_reply requires jobId and message', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const jobReply = tools.find((t) => t.name === 'job_reply')
    const required = jobReply.inputSchema.required ?? []
    for (const field of ['jobId', 'message']) {
      assert.ok(required.includes(field), `job_reply.inputSchema should require "${field}"`)
    }
  } finally {
    await close()
  }
})

test('job_cancel is marked destructive', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const jobCancel = tools.find((t) => t.name === 'job_cancel')
    assert.equal(jobCancel.annotations?.destructiveHint, true)
  } finally {
    await close()
  }
})
