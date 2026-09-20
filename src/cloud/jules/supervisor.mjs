import crypto from 'node:crypto'
import { checkRemoteSession as defaultCheckRemoteSession } from '../check.mjs'
import { interactWithSession as defaultInteractWithSession } from '../../tools/jules.mjs'
import { readResult as defaultReadResult, updateResult as defaultUpdateResult } from '../../jobstore.mjs'
import { listJobs as defaultListJobs } from '../../jobstore.mjs'
import { bestEffortResumeWorkflowNode } from '../../workflow/resume.mjs'
import * as defaultClient from './client.mjs'
import * as defaultAdapter from './adapter.mjs'

// ─── Watch lease & CAS ───────────────────────────────────────────────────────

/**
 * Sentinel error thrown by the atomic updater inside updateJsonLocked when
 * the watch lease is currently held by a different active owner.
 */
export class LeaseConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LeaseConflictError'
  }
}

/**
 * Acquire observation ownership of a remote session via compare-and-swap (CAS)
 * on result.json.
 *
 * Rules:
 * - Inside updateJsonLocked (via updateResultFn):
 *   - If watch belongs to another active owner: throw LeaseConflictError (never write).
 *   - If watch is null or owned by this owner: bump monotonic generation and acquire.
 * - Monotonic generation:
 *   Saved in remote.watchGenerationCounter and NEVER resets to 1 on subsequent acquires,
 *   even after watch is released (watch: null). Each acquire bumps:
 *   generation = max(remote.watchGenerationCounter ?? 0, currentWatch.generation ?? 0) + 1
 * - Owner: UUID per supervisor instance (generated via crypto.randomUUID()), NOT a fixed string.
 *
 * Catches LeaseConflictError and returns { acquired: false, reason }.
 */
export function acquireWatch({
  record,
  owner,
  jobId,
  env = process.env,
  updateResultFn = defaultUpdateResult,
  readResultFn = defaultReadResult,
} = {}) {
  const resolvedOwner = owner ?? crypto.randomUUID()
  let acquiredGeneration = null
  let acquiredWatch = null

  const updater = (current) => {
    const remote = current?.remote ?? {}
    const currentWatch = remote.watch ?? null

    if (currentWatch != null && currentWatch.owner != null && currentWatch.owner !== resolvedOwner) {
      throw new LeaseConflictError(`watch owned by '${currentWatch.owner}' (generation ${currentWatch.generation})`)
    }

    const storedCounter = typeof remote.watchGenerationCounter === 'number'
      ? remote.watchGenerationCounter
      : 0
    const currentGen = typeof currentWatch?.generation === 'number'
      ? currentWatch.generation
      : 0
    const generation = Math.max(storedCounter, currentGen) + 1

    const watch = { owner: resolvedOwner, generation }
    acquiredGeneration = generation
    acquiredWatch = watch

    return {
      ...current,
      remote: {
        ...remote,
        watch,
        watchGenerationCounter: generation,
      },
    }
  }

  try {
    if (jobId && updateResultFn) {
      let executedInside = false
      const wrappedUpdater = (current) => {
        executedInside = true
        return updater(current)
      }
      updateResultFn(jobId, wrappedUpdater, env)
      if (!executedInside) {
        // Fallback for mocks that do not execute functional updaters
        let current = null
        if (readResultFn) {
          try { current = readResultFn(jobId, env) } catch { /* ignore if not on disk */ }
        }
        current = current ?? record ?? {}
        const next = updater(current)
        updateResultFn(jobId, { remote: next.remote }, env)
        if (record && record.remote) {
          record.remote.watch = next.remote.watch
          record.remote.watchGenerationCounter = next.remote.watchGenerationCounter
        }
      }
    } else if (record) {
      const res = updater(record)
      record.remote = {
        ...(record.remote ?? {}),
        watch: res.remote.watch,
        watchGenerationCounter: res.remote.watchGenerationCounter,
      }
    }
    return {
      acquired: true,
      generation: acquiredGeneration,
      watch: acquiredWatch,
      owner: resolvedOwner,
    }
  } catch (err) {
    if (err instanceof LeaseConflictError || err?.name === 'LeaseConflictError') {
      return { acquired: false, reason: err.message }
    }
    throw err
  }
}

/**
 * Release the watch lease.
 * Only succeeds when the caller still owns the EXACT owner and generation.
 * A stale release is a no-op that returns { released: false, reason }.
 * Preserves remote.watchGenerationCounter so generations never reset.
 */
export function releaseWatch({
  record,
  owner,
  generation,
  jobId,
  env = process.env,
  updateResultFn = defaultUpdateResult,
  readResultFn = defaultReadResult,
} = {}) {
  let released = false
  let reason = null

  const updater = (current) => {
    const remote = current?.remote ?? {}
    const currentWatch = remote.watch ?? null

    if (currentWatch?.owner !== owner || currentWatch?.generation !== generation) {
      reason = 'stale generation or different owner'
      return current
    }

    released = true
    return {
      ...current,
      remote: {
        ...remote,
        watch: null,
      },
    }
  }

  if (jobId && updateResultFn) {
    let executedInside = false
    const wrappedUpdater = (current) => {
      executedInside = true
      return updater(current)
    }
    updateResultFn(jobId, wrappedUpdater, env)
    if (!executedInside) {
      let current = null
      if (readResultFn) {
        try { current = readResultFn(jobId, env) } catch { /* ignore if not on disk */ }
      }
      current = current ?? record ?? {}
      updater(current)
      updateResultFn(jobId, { remote: { ...current.remote, watch: null } }, env)
      if (record && record.remote) {
        record.remote.watch = null
      }
    }
  } else if (record) {
    updater(record)
  }

  if (!released) {
    return { released: false, reason: reason ?? 'stale generation or different owner' }
  }
  return { released: true }
}

// ─── Feedback classification (3 levels) ──────────────────────────────────────

/**
 * 3-Level Feedback Classifier for AWAITING_USER_FEEDBACK:
 *
 * 1. REQUEST_USER (10 escalations + budget exhausted):
 *    - secrets: passwords, tokens, API keys, private keys, SSH keys, credentials
 *    - auth: authentication, authorization, login, OAuth, RBAC, SSO, permissions
 *    - architecture: re-architecture, system design, architectural patterns, new layers
 *    - api_changes: breaking API changes, contract alterations, public endpoints
 *    - migrations: database or schema migrations, table alters, column changes
 *    - data: data loss, database wipes, deleting user records, PII
 *    - product: pricing, branding, UX decisions, color palette, product requirements
 *    - code_deletion: deleting features, removing modules/services, dropping functionality
 *    - impactful_dependencies: major dependency additions, framework switches, breaking upgrades
 *    - scope: altering goals/objectives, expanding/reducing scope, out of scope features
 *    - ambiguous_functional: unclear requirements, multi-part questions, open-ended feedback
 *    - budget_exhausted: auto-reply or safe-continue budget reached
 *
 * 2. SAFE_CONTINUE (Conditional operational blocks with explicit conditions):
 *    - obsolete_dependency: deprecated/outdated dependency ONLY if no API/scope change
 *    - foreign_warning: third-party, compiler, or external library warning outside change scope
 *    - preexisting_test_failure: pre-existing failure on unrelated test
 *    - lint_blocks_pipeline: styling/lint/formatting error blocking pipeline execution
 *    - transient_retry: flaky network, 429 rate limit, socket timeout, transient build failure
 *
 * 3. AUTO_REPLY (Strict mechanical allowlist):
 *    - formato: tabs/spaces, indentation, quotes, semicolons, trailing commas
 *    - naming: naming convention, snake_case vs camelCase, already defined name
 *    - test_command: test execution command (npm test, pytest, go test, etc.)
 *    - existing_convention: unambiguous existing codebase convention
 *    - mechanical_detail: import ordering, type annotations, standard mechanical details
 *    - rerun_tests: re-executing/rerunning test suite
 *    - same_pattern: follow same pattern as existing file X
 *
 * Returns { decision, category, confidence, evidence, reason, gate, response }
 */
export function classifyFeedback({
  lastAgentMessage,
  originalTask,
  plan,
  attempts = 0,
  maxAttempts = 2,
  autoReplies,
  maxAutoReplies,
  safeContinues = 0,
  maxSafeContinues = 3,
} = {}) {
  const msg = (lastAgentMessage ?? '').trim()
  const lower = msg.toLowerCase()

  const effectiveAutoReplies = autoReplies ?? attempts ?? 0
  const effectiveMaxAutoReplies = maxAutoReplies ?? maxAttempts ?? 2
  const effectiveSafeContinues = safeContinues ?? 0
  const effectiveMaxSafeContinues = maxSafeContinues ?? 3

  const makeResult = (decision, category, confidence, reason, evidence, response = null) => ({
    decision,
    category,
    gate: decision === 'auto_reply' ? null : category, // mandatory b expects null on auto_reply, category on gates
    confidence,
    reason,
    evidence: evidence ?? reason,
    response,
  })

  // ─── 1. REQUEST_USER: 10 Escalations ─────────────────────────────────────────

  // Secrets & credentials
  const secretMatch = lower.match(/\b(password|secret|credential|api[_-]?key|token|private[_-]?key|ssh[_-]?key|env(?:ironment)?\s*var|oauth|bearer)\b/i)
  if (secretMatch) {
    return makeResult('request_user', 'secrets', 0.99, 'Feedback involves secrets, credentials, or sensitive tokens', secretMatch[0])
  }

  // Auth & permissions
  const authMatch = lower.match(/\b(authenticat(?:e|ion)|authoriz(?:e|ation)|login|signup|sign-in|logout|rbac|sso|permissions?|access\s+control)\b/i)
  if (authMatch) {
    return makeResult('request_user', 'auth', 0.95, 'Feedback involves authentication, authorization, or access control', authMatch[0])
  }

  // Architecture
  const archMatch = lower.match(/\b(re-?architect(?:ure)?|design\s+pattern|architectural\s+(?:pattern|decision|change)|new\s+architectural\s+layer|system\s+design|major\s+refactor(?:ing)?)\b/i)
  if (archMatch) {
    return makeResult('request_user', 'architecture', 0.95, 'Feedback involves architectural changes or design patterns', archMatch[0])
  }

  // API contract changes
  const apiMatch = lower.match(/\b(breaking\s+change|change\s+(?:the\s+)?public\s+api|modify\s+(?:the\s+)?api\s+signature|break(?:ing)?\s+contract|deprecat(?:e|ing)\s+public\s+endpoint|api\s+versioning)\b/i)
  if (apiMatch) {
    return makeResult('request_user', 'api_changes', 0.95, 'Feedback involves breaking API changes or contract alterations', apiMatch[0])
  }

  // Database / Schema migrations
  const migMatch = lower.match(/\b(database\s+migration|db\s+migration|schema\s+migration|alter\s+table|drop\s+column|add\s+column|run\s+migration|flyway|alembic|prisma\s+migrate)\b/i)
  if (migMatch) {
    return makeResult('request_user', 'migrations', 0.95, 'Feedback involves database or schema migrations', migMatch[0])
  }

  // Data loss / PII
  const dataMatch = lower.match(/\b(data\s+loss|drop\s+database|delete\s+records?|user\s+data|pii|customer\s+data|database\s+wipe|truncate\s+table)\b/i)
  if (dataMatch) {
    return makeResult('request_user', 'data', 0.98, 'Feedback involves critical data operations or potential data loss', dataMatch[0])
  }

  // Product / Business decisions
  const bizMatch = lower.match(/\b(pricing|brand|marketing|business|stakeholder|product\s*(?:owner|manager|decision)|ux\s*(?:decision|direction)|color\s*(?:scheme|palette)|user\s*(?:experience|interface)\s*(?:decision|choice))\b/i)
  if (bizMatch) {
    return makeResult('request_user', 'business_decision', 0.95, 'Feedback involves product, business, or UX decisions', bizMatch[0])
  }

  // Code or feature deletion
  const delMatch = lower.match(/\b(delete\s+(?:the\s+)?feature|remove\s+(?:the\s+)?feature|deprecat(?:e|ing)\s+feature|delete\s+(?:the\s+)?entire\s+(?:module|component|service)|drop\s+(?:support\s+for|feature))\b/i)
  if (delMatch) {
    return makeResult('request_user', 'code_deletion', 0.95, 'Feedback involves code or feature deletion', delMatch[0])
  }

  // Impactful dependency changes
  const depMatch = lower.match(/\b(add(?:ing)?\s+(?:a\s+)?(?:new\s+)?.*?(?:heavy|major|core|risky)\s+dependency|replace\s+(?:the\s+)?framework|switch\s+(?:from\s+\w+\s+to|to\s+another\s+framework|framework)|dependency\s+(?:with\s+breaking|upgrade\s+major|with\s+impact)|major\s+version\s+bump)\b/i)
  if (depMatch) {
    return makeResult('request_user', 'impactful_dependencies', 0.92, 'Feedback involves major or impactful dependency changes', depMatch[0])
  }

  // Objectives change
  const objMatch = lower.match(/\b(instead\s+of|different\s+goal|change\s+(?:the\s+)?(?:goal|objective|requirements)|pivot|abandon\s+(?:the\s+)?(?:original|initial))\b/i)
  if (objMatch) {
    return makeResult('request_user', 'objective_change', 0.95, 'Feedback alters original task objectives', objMatch[0])
  }

  // Scope change
  const scopeMatch = lower.match(/\b(should\s+(?:i|we)\s+(?:also|additionally)|(?:expand|reduce|change)\s+(?:the\s+)?scope|add(?:ing)?\s+(?:a\s+)?(?:new|additional|extra)\s+feature|out\s+of\s+scope)\b/i)
  if (scopeMatch) {
    return makeResult('request_user', 'scope_change', 0.95, 'Feedback expands or alters task scope', scopeMatch[0])
  }

  // ─── 2. SAFE_CONTINUE: Conditional operational blocks ───────────────────────

  // Obsolete dependency warning (ONLY if no API/scope change)
  const obsDepMatch = lower.match(/\b(deprecated\s+dependency|obsolete\s+dependency|outdated\s+package|npm\s+warn\s+deprecated|dependency\s+is\s+deprecated|peer\s+dependency\s+warning)\b/i)
  if (obsDepMatch) {
    if (effectiveSafeContinues >= effectiveMaxSafeContinues) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Safe-continue budget exhausted', `safeContinues ${effectiveSafeContinues} >= ${effectiveMaxSafeContinues}`)
    }
    return makeResult(
      'safe_continue',
      'obsolete_dependency',
      0.9,
      'Conditional operational block: obsolete/deprecated dependency without API or scope changes',
      obsDepMatch[0],
      'Safe to continue: proceed with the current dependency without altering public APIs or task scope.'
    )
  }

  // Foreign / third-party / compiler warning
  const foreignWarnMatch = lower.match(/\b(foreign\s+warning|third[_-]?party\s+warning|compiler\s+warning|unrelated\s+warning|external\s+library\s+warning|warning\s+in\s+node_modules)\b/i)
  if (foreignWarnMatch) {
    if (effectiveSafeContinues >= effectiveMaxSafeContinues) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Safe-continue budget exhausted', `safeContinues ${effectiveSafeContinues} >= ${effectiveMaxSafeContinues}`)
    }
    return makeResult(
      'safe_continue',
      'foreign_warning',
      0.9,
      'Conditional operational block: foreign/third-party warning outside modified code scope',
      foreignWarnMatch[0],
      'Safe to continue: the warning originates outside the task scope. Proceed with implementation.'
    )
  }

  // Pre-existing test failure
  const preTestMatch = lower.match(/\b(pre-?existing\s+(?:failing\s+test|test\s+failure)|test\s+already\s+fails?\s+on\s+main|unrelated\s+test\s+fail(?:ing|ure)|test\s+broken\s+before)\b/i)
  if (preTestMatch) {
    if (effectiveSafeContinues >= effectiveMaxSafeContinues) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Safe-continue budget exhausted', `safeContinues ${effectiveSafeContinues} >= ${effectiveMaxSafeContinues}`)
    }
    return makeResult(
      'safe_continue',
      'preexisting_test_failure',
      0.9,
      'Conditional operational block: pre-existing test failure unrelated to current task',
      preTestMatch[0],
      'Safe to continue: focus on the changes for this task and ignore pre-existing unrelated test failures.'
    )
  }

  // Lint / formatting blocking pipeline
  const lintMatch = lower.match(/\b(lint(?:ing)?\s+(?:error|failure|check)|format(?:ting)?\s+blocks?\s+(?:ci|pipeline|build)|eslint\s+blocks?|prettier\s+blocks?|style\s+check\s+fails?)\b/i)
  if (lintMatch) {
    if (effectiveSafeContinues >= effectiveMaxSafeContinues) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Safe-continue budget exhausted', `safeContinues ${effectiveSafeContinues} >= ${effectiveMaxSafeContinues}`)
    }
    return makeResult(
      'safe_continue',
      'lint_blocks_pipeline',
      0.9,
      'Conditional operational block: formatting/lint error blocking pipeline',
      lintMatch[0],
      'Safe to continue: resolve the lint/formatting error to unblock the pipeline without altering runtime behavior.'
    )
  }

  // Transient retry
  const retryMatch = lower.match(/\b(transient\s+(?:error|failure)|flaky\s+test|network\s+timeout|socket\s+hang\s+up|429\s+too\s+many\s+requests|rate\s+limit(?:ed)?|temporary\s+glitch|retry\s+(?:the\s+)?(?:build|command|network))\b/i)
  if (retryMatch) {
    if (effectiveSafeContinues >= effectiveMaxSafeContinues) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Safe-continue budget exhausted', `safeContinues ${effectiveSafeContinues} >= ${effectiveMaxSafeContinues}`)
    }
    return makeResult(
      'safe_continue',
      'transient_retry',
      0.9,
      'Conditional operational block: transient failure suitable for retry',
      retryMatch[0],
      'Safe to continue: this failure appears transient. Please retry the operation.'
    )
  }

  // ─── 3. AUTO_REPLY: Strict mechanical allowlist ─────────────────────────────

  // Question validation: must have exactly 1 question mark
  const questionCount = (msg.match(/\?/g) || []).length
  if (questionCount === 0 || questionCount > 1) {
    return makeResult('request_user', 'ambiguous', 0.8, 'Feedback is ambiguous (not a single concrete question)', msg)
  }

  // Allowlist category 1: formato
  const formatMatch = lower.match(/\b(format(?:ting)?|indent(?:ation)?|tabs?\s+or\s+spaces?|single\s+or\s+double\s+quotes?|trailing\s+commas?|semicolons?|line\s+breaks?)\b/i)
  if (formatMatch) {
    if (effectiveAutoReplies >= effectiveMaxAutoReplies) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Auto-reply budget exhausted', `attempts ${effectiveAutoReplies} >= ${effectiveMaxAutoReplies}`)
    }
    return makeResult('auto_reply', 'formato', 0.95, 'Strict mechanical allowlist: formatting convention', formatMatch[0],
      'Please proceed using the formatting conventions and style established in the repository.')
  }

  // Allowlist category 2: naming ya definido
  const namingMatch = lower.match(/\b(naming\s+convention|snake_case|camelcase|pascalcase|kebab-case|variable\s+names?|function\s+names?|file\s+names?|already\s+defined\s+name)\b/i)
  if (namingMatch) {
    if (effectiveAutoReplies >= effectiveMaxAutoReplies) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Auto-reply budget exhausted', `attempts ${effectiveAutoReplies} >= ${effectiveMaxAutoReplies}`)
    }
    return makeResult('auto_reply', 'naming', 0.95, 'Strict mechanical allowlist: naming convention already defined', namingMatch[0],
      'Please proceed using the existing naming conventions established in the surrounding code.')
  }

  // Allowlist category 3: comando de tests
  const testCmdMatch = lower.match(/\b(test\s+command|command\s+to\s+run\s+tests?|npm\s+test|pytest|go\s+test|how\s+to\s+run\s+(?:the\s+)?tests?|run\s+unit\s+tests?\s+with)\b/i)
  if (testCmdMatch) {
    if (effectiveAutoReplies >= effectiveMaxAutoReplies) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Auto-reply budget exhausted', `attempts ${effectiveAutoReplies} >= ${effectiveMaxAutoReplies}`)
    }
    return makeResult('auto_reply', 'test_command', 0.95, 'Strict mechanical allowlist: test execution command', testCmdMatch[0],
      'Please use the project standard test command (e.g. npm test or equivalent test runner configured in package.json).')
  }

  // Allowlist category 4: convención existente inequívoca
  const convMatch = lower.match(/\b(existing\s+convention|established\s+convention|repo\s+convention|project\s+convention|consistent\s+with\s+(?:the\s+)?codebase)\b/i)
  if (convMatch) {
    if (effectiveAutoReplies >= effectiveMaxAutoReplies) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Auto-reply budget exhausted', `attempts ${effectiveAutoReplies} >= ${effectiveMaxAutoReplies}`)
    }
    return makeResult('auto_reply', 'existing_convention', 0.95, 'Strict mechanical allowlist: unequivocal existing convention', convMatch[0],
      'Please follow the unequivocal existing convention in the repository.')
  }

  // Allowlist category 5: detalle mecánico
  const mechMatch = lower.match(/\b(mechanical\s+detail|import\s+order|export\s+style|type\s+annotation|error\s+message\s+format|standard\s+error\s+handling)\b/i)
  if (mechMatch) {
    if (effectiveAutoReplies >= effectiveMaxAutoReplies) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Auto-reply budget exhausted', `attempts ${effectiveAutoReplies} >= ${effectiveMaxAutoReplies}`)
    }
    return makeResult('auto_reply', 'mechanical_detail', 0.95, 'Strict mechanical allowlist: mechanical detail', mechMatch[0],
      'Please proceed with the standard implementation detail matching the existing codebase pattern.')
  }

  // Allowlist category 6: re-ejecutar tests
  const rerunMatch = lower.match(/\b(re-?run\s+(?:the\s+)?tests?|run\s+(?:the\s+)?tests?\s+again|execute\s+tests?\s+again)\b/i)
  if (rerunMatch) {
    if (effectiveAutoReplies >= effectiveMaxAutoReplies) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Auto-reply budget exhausted', `attempts ${effectiveAutoReplies} >= ${effectiveMaxAutoReplies}`)
    }
    return makeResult('auto_reply', 'rerun_tests', 0.95, 'Strict mechanical allowlist: re-run tests', rerunMatch[0],
      'Please re-run the tests to verify the latest changes.')
  }

  // Allowlist category 7: mismo patrón que archivo X
  const patternMatch = lower.match(/\b(same\s+pattern\s+as\s+(?:file\s+)?\S+|follow\s+(?:the\s+)?pattern\s+(?:of|in)\s+\S+|mirror\s+(?:file\s+)?\S+|match\s+(?:the\s+)?style\s+of\s+\S+)\b/i)
  if (patternMatch) {
    if (effectiveAutoReplies >= effectiveMaxAutoReplies) {
      return makeResult('request_user', 'budget_exhausted', 0.95, 'Auto-reply budget exhausted', `attempts ${effectiveAutoReplies} >= ${effectiveMaxAutoReplies}`)
    }
    return makeResult('auto_reply', 'same_pattern', 0.95, 'Strict mechanical allowlist: same pattern as referenced file', patternMatch[0],
      'Please follow the exact pattern of the referenced file in the codebase.')
  }

  // Fallback if none of the allowlists or conditional categories matched
  return makeResult('request_user', 'ambiguous_functional', 0.85, 'Question does not match strict mechanical allowlist or safe-continue categories', msg)
}

// ─── Supervisor loop ─────────────────────────────────────────────────────────

/**
 * Supervisor loop: observe → decide → interact → resume-observation, owning
 * the watch lease for the entire cycle.
 *
 * Tracks independent budgets:
 * - autoReplyCount / maxAutoReplies (default 2)
 * - safeContinueCount / maxSafeContinues (default 3)
 */
export async function supervise({
  jobId,
  sessionId,
  owner,
  policy: {
    autoApprovePlan = true,
    autoResolveFeedback = true,
    maxAutoReplies = 2,
    maxSafeContinues = 3,
    pauseAfterAmbiguity = true,
  } = {},
  timeoutMs,
  timeoutS = 300,
  intervalMs = 3000,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  checkRemoteSessionFn = defaultCheckRemoteSession,
  interactFn = defaultInteractWithSession,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  listJobsFn = defaultListJobs,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowFn = Date.now,
  classifyFn = classifyFeedback,
} = {}) {
  const resolvedOwner = owner ?? crypto.randomUUID()
  const effectiveTimeoutMs = timeoutMs ?? (timeoutS * 1000)
  const start = nowFn()

  // Resolve job/session
  let resolvedJobId = jobId ?? null
  let resolvedSessionId = sessionId ?? null

  if (jobId) {
    const record = readResultFn(jobId, env)
    resolvedSessionId = sessionId ?? record?.remote?.sessionId ?? null
    if (!resolvedSessionId) throw new Error(`job ${jobId} has no Jules session recorded`)
  } else if (sessionId) {
    let jobs = []
    try { jobs = listJobsFn(env) } catch { /* ignore */ }
    const match = Array.isArray(jobs) ? jobs.find((j) => j?.remote?.sessionId === sessionId) : null
    if (match) resolvedJobId = match.jobId
  }

  if (!resolvedJobId && !resolvedSessionId) {
    throw new Error('jules_supervise requires either jobId or sessionId')
  }

  // Acquire the watch lease via CAS
  let watchGeneration = null
  if (resolvedJobId) {
    const record = readResultFn(resolvedJobId, env)
    const result = acquireWatch({ record, owner: resolvedOwner, updateResultFn, readResultFn, jobId: resolvedJobId, env })
    if (!result.acquired) {
      throw new Error(`cannot acquire watch: ${result.reason}`)
    }
    watchGeneration = result.generation
  }

  let localAutoReplies = 0
  let localSafeContinues = 0
  let localPlanApprovals = 0

  const buildResult = (check, outcome) => {
    let currentRecord = null
    if (resolvedJobId) {
      try {
        currentRecord = readResultFn(resolvedJobId, env)
      } catch { /* ignore */ }
    }
    return {
      jobId: resolvedJobId,
      sessionId: resolvedSessionId,
      state: check.state,
      prUrl: check.prUrl ?? null,
      branch: check.branch ?? null,
      sessionUrl: check.sessionUrl ?? null,
      lastMessage: check.lastMessage ?? null,
      terminal: check.terminal ?? false,
      outcome,
      attentionRequired: check.attentionRequired ?? false,
      attentionReason: check.attentionReason ?? null,
      recommendedAction: check.recommendedAction ?? null,
      autoReplyCount: currentRecord?.remote?.autoReplyCount ?? localAutoReplies,
      safeContinueCount: currentRecord?.remote?.safeContinueCount ?? localSafeContinues,
      planApprovalCount: currentRecord?.remote?.planApprovalCount ?? localPlanApprovals,
    }
  }

  const release = () => {
    if (resolvedJobId && watchGeneration != null) {
      try {
        const record = readResultFn ? readResultFn(resolvedJobId, env) : null
        releaseWatch({ record, owner: resolvedOwner, generation: watchGeneration, updateResultFn, readResultFn, jobId: resolvedJobId, env })
      } catch { /* best-effort */ }
    }
  }

  try {
    while (true) {
      // Check timeout
      if (nowFn() - start >= effectiveTimeoutMs) {
        const check = await checkRemoteSessionFn({ jobId: resolvedJobId, sessionId: resolvedSessionId, env, client, adapter, enrich: true })
        return buildResult(check, 'timeout')
      }

      // Observe
      const check = await checkRemoteSessionFn({
        jobId: resolvedJobId,
        sessionId: resolvedSessionId,
        env,
        client,
        adapter,
        enrich: true,
      })
      const state = check.state

      // Terminal → done
      if (check.terminal || adapter.isTerminalState(state)) {
        return buildResult(check, 'terminal')
      }

      // PAUSED → never auto-resume (no remote resume endpoint exists)
      if (state === 'PAUSED') {
        return buildResult(check, 'paused')
      }

      // AWAITING_PLAN_APPROVAL
      if (state === 'AWAITING_PLAN_APPROVAL') {
        if (autoApprovePlan) {
          // Check for stale generation before writing (execution contract §7)
          if (resolvedJobId && watchGeneration != null) {
            let cur = null
            try { cur = readResultFn(resolvedJobId, env) } catch { /* ignore */ }
            const curWatch = cur?.remote?.watch
            if (curWatch?.owner !== resolvedOwner || curWatch?.generation !== watchGeneration) {
              return buildResult(check, 'attention')
            }
          }

          // Approve the plan — does NOT consume autoReplyCount or safeContinueCount
          await interactFn({
            jobId: resolvedJobId,
            sessionId: resolvedSessionId,
            action: 'approve_plan',
            env,
            client,
            readResultFn,
            updateResultFn,
            listJobsFn,
          })
          localPlanApprovals++
          // C1.2: the session resumed — flip a parked WAITING workflow node
          // back to RUNNING so the wave loop keeps waiting on the same
          // handle. Best-effort: never fails the supervision over this.
          if (resolvedJobId) {
            try { bestEffortResumeWorkflowNode(resolvedJobId, { env }) } catch {}
          }
          await sleepFn(intervalMs)
          continue
        }
        return buildResult(check, 'attention')
      }

      // AWAITING_USER_FEEDBACK
      if (state === 'AWAITING_USER_FEEDBACK') {
        if (!autoResolveFeedback) {
          return buildResult(check, 'attention')
        }

        let currentRecord = null
        if (resolvedJobId) {
          try {
            currentRecord = readResultFn(resolvedJobId, env)
          } catch { /* ignore */ }
        }
        const currentAutoReplies = currentRecord?.remote?.autoReplyCount ?? localAutoReplies
        const currentSafeContinues = currentRecord?.remote?.safeContinueCount ?? localSafeContinues

        // Classify feedback through 3-level classifier
        const classification = classifyFn({
          lastAgentMessage: check.lastMessage,
          originalTask: currentRecord?.task ?? null,
          plan: null,
          attempts: currentAutoReplies,
          maxAttempts: maxAutoReplies,
          autoReplies: currentAutoReplies,
          maxAutoReplies,
          safeContinues: currentSafeContinues,
          maxSafeContinues,
        })

        if (classification.category === 'budget_exhausted') {
          return buildResult(check, 'budget_exhausted')
        }

        if (classification.decision === 'auto_reply') {
          if (currentAutoReplies >= maxAutoReplies) {
            return buildResult(check, 'budget_exhausted')
          }
          // Check for stale generation before writing (execution contract §7)
          if (resolvedJobId && watchGeneration != null) {
            let cur = null
            try { cur = readResultFn(resolvedJobId, env) } catch { /* ignore */ }
            const curWatch = cur?.remote?.watch
            if (curWatch?.owner !== resolvedOwner || curWatch?.generation !== watchGeneration) {
              return buildResult(check, 'attention')
            }
          }

          // Auto-reply — increments autoReplyCount
          await interactFn({
            jobId: resolvedJobId,
            sessionId: resolvedSessionId,
            action: 'reply',
            message: classification.response,
            feedbackDecision: 'auto_reply',
            env,
            client,
            readResultFn,
            updateResultFn,
            listJobsFn,
          })
          localAutoReplies++
          // C1.2: best-effort workflow resume (see approve_plan site above).
          if (resolvedJobId) {
            try { bestEffortResumeWorkflowNode(resolvedJobId, { env }) } catch {}
          }
          await sleepFn(intervalMs)
          continue
        }

        if (classification.decision === 'safe_continue') {
          if (currentSafeContinues >= maxSafeContinues) {
            return buildResult(check, 'budget_exhausted')
          }
          // Check for stale generation before writing (execution contract §7)
          if (resolvedJobId && watchGeneration != null) {
            let cur = null
            try { cur = readResultFn(resolvedJobId, env) } catch { /* ignore */ }
            const curWatch = cur?.remote?.watch
            if (curWatch?.owner !== resolvedOwner || curWatch?.generation !== watchGeneration) {
              return buildResult(check, 'attention')
            }
          }

          // Safe-continue — increments safeContinueCount
          await interactFn({
            jobId: resolvedJobId,
            sessionId: resolvedSessionId,
            action: 'reply',
            message: classification.response,
            feedbackDecision: 'safe_continue',
            env,
            client,
            readResultFn,
            updateResultFn,
            listJobsFn,
          })
          localSafeContinues++
          // C1.2: best-effort workflow resume (see approve_plan site above).
          if (resolvedJobId) {
            try { bestEffortResumeWorkflowNode(resolvedJobId, { env }) } catch {}
          }
          await sleepFn(intervalMs)
          continue
        }

        // REQUEST_USER or gates failed → needs human attention
        if (pauseAfterAmbiguity) {
          return buildResult(check, 'attention')
        }
        await sleepFn(intervalMs)
        continue
      }

      // Still working (IN_PROGRESS, QUEUED, PLANNING) — keep observing
      const elapsed = nowFn() - start
      const remaining = effectiveTimeoutMs - elapsed
      if (remaining <= 0) {
        return buildResult(check, 'timeout')
      }
      await sleepFn(Math.min(intervalMs, remaining))
    }
  } finally {
    release()
  }
}

export async function julesSuperviseTool({
  jobId,
  sessionId,
  owner,
  autoApprovePlan = true,
  autoResolveFeedback = true,
  maxAutoReplies = 2,
  maxSafeContinues = 3,
  pauseAfterAmbiguity = true,
  policy,
  timeoutS = 300,
  pollIntervalS,
  intervalMs,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  checkRemoteSessionFn = defaultCheckRemoteSession,
  interactFn = defaultInteractWithSession,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  listJobsFn = defaultListJobs,
  sleepFn,
  nowFn,
  classifyFn,
} = {}) {
  const effectivePolicy = {
    autoApprovePlan: policy?.autoApprovePlan ?? autoApprovePlan,
    autoResolveFeedback: policy?.autoResolveFeedback ?? autoResolveFeedback,
    maxAutoReplies: policy?.maxAutoReplies ?? maxAutoReplies,
    maxSafeContinues: policy?.maxSafeContinues ?? maxSafeContinues,
    pauseAfterAmbiguity: policy?.pauseAfterAmbiguity ?? pauseAfterAmbiguity,
  }
  return supervise({
    jobId,
    sessionId,
    owner,
    policy: effectivePolicy,
    timeoutS,
    intervalMs: intervalMs ?? (pollIntervalS != null ? pollIntervalS * 1000 : undefined),
    env,
    client,
    adapter,
    checkRemoteSessionFn,
    interactFn,
    readResultFn,
    updateResultFn,
    listJobsFn,
    ...(sleepFn ? { sleepFn } : {}),
    ...(nowFn ? { nowFn } : {}),
    ...(classifyFn ? { classifyFn } : {}),
  })
}

export const jules_supervise = julesSuperviseTool
