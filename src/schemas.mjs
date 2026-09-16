import { z } from 'zod'

/**
 * Shared API contracts. The MCP server uses these for tool outputSchema and
 * tests; the dashboard imports them for compiler-checked types (z.infer).
 *
 * Browser-safe on purpose: import nothing but zod (no node:*, no router.mjs),
 * so Vite can bundle this file. Constants duplicated from server modules
 * (TASK_TYPES, EVENT_KINDS, LEARNING_TEXT_MAX) are pinned by parity tests.
 *
 * Schemas are permissive (.passthrough(), optional/nullable fields): an MCP
 * outputSchema mismatch throws for the whole tool call, so a new server field
 * must never break a response.
 */

export const TASK_TYPES = [
  'recon',
  'call-chain-trace',
  'research',
  'triage',
  'second-opinion',
  'adversarial-review',
  'github-context',
  'mechanical-edit',
  'implementation-with-repo-rules',
  'architecture',
  'structured-mechanical',
]

export const EVENT_KINDS = [
  'preflight',
  'job.queued',
  'job.started',
  'job.finished',
  'job.failed',
  'job.canceled',
  'subagent.start',
  'subagent.stop',
  'proposal.created',
  'proposal.decided',
  'learning.proposed',
  'learning.decided',
]

export const LEARNING_TEXT_MAX = 300

const nullableString = z.string().nullable().optional()
const nullableNumber = z.number().nullable().optional()

export const TaskType = z.enum(TASK_TYPES)
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled'])
export const AgentStatus = z.enum(['ready', 'degraded', 'unavailable', 'skipped'])
export const TimeoutSource = z.enum(['explicit', 'adaptive', 'default'])

/**
 * A remote agent's session tracking block (currently only Jules). Attached to
 * JobRecord as an optional field so a local job's record is byte-for-byte
 * unchanged. Only provider and sessionId are required — everything else is
 * either not known yet (state, prUrl before the first poll) or genuinely
 * optional (accountId — accounts are a later phase).
 */
export const RemoteInfo = z
  .object({
    provider: z.string(),
    accountId: nullableString,
    sessionId: z.string(),
    sessionUrl: nullableString,
    source: nullableString,
    startingBranch: nullableString,
    state: nullableString,
    branch: nullableString,
    prUrl: nullableString,
    activityCursor: nullableString,
    seenActivityIds: z.array(z.string()).optional(),
    lastPolledAt: nullableString,
  })
  .passthrough()

export const JobRecord = z
  .object({
    jobId: z.string(),
    agent: z.string(),
    model: z.string(),
    title: nullableString,
    cwd: z.string(),
    mode: z.string(),
    status: JobStatus,
    errorKind: nullableString,
    error: nullableString,
    timeoutS: nullableNumber,
    variant: nullableString,
    sessionId: nullableString,
    parentJobId: nullableString,
    tokens: nullableNumber,
    costUsd: nullableNumber,
    pid: nullableNumber,
    pgid: nullableNumber,
    createdAt: z.string(),
    updatedAt: z.string(),
    taskType: TaskType.nullable().optional(),
    turnDepth: z.number().int().nonnegative().optional(),
    timeoutSource: TimeoutSource.optional(),
    learningIds: z.array(z.string()).optional(),
    remote: RemoteInfo.optional(),
  })
  .passthrough()

export const AgentStatusRow = z
  .object({
    agent: z.string(),
    model: z.string(),
    status: AgentStatus,
    reason: nullableString,
    ladderLevel: nullableString,
    quotaSignal: nullableString,
    latencyMs: nullableNumber,
    checkedAt: nullableString,
    dataPolicy: nullableString,
    binPath: nullableString,
    cliVersion: nullableString,
  })
  .passthrough()

/** One events.jsonl line. `kind` stays a free string so an unknown kind never breaks a client. */
export const HubEvent = z
  .object({
    ts: z.string(),
    source: z.string(),
    kind: z.string(),
    agent: nullableString,
    model: nullableString,
    title: nullableString,
    summary: nullableString,
    jobId: nullableString,
    cwd: nullableString,
    errorKind: nullableString,
    taskType: nullableString,
    tokens: nullableNumber,
    costUsd: nullableNumber,
  })
  .passthrough()

export const StateResponse = z
  .object({
    agents: z.array(AgentStatusRow),
    jobs: z.array(JobRecord),
    subagents: z.array(HubEvent),
    events: z.array(HubEvent),
  })
  .passthrough()

export const ChainStep = z.lazy(() =>
  z
    .object({
      agent: z.string(),
      model: z.string(),
      mode: z.string().optional(),
      parallelWith: ChainStep.optional(),
    })
    .passthrough()
)

export const DelegationEntry = z.object({ why: z.string(), chain: z.array(ChainStep) }).passthrough()

export const DiscoveryEntry = z
  .object({
    agent: z.string(),
    cmd: nullableString,
    binPath: nullableString,
    version: nullableString,
    models: z.array(z.object({ id: z.string(), label: z.string().optional() }).passthrough()).default([]),
    checkedAt: nullableString,
    error: nullableString,
  })
  .passthrough()

export const BreakerState = z
  .object({
    agent: z.string(),
    model: z.string(),
    open: z.boolean(),
    failureCount: z.number(),
    lastFailureAt: nullableString,
  })
  .passthrough()

export const Override = z
  .object({ hold: z.boolean().optional(), breakerReset: z.string().optional(), reason: z.string().optional(), setAt: z.string().optional() })
  .passthrough()

export const ConfigResponse = z
  .object({
    delegationMap: z.record(DelegationEntry),
    discovery: z.record(DiscoveryEntry),
    timeouts: z.record(z.record(z.number())),
    breaker: z
      .object({
        windowMs: z.number(),
        failureThreshold: z.number(),
        failureKinds: z.array(z.string()),
        immediateKinds: z.array(z.string()),
      })
      .passthrough(),
    ttlMs: z.number(),
    agentHubHome: z.string(),
    writeAllowlist: z.array(z.string()),
    breakerState: z.array(BreakerState),
    // readOverrides() returns {} but a hand-edited file may hold [].
    overrides: z.union([z.record(Override), z.array(z.unknown())]),
    process: z
      .object({
        pid: z.number(),
        nodeVersion: z.string(),
        platform: z.string(),
        pathEntries: z.array(z.string()),
        resolvedBins: z.record(z.string().nullable()),
      })
      .passthrough(),
  })
  .passthrough()

export const MetricsRow = z
  .object({
    agent: z.string(),
    model: z.string(),
    mode: z.string(),
    taskType: TaskType.nullable(),
    samples: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1).nullable(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    errorKinds: z.record(z.number()),
    tokensTotal: z.number(),
    tokensAvg: z.number().nullable(),
  })
  .passthrough()

export const MetricsResponse = z
  .object({ generatedAt: z.string(), groupBy: z.array(z.string()), rows: z.array(MetricsRow) })
  .passthrough()

export const PairRef = z.object({ agent: z.string(), model: z.string() }).passthrough()

export const ProposalStatus = z.enum(['pending', 'accepted', 'rejected', 'superseded'])

export const Proposal = z
  .object({
    id: z.string(),
    taskType: TaskType,
    chainHash: z.string(),
    fromOrder: z.array(PairRef),
    toOrder: z.array(PairRef),
    evidence: z.record(
      z
        .object({
          samples: z.number(),
          successRate: z.number().nullable(),
          wilsonLow: z.number().nullable(),
          wilsonHigh: z.number().nullable().optional(),
          p50Ms: z.number().nullable(),
        })
        .passthrough()
    ),
    reason: z.string(),
    status: ProposalStatus,
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .passthrough()

export const ProposalsFile = z.object({ version: z.literal(1), proposals: z.array(Proposal) }).passthrough()

export const LearningStatus = z.enum(['pending', 'approved', 'rejected'])

export const Learning = z
  .object({
    id: z.string(),
    agent: z.string().nullable(),
    model: z.string().nullable(),
    taskType: TaskType.nullable(),
    text: z.string().min(1).max(LEARNING_TEXT_MAX),
    status: LearningStatus,
    source: z.enum(['mcp', 'dashboard']),
    sourceJobId: z.string().nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .passthrough()

export const LearningsFile = z.object({ version: z.literal(1), learnings: z.array(Learning) }).passthrough()

/** Input for learning_propose (MCP) and the dashboard create form. Always stored as pending. */
export const LearningInput = z.object({
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  taskType: TaskType.optional(),
  text: z.string().trim().min(1).max(LEARNING_TEXT_MAX),
  sourceJobId: z.string().min(1).optional(),
})

export const DiscoverySummary = z
  .object({
    binPath: nullableString,
    version: nullableString,
    modelCount: z.number(),
    checkedAt: nullableString,
    error: nullableString,
  })
  .passthrough()

export const RouteResult = z
  .object({
    primary: ChainStep.nullable(),
    fallbacks: z.array(ChainStep),
    skipped: z.array(z.object({ agent: z.string(), model: z.string(), reason: z.string() }).passthrough()),
    discovery: z.record(z.union([DiscoverySummary, DiscoveryEntry]).nullable()),
    reason: z.string(),
    appliedProposal: z.object({ id: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough()

export const DelegateResponse = z
  .object({
    jobId: z.string().nullable(),
    status: z.string(),
    errorKind: nullableString,
    parentJobId: nullableString,
    turnDepth: z.number().int().nonnegative().optional(),
    warning: nullableString,
  })
  .passthrough()

export const JobResultResponse = z
  .object({
    text: z.string(),
    truncated: z.boolean(),
    tail: z.string().optional(),
    tailTruncated: z.boolean().optional(),
    totalLines: z.number().int().nonnegative().optional(),
    fullPath: z.string(),
    tokens: nullableNumber,
    costUsd: nullableNumber,
    sessionId: nullableString,
    status: z.string(),
    errorKind: nullableString,
  })
  .passthrough()

/** The live answer from jules_check: the session's current state plus what the local job did with it. */
export const JulesCheckResponse = z
  .object({
    jobId: nullableString,
    sessionId: z.string().nullable(),
    state: z.string(),
    prUrl: nullableString,
    branch: nullableString,
    sessionUrl: nullableString,
    lastMessage: nullableString,
    finalized: z.boolean(),
    // True when a remote job wrongly marked failed/orphaned was reopened.
    recovered: z.boolean().optional(),
    terminal: z.boolean(),
  })
  .passthrough()

/** One row from jules_sessions: a live API session annotated with the local jobId that matches it. */
export const JulesSessionRow = z
  .object({
    sessionId: z.string().nullable(),
    title: nullableString,
    state: z.string(),
    prUrl: nullableString,
    branch: nullableString,
    sessionUrl: nullableString,
    createTime: nullableString,
    jobId: nullableString,
  })
  .passthrough()

export const JulesSessionsResponse = z.object({ sessions: z.array(JulesSessionRow) }).passthrough()

/**
 * One row from jules_sources: a GitHub repo connected to the Jules account.
 * `defaultBranch` and `branches` come from githubRepo.defaultBranch.displayName
 * and githubRepo.branches[].displayName — what a caller needs to pick a
 * startingBranch for jules_delegate.
 */
export const JulesSourceRow = z
  .object({
    name: nullableString,
    owner: nullableString,
    repo: nullableString,
    defaultBranch: nullableString,
    branches: z.array(z.string()),
  })
  .passthrough()

export const JulesSourcesResponse = z
  .object({
    sources: z.array(JulesSourceRow),
    // Present only when the read was scoped to a configured account. A
    // noSourceAccess row means /sources refused this account (401) — it is NOT
    // a rejected key, so `note` explains the web-UI connection step.
    accountId: nullableString,
    noSourceAccess: z.boolean().optional(),
    note: nullableString,
  })
  .passthrough()

/** Rolling quota usage for one account, computed from local job history. */
export const JulesAccountUsage = z
  .object({ running: z.number().int().nonnegative(), last24h: z.number().int().nonnegative() })
  .passthrough()

/**
 * A MASKED Jules account: keyPresent/keyLast4 replace the raw apiKey, which
 * never leaves src/accounts.mjs. `usage` and `sourcesStatus` are joined in by
 * jules_accounts from job history and the per-account /sources cache.
 */
export const JulesAccountRow = z
  .object({
    id: z.string(),
    label: nullableString,
    enabled: z.boolean(),
    priority: z.number(),
    dailyLimit: z.number(),
    concurrentLimit: z.number(),
    lastUsedAt: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
    keyPresent: z.boolean(),
    keyLast4: nullableString,
    usage: JulesAccountUsage.optional(),
    sourcesStatus: nullableString,
    sourcesFetchedAt: nullableString,
  })
  .passthrough()

export const JulesAccountsResponse = z
  .object({ policy: z.string(), accounts: z.array(JulesAccountRow) })
  .passthrough()

/**
 * One recurring Jules task (schedules.json). `schedule` is an interval or a
 * daily time; `lastResult` is a compact view of the job the schedule started
 * last time (null when it has never run, or its record was pruned).
 */
export const JulesScheduleResult = z
  .object({
    jobId: z.string(),
    status: z.string(),
    errorKind: nullableString,
    sessionId: nullableString,
    prUrl: nullableString,
  })
  .passthrough()

export const JulesScheduleRow = z
  .object({
    id: z.string(),
    label: nullableString,
    enabled: z.boolean(),
    schedule: z.object({ kind: z.string() }).passthrough(),
    prompt: z.string(),
    source: z.string(),
    startingBranch: nullableString,
    automationMode: nullableString,
    requirePlanApproval: z.boolean(),
    accountId: nullableString,
    lastRunAt: nullableString,
    lastJobId: nullableString,
    lastStatus: nullableString,
    nextRunAt: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
    lastResult: JulesScheduleResult.nullable().optional(),
  })
  .passthrough()

export const JulesSchedulesResponse = z.object({ schedules: z.array(JulesScheduleRow) }).passthrough()
