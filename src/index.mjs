import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { z } from 'zod'

import { paths } from './config.mjs'
import { reconcileOrphans, listJobs, readResult, responsePath } from './jobstore.mjs'
import { agentsStatusTool, routeTool, knownTaskTypes } from './tools/agents.mjs'
import { delegateTool, jobWaitTool, jobStatusTool, jobResultTool, jobCancelTool, jobReplyTool } from './tools/jobs.mjs'
import { julesDelegateTool, julesSourcesTool, julesCheckTool, julesSessionsTool, julesAccountsTool } from './tools/jules.mjs'
import { resumeRemoteJobs } from './cloud/runner.mjs'
import { metricsTool } from './tools/insights.mjs'
import { learningProposeTool } from './tools/learnings.mjs'
import { scheduleStartupDiscovery } from './startup.mjs'
import {
  TASK_TYPES,
  LEARNING_TEXT_MAX,
  AgentStatusRow,
  RouteResult,
  DelegateResponse,
  JobRecord,
  JobResultResponse,
  MetricsResponse,
  Learning,
  JulesCheckResponse,
  JulesSessionsResponse,
  JulesSourcesResponse,
  JulesAccountsResponse,
} from './schemas.mjs'

const VERSION = '2.1.0'
const TESTED_VERSIONS = { agy: '1.2.1', opencode: '1.18.30', copilot: '1.0.31' }

const log = (...args) => console.error('[agent-hub]', ...args)

// structuredContent must always be a plain object (the MCP outputSchema
// contract requires an object at the top level), so a tool whose "natural"
// payload is a bare array (agents_status) or a subset of shared fields
// (job_reply) gets its own small wrapper schema/shape below instead of
// changing the shared schemas.mjs contracts other consumers (the dashboard)
// rely on.
const AgentsStatusResponse = z.object({ agents: z.array(AgentStatusRow) }).passthrough()
const LearningProposeResponse = z.object({ learning: Learning, note: z.string() }).passthrough()

const ok = (payload, structuredContent) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  ...(structuredContent !== undefined ? { structuredContent } : {}),
})
const fail = (error) => ({
  content: [{ type: 'text', text: `agent-hub error: ${error?.message ?? String(error)}` }],
  isError: true,
})

// `wrap` lets a handler's text payload (kept byte-for-byte backward
// compatible) differ from its structuredContent shape — only agents_status
// (bare array -> {agents}) and learning_propose (already an object) need it;
// every other tool's payload already matches its outputSchema, so `wrap`
// defaults to identity.
const guard = (handler, wrap = (payload) => payload) => async (args) => {
  try {
    const payload = await handler(args ?? {})
    return ok(payload, wrap(payload))
  } catch (error) {
    return fail(error)
  }
}

const agentEnum = z.enum(['agy', 'opencode', 'copilot'])
const modeEnum = z.enum(['read', 'write'])
const jobIdArg = z.string().min(1).describe('A jobId returned by delegate().')
const taskTypeArg = z
  .enum(TASK_TYPES)
  .optional()
  .describe('Pass the same taskType used for route() — it feeds metrics, adaptive timeouts and learnings.')

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
      outputSchema: AgentsStatusResponse,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    guard(
      ({ refresh }) => agentsStatusTool({ refresh: !!refresh, cwd: process.cwd() }),
      (agents) => ({ agents })
    )
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
        includeCatalog: z
          .boolean()
          .optional()
          .describe('Return the full discovered model catalog per CLI instead of a {binPath, version, modelCount, checkedAt, error} summary.'),
      },
      outputSchema: RouteResult,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ taskType, mode, includeCatalog }) => routeTool({ taskType, mode, includeCatalog: !!includeCatalog }))
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
        taskType: taskTypeArg,
      },
      outputSchema: DelegateResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ agent, model, task, cwd, mode, timeoutS, title, variant, taskType }) =>
      delegateTool({ agent, model, task, cwd, mode, timeoutS, title, variant, taskType })
    )
  )

  server.registerTool(
    'job_wait',
    {
      title: 'Wait for a job to finish',
      description: 'Poll a job until it reaches a terminal state or timeoutS (max 60s) elapses.',
      inputSchema: { jobId: jobIdArg, timeoutS: z.number().int().positive().max(60).optional().default(30) },
      outputSchema: JobRecord,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ jobId, timeoutS }) => jobWaitTool({ jobId, timeoutS }))
  )

  server.registerTool(
    'job_status',
    {
      title: 'Read a job status',
      description: 'Current status of one job, without waiting.',
      inputSchema: { jobId: jobIdArg },
      outputSchema: JobRecord,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ jobId }) => jobStatusTool({ jobId }))
  )

  server.registerTool(
    'job_result',
    {
      title: 'Read a job result (head only)',
      description: 'The first maxLines of a finished job\'s response, plus fullPath for the complete text.',
      inputSchema: {
        jobId: jobIdArg,
        maxLines: z.number().int().positive().max(500).optional().default(20),
        tailLines: z.number().int().min(0).max(200).optional().default(10).describe('Extra lines from the end of the response to include alongside the head.'),
      },
      outputSchema: JobResultResponse,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ jobId, maxLines, tailLines }) => jobResultTool({ jobId, maxLines, tailLines }))
  )

  server.registerTool(
    'job_cancel',
    {
      title: 'Cancel a running job',
      description: 'Kill a running job\'s whole process group and mark it canceled.',
      inputSchema: { jobId: jobIdArg },
      outputSchema: JobRecord,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guard(({ jobId }) => jobCancelTool({ jobId }))
  )

  server.registerTool(
    'job_reply',
    {
      title: 'Reply to a finished agy/opencode job, resuming its session',
      description:
        'Start a new turn in a terminal job\'s conversation, using its recorded sessionId. agy (--conversation), opencode (-s) ' +
        'and jules (its remote session) support this; copilot returns {status:"failed", errorKind:"unsupported"} without spawning ' +
        'anything. For a jules job this never starts a new local job: it relays message/action to the existing remote session ' +
        '(a RUNNING jules parent is accepted, not just a terminal one). mode defaults to the parent job\'s mode; switching ' +
        'read -> write goes through the same worktree gate + lock as delegate() (not applicable to jules). ' +
        'A parent that is not yet terminal/running (errorKind:"not_terminal") or has no sessionId (errorKind:"no_session") is also rejected.',
      inputSchema: {
        jobId: jobIdArg,
        message: z.string().min(1).optional().describe('The reply/follow-up prompt text. Required for every agent except a jules approve_plan.'),
        mode: modeEnum.optional(),
        timeoutS: z.number().int().positive().optional(),
        title: z.string().optional(),
        taskType: taskTypeArg,
        action: z
          .enum(['message', 'approve_plan'])
          .optional()
          .describe(
            'jules only: which remote call to make. Defaults to approve_plan when the session is AWAITING_PLAN_APPROVAL and no message was given, otherwise message.'
          ),
      },
      outputSchema: DelegateResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ jobId, message, mode, timeoutS, title, taskType, action }) => jobReplyTool({ jobId, message, mode, timeoutS, title, taskType, action }))
  )

  server.registerTool(
    'jules_delegate',
    {
      title: 'Delegate a task to Jules (Google\'s remote coding agent)',
      description:
        'Start a Jules session. The work runs on GOOGLE\'S OWN SERVERS, not locally — Jules clones the named GitHub source, ' +
        'works in its own sandbox, and the result is a GITHUB PULL REQUEST (or a pushed branch), never a change to this cwd. ' +
        'The Jules API is ALPHA and its shapes may change. Requires JULES_API_KEY in the environment and either cwd (to infer ' +
        'the source/branch from the git remote) or an explicit source. Returns {jobId, status:"queued"} immediately; poll with ' +
        'job_wait/job_status, read with job_result, and use job_reply to send a message or approve a plan. job_cancel on a jules ' +
        'job ONLY stops this server\'s own polling — Jules exposes no cancel endpoint, so the remote session keeps running. ' +
        'The session keeps running even when THIS machine is off, so polling is never the only way to learn the outcome: pick the ' +
        'session up later with jules_check (which reads the Jules API live and finalizes the local job), or jules_sessions first to ' +
        'find a session this machine has no record of.',
      inputSchema: {
        task: z.string().min(1).describe('The prompt/task text.'),
        cwd: z.string().min(1).optional().describe('Local checkout used to infer source/startingBranch from the git remote. Optional if source is given.'),
        source: z.string().min(1).optional().describe('An explicit Jules source name, e.g. "sources/github/acme/widgets" (see jules_sources). Wins over cwd inference.'),
        startingBranch: z.string().min(1).optional().describe('Branch Jules starts from. Defaults to the branch inferred from cwd, if any.'),
        title: z.string().optional(),
        requirePlanApproval: z.boolean().optional().default(false).describe('If true, Jules pauses for approval (job_reply action:"approve_plan") before coding.'),
        automationMode: z.string().optional().default('AUTO_CREATE_PR').describe('Jules automationMode, e.g. AUTO_CREATE_PR.'),
        timeoutS: z.number().int().positive().optional(),
        taskType: taskTypeArg,
        account: z.string().min(1).optional().describe('Jules account id to use (see jules_accounts). Defaults to the configured selection policy; falls back to env.JULES_API_KEY when no accounts exist.'),
      },
      outputSchema: DelegateResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ task, cwd, source, startingBranch, title, requirePlanApproval, automationMode, timeoutS, taskType, account }) =>
      julesDelegateTool({ task, cwd, source, startingBranch, title, requirePlanApproval, automationMode, timeoutS, taskType, account })
    )
  )

  server.registerTool(
    'jules_sources',
    {
      title: 'List GitHub repos connected to the Jules account',
      description:
        'List the GitHub repositories connected to a Jules account. Repos are connected in the Jules web UI (jules.google.com) and ' +
        'cannot be added through this API — use the returned source name with jules_delegate. Pass account to choose a configured ' +
        'account (see jules_accounts); with none configured this reads env.JULES_API_KEY. An account whose /sources call is refused ' +
        'reports noSourceAccess (it has no source access), which is NOT a rejected key.',
      inputSchema: {
        account: z.string().min(1).optional().describe('Jules account id to read (see jules_accounts). Defaults to the highest-priority enabled account, or env.JULES_API_KEY when none are configured.'),
      },
      outputSchema: JulesSourcesResponse,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    guard(({ account }) => julesSourcesTool({ account }))
  )

  server.registerTool(
    'jules_accounts',
    {
      title: 'List configured Jules accounts',
      description:
        'Read-only view of the configured Jules accounts: masked keys (keyPresent/keyLast4, never the raw key), their rolling-24h and ' +
        'concurrent usage, and the last /sources cache status per account. Accounts are created and edited in the dashboard. Use an id ' +
        'from here as jules_delegate/jules_sources account.',
      inputSchema: {},
      outputSchema: JulesAccountsResponse,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(() => julesAccountsTool({}))
  )

  server.registerTool(
    'jules_check',
    {
      title: 'Check a Jules session live',
      description:
        'Ask the Jules API RIGHT NOW what a session did — one getSession plus one activities read, with NO local poller involved. ' +
        'This is the way to learn the outcome after a reboot or days later, when the MCP server and dashboard that started the ' +
        'session are long gone. Pass jobId to read its remote.sessionId, persist the fresh state/PR url/branch and, when the session ' +
        'is terminal while the job is still "running", finalize that job so job_result returns the real answer and the PR link. ' +
        'Pass sessionId alone to inspect a session this machine has no record of. Recovery path for a Jules job whose session ' +
        'finished while the machine was off: jules_sessions to find the session, then jules_check to finalize it locally.',
      inputSchema: {
        jobId: z.string().min(1).optional().describe('Local jobId whose remote.sessionId should be checked and, if terminal, finalized.'),
        sessionId: z.string().min(1).optional().describe('A bare Jules session id, for a session this machine has no local job for.'),
      },
      outputSchema: JulesCheckResponse,
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(({ jobId, sessionId }) => julesCheckTool({ jobId, sessionId }))
  )

  server.registerTool(
    'jules_sessions',
    {
      title: 'List Jules sessions live from the API',
      description:
        'List the account\'s Jules sessions straight from the Jules API, newest first, WITHOUT any local polling or job history — this is ' +
        'how you find out what a session did while the machine was off or after a reboot. Each row carries the session state, PR ' +
        'url and working branch, plus jobId: the local job that started it, or null when this machine has no record (a reinstall, ' +
        'or a session started elsewhere). Recovery path: find the session here, then jules_check to finalize its local job.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().default(20).describe('Maximum number of sessions to return, newest first.'),
        state: z.string().min(1).optional().describe('Only return sessions in this state, e.g. COMPLETED.'),
      },
      outputSchema: JulesSessionsResponse,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    guard(({ limit, state }) => julesSessionsTool({ limit, state }))
  )

  server.registerTool(
    'agents_metrics',
    {
      title: 'Delegation metrics',
      description: 'Success rate, p50/p95 latency, error kinds and tokens per agent/model/mode/taskType from job history.',
      inputSchema: {
        groupBy: z
          .array(z.enum(['agent', 'model', 'mode', 'taskType']))
          .optional()
          .describe('Dimensions to group by. Default: agent, model, mode, taskType.'),
      },
      outputSchema: MetricsResponse,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ groupBy }) => metricsTool({ groupBy }))
  )

  server.registerTool(
    'learning_propose',
    {
      title: 'Propose a learning',
      description:
        'Record a gotcha about an agent/model/task type (e.g. "X hangs on long prompts"). Stored as pending until a human ' +
        'approves it in the dashboard; approved learnings are prepended to future prompts for a matching agent/model/taskType.',
      inputSchema: {
        text: z.string().trim().min(1).max(LEARNING_TEXT_MAX).describe('The gotcha, short and specific.'),
        agent: z.string().min(1).optional().describe("The CLI or Claude subagent tier this learning is about, e.g. 'agy', 'opencode', 'copilot', 'claude'."),
        model: z.string().min(1).optional(),
        taskType: taskTypeArg,
        sourceJobId: jobIdArg.optional(),
      },
      outputSchema: LearningProposeResponse,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    guard(({ text, agent, model, taskType, sourceJobId }) => learningProposeTool({ text, agent, model, taskType, sourceJobId }))
  )

  server.registerResource(
    'agent-hub-job',
    new ResourceTemplate('agent-hub://jobs/{jobId}', {
      list: async () => ({
        resources: listJobs(process.env)
          .slice(0, 20)
          .map((job) => ({
            uri: `agent-hub://jobs/${job.jobId}`,
            name: job.title || job.jobId,
            mimeType: 'application/json',
          })),
      }),
    }),
    { title: 'Job record', description: 'The full job record (result.json) for one job.', mimeType: 'application/json' },
    async (uri, { jobId }) => {
      let record
      try {
        record = readResult(jobId)
      } catch {
        throw new Error('job not found')
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(record, null, 2) }] }
    }
  )

  server.registerResource(
    'agent-hub-job-response',
    new ResourceTemplate('agent-hub://jobs/{jobId}/response', { list: undefined }),
    { title: 'Job response text', description: 'response.txt for one job, or empty string if it has none yet.', mimeType: 'text/plain' },
    async (uri, { jobId }) => {
      try {
        readResult(jobId) // throws when the job does not exist
      } catch {
        throw new Error('job not found')
      }
      let text = ''
      try {
        text = fs.readFileSync(responsePath(jobId), 'utf8')
      } catch {
        // queued/running job, or a job whose CLI never produced response text
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] }
    }
  )

  const promptArgsSchema = {
    goal: z.string().describe('What the orchestrator is trying to accomplish.'),
    cwd: z.string().describe('Absolute working directory / worktree path for the delegated work.'),
    files: z.string().optional().describe('Relevant file(s)/path(s), if already known.'),
  }

  server.registerPrompt(
    'recon',
    {
      title: 'Recon via agent-hub',
      description: 'Delegate a bounded, read-only recon task off Claude quota.',
      argsSchema: promptArgsSchema,
    },
    ({ goal, cwd, files }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\nWorking directory: ${cwd}\n${files ? `Relevant files: ${files}\n` : ''}\n` +
              `Run this recon through agent-hub instead of reading everything yourself:\n` +
              `1) route({taskType:'recon'}) to pick an agent+model.\n` +
              `2) delegate({agent, model, cwd:'${cwd}', mode:'read', taskType:'recon', task:'<bounded question>'}) — ` +
              `pass the SAME taskType ('recon') you gave route(), it feeds metrics, adaptive timeouts and learnings. ` +
              `Shape the task with an explicit output format and a hard line budget, e.g. "List files under src/ ` +
              `that define X. One relative path per line. Max 15 lines."\n` +
              `3) job_wait or job_status({jobId}) until terminal, then job_result({jobId}) for the head of the response.\n` +
              `4) Synthesize what was found; do not restate the raw output.`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    'adversarial-review',
    {
      title: 'Adversarial review via agent-hub',
      description: 'Get a second, independently-hosted opinion in parallel with a third CLI.',
      argsSchema: promptArgsSchema,
    },
    ({ goal, cwd, files }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\nWorking directory: ${cwd}\n${files ? `Relevant files: ${files}\n` : ''}\n` +
              `Run an adversarial review through agent-hub:\n` +
              `1) route({taskType:'adversarial-review'}) — the delegation map's primary for this taskType is agy ` +
              `claude-sonnet-4-6 run in parallel with copilot auto (see the returned chain's parallelWith pair), ` +
              `fallback agy claude-opus-4-6-thinking.\n` +
              `2) delegate({agent, model, cwd:'${cwd}', mode:'read', taskType:'adversarial-review', task:'<the change ` +
              `to review, plus what to check>'}) for BOTH the primary and its parallelWith pair — pass the same ` +
              `taskType ('adversarial-review') to each so metrics/learnings track the pair together. Name the exact ` +
              `output format (numbered findings, file:line evidence) and a line budget in the task text.\n` +
              `3) job_wait/job_status + job_result for each jobId.\n` +
              `4) Synthesize both: flag disagreements explicitly, do not just merge lists silently.`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    'guided-write',
    {
      title: 'Guided write via agent-hub',
      description: 'Plan -> review -> execute -> delivery-review a non-trivial write, using job_reply to stay in one session.',
      argsSchema: promptArgsSchema,
    },
    ({ goal, cwd, files }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\nWorking directory: ${cwd}\n${files ? `Relevant files: ${files}\n` : ''}\n` +
              `Do NOT go straight to a write-mode delegate. Use the guided workflow instead:\n` +
              `1) Plan (read mode): route({taskType:'mechanical-edit'}) then delegate({..., cwd:'${cwd}', mode:'read', ` +
              `taskType:'mechanical-edit', task:'propose a plan for <goal>, do not edit anything'}).\n` +
              `2) Review the plan against the real tree yourself (not just internal consistency). If it needs ` +
              `changes, job_reply({jobId, message:'<numbered feedback>', mode:'read'}) and repeat until it is right.\n` +
              `3) Execute: job_reply({jobId:<last reply's jobId>, message:'execute the approved plan', mode:'write', ` +
              `taskType:'mechanical-edit'}) — the one call allowed to touch the filesystem.\n` +
              `4) Run this project's own required verification commands yourself and read the diff.\n` +
              `5) Delivery review: if anything is off, job_reply({jobId:<execute job's id>, message:'<numbered ` +
              `corrections>', mode:'write'}) in the same conversation, without committing yet. Only stop once it is clean.`,
          },
        },
      ],
    })
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

  // Fire-and-forget: resumeRemoteJobs returns synchronously and never throws,
  // so a slow/unreachable Jules API can never block or crash the handshake.
  try {
    const { resumed, failed } = resumeRemoteJobs()
    if (resumed.length > 0 || failed.length > 0) {
      log(`resumed ${resumed.length} remote job(s) on startup; ${failed.length} could not be resumed`)
    }
  } catch (error) {
    log('resumeRemoteJobs failed:', error?.message ?? error)
  }

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
