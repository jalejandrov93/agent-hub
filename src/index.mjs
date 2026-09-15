import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { z } from 'zod'

import { paths } from './config.mjs'
import { reconcileOrphans } from './jobstore.mjs'
import { agentsStatusTool, routeTool, knownTaskTypes } from './tools/agents.mjs'
import { delegateTool, jobWaitTool, jobStatusTool, jobResultTool, jobCancelTool, jobReplyTool } from './tools/jobs.mjs'
import { scheduleStartupDiscovery } from './startup.mjs'

const VERSION = '1.0.0'
const TESTED_VERSIONS = { agy: '1.2.1', opencode: '1.18.30', copilot: '1.0.31' }

const log = (...args) => console.error('[agent-hub]', ...args)

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] })
const fail = (error) => ({
  content: [{ type: 'text', text: `agent-hub error: ${error?.message ?? String(error)}` }],
  isError: true,
})

const guard = (handler) => async (args) => {
  try {
    return ok(await handler(args ?? {}))
  } catch (error) {
    return fail(error)
  }
}

const agentEnum = z.enum(['agy', 'opencode', 'copilot'])
const modeEnum = z.enum(['read', 'write'])
const jobIdArg = z.string().min(1).describe('A jobId returned by delegate().')

export function buildServer() {
  const server = new McpServer({ name: 'agent-hub', version: VERSION })

  server.registerTool(
    'agents_status',
    {
      title: 'Agent CLI health',
      description:
        `Preflight (L0-L2, no ping) every agy/opencode/copilot model in the delegation map. ` +
        `Returns ready|degraded|unavailable with reason, latency, an advisory quota/dataPolicy badge.`,
      inputSchema: { refresh: z.boolean().optional().describe('Bypass the 15-minute cache and re-run the ladder.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(({ refresh }) => agentsStatusTool({ refresh: !!refresh, cwd: process.cwd() }))
  )

  server.registerTool(
    'route',
    {
      title: 'Pick an agent+model for a task type',
      description:
        `Look up the delegation map for one task type and return {primary, fallbacks, reason}, skipping any ` +
        `pair whose cached preflight is unavailable or whose circuit breaker is open. Known task types: ` +
        knownTaskTypes().join(', '),
      inputSchema: {
        taskType: z.enum(knownTaskTypes()),
        mode: modeEnum.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ taskType, mode }) => routeTool({ taskType, mode }))
  )

  server.registerTool(
    'delegate',
    {
      title: 'Delegate a task to an agent CLI',
      description:
        'Start a job on agy/opencode/copilot. Returns {jobId, status:"queued"} immediately; poll with job_wait ' +
        'or job_status. Write mode requires cwd to be a secondary `git worktree add` checkout.',
      inputSchema: {
        agent: agentEnum,
        model: z.string().min(1),
        task: z.string().min(1).describe('The prompt/task text.'),
        cwd: z.string().min(1),
        mode: modeEnum.optional().default('read'),
        timeoutS: z.number().int().positive().optional(),
        title: z.string().optional(),
        variant: z.string().optional().describe('opencode reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ agent, model, task, cwd, mode, timeoutS, title, variant }) => delegateTool({ agent, model, task, cwd, mode, timeoutS, title, variant }))
  )

  server.registerTool(
    'job_wait',
    {
      title: 'Wait for a job to finish',
      description: 'Poll a job until it reaches a terminal state or timeoutS (max 60s) elapses.',
      inputSchema: { jobId: jobIdArg, timeoutS: z.number().int().positive().max(60).optional().default(30) },
      annotations: { readOnlyHint: true },
    },
    guard(({ jobId, timeoutS }) => jobWaitTool({ jobId, timeoutS }))
  )

  server.registerTool(
    'job_status',
    {
      title: 'Read a job status',
      description: 'Current status of one job, without waiting.',
      inputSchema: { jobId: jobIdArg },
      annotations: { readOnlyHint: true },
    },
    guard(({ jobId }) => jobStatusTool({ jobId }))
  )

  server.registerTool(
    'job_result',
    {
      title: 'Read a job result (head only)',
      description: 'The first maxLines of a finished job\'s response, plus fullPath for the complete text.',
      inputSchema: { jobId: jobIdArg, maxLines: z.number().int().positive().max(500).optional().default(20) },
      annotations: { readOnlyHint: true },
    },
    guard(({ jobId, maxLines }) => jobResultTool({ jobId, maxLines }))
  )

  server.registerTool(
    'job_cancel',
    {
      title: 'Cancel a running job',
      description: 'Kill a running job\'s whole process group and mark it canceled.',
      inputSchema: { jobId: jobIdArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guard(({ jobId }) => jobCancelTool({ jobId }))
  )

  server.registerTool(
    'job_reply',
    {
      title: 'Reply to a finished agy/opencode job, resuming its session',
      description:
        'Start a new turn in a terminal job\'s conversation, using its recorded sessionId. Only agy (--conversation) and ' +
        'opencode (-s) support this; copilot returns {status:"failed", errorKind:"unsupported"} without spawning anything. ' +
        'mode defaults to the parent job\'s mode; switching read -> write goes through the same worktree gate + lock as delegate(). ' +
        'A parent that is not yet terminal (errorKind:"not_terminal") or has no sessionId (errorKind:"no_session") is also rejected.',
      inputSchema: {
        jobId: jobIdArg,
        message: z.string().min(1).describe('The reply/follow-up prompt text.'),
        mode: modeEnum.optional(),
        timeoutS: z.number().int().positive().optional(),
        title: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ jobId, message, mode, timeoutS, title }) => jobReplyTool({ jobId, message, mode, timeoutS, title }))
  )

  return server
}

function checkCliVersion(name, cmd) {
  try {
    const out = execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
    const tested = TESTED_VERSIONS[name]
    const match = out.includes(tested)
    console.log(`${name.padEnd(10)}: ${out}${match ? '' : `  (WARN: tested against ${tested})`}`)
  } catch (error) {
    console.log(`${name.padEnd(10)}: NOT FOUND (${error.message?.split('\n')[0] ?? error})`)
  }
}

async function selftest() {
  console.log(`agent-hub      : ${VERSION}`)
  console.log(`node           : ${process.version}`)

  const p = paths()
  console.log(`state dir      : ${p.home}`)
  fs.mkdirSync(p.home, { recursive: true })
  const probe = `${p.home}/.selftest-write-probe`
  fs.writeFileSync(probe, 'ok')
  fs.rmSync(probe)
  console.log('state dir write: OK')

  checkCliVersion('agy', 'agy')
  checkCliVersion('opencode', 'opencode')
  checkCliVersion('copilot', 'copilot')

  console.log('\nSelftest passed.')
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log('agent-hub — MCP server delegating tasks to agy/opencode/copilot.\n\n  --selftest   verify environment and CLI versions\n  --version    print version')
    return
  }
  if (args.includes('--version')) {
    console.log(VERSION)
    return
  }
  if (args.includes('--selftest')) {
    await selftest()
    return
  }

  const changed = reconcileOrphans()
  if (changed.length > 0) log(`reconciled ${changed.length} orphaned job(s) on startup: ${changed.join(', ')}`)

  // Fire-and-forget: never awaited, so a slow/missing CLI never delays the
  // stdio handshake below. See src/startup.mjs for the non-blocking wiring.
  scheduleStartupDiscovery()

  const server = buildServer()
  await server.connect(new StdioServerTransport())
  log(`ready — state dir ${paths().home}`)
}

main().catch((error) => {
  log('fatal:', error?.message ?? error)
  process.exitCode = 1
})
