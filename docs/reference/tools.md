# MCP tools reference

## MCP tools

| Tool | Input | Notes |
|---|---|---|
| `agent_send_message` | `{to, text, kind?, rootExecutionId?, from?, workflowId?}` | Send an inter-agent message to a peer mailbox, scoped to a root execution. Honest ACK semantics (message deposited into envelope; never implies read/acted). Point-to-point only (no broadcast); 4KB text cap; 10 unread messages mailbox cap. |
| `agent_inbox` | `{to?, rootExecutionId?, unreadOnly?}` | Read messages from the agent mailbox, oldest first, and mark returned messages delivered. |
| `agent_ack` | `{messageId}` | Acknowledge receipt of an agent message into the context envelope. |
| `agent_peers` | `{rootExecutionId}` | List active peers participating in a root execution, including their messaging capabilities (`messagingTurnBoundary`, `messagingMidRun`). |
| `agents_quota` | `{refresh?: boolean}` | Each delegation pair's quota state, read from a local [CodexBar](../quota.md) server: every applicable window with used percent and reset time, `exhausted`, and a reason when CodexBar is unreachable or the pair is not metered. **Information only** — see [Quota state before delegating](../routing.md#quota-state-before-delegating). |
| `agents_status` | `{refresh?: boolean}` | L0-L2 for every pair in the delegation map. Never pings. Rows include `binPath`/`cliVersion` from `discovery.json`. |
| `route` | `{taskType: enum, mode?: 'read'\|'write', includeCatalog?: boolean, requirements?: string[], preferences?: {quality?, cost?, latency?}, adaptive?: boolean}` | Skips unavailable/breaker-open/held pairs; filters by hard `requirements` capabilities; ranks candidates using preference weights; reorders primary/fallbacks when `adaptive: true`; returns `{primary, fallbacks, skipped, discovery, reason, appliedProposal, ranking}`. `appliedProposal` names the accepted proposal whose order was applied, or `null`. |
| `delegate` | `{agent, model, task, cwd, mode?, timeoutS?, title?, variant?, taskType?}` | **Raw escape hatch — prefer `dispatch`** unless you must pin one exact agent+model: this path skips routing, policy recovery, circuit breakers, `dispatchKey` idempotency and lineage, and it is synchronous (it returns the job record, it does not wait). `variant` is opencode's reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot. For opencode this is folded into the model ID (`<model>#<variant>`). Pass the same `taskType` given to `route` so metrics, adaptive timeouts, and learnings apply. |
| `dispatch` | `{task, cwd, taskType?, mode?, workflowStep?, dispatchKey?, attempt?, parentExecutionId?, rootExecutionId?, timeoutS?, waitMode?, harness?}` | Execution WITH policy, idempotency, and lineage: revalidates preflight/breaker at execution time, applies per-class recovery policies, deduplicates by `dispatchKey` (concurrent same-key dispatches share one job), reserves write lock lease, and defaults `waitMode` (`none`\|`attention`\|`terminal`) from the caller harness profile. |
| `job_wait` | `{jobId, timeoutS?<=60}` | Polls until terminal (`done`, `waiting:false`), until a remote session waits for interaction (`done` + `waiting:true` with attention fields — act via `jules_interact`, no timeout burned), or until the local budget elapses (`done:false`, `timedOut:true`; job/session keep running). |
| `job_status` | `{jobId}` | Current status, no waiting. |
| `job_result` | `{jobId, maxLines?, tailLines?}` | Head of the response (default 20 lines) plus extra `tailLines` from the end (default 10, never repeating a head line) and `fullPath`, `truncated`, `tailTruncated`. |
| `job_cancel` | `{jobId}` | Kills the whole process group; marks `canceled`. |
| `job_reply` | `{jobId, message?, mode?, timeoutS?, title?, taskType?, action?}` | Starts a new turn in a **terminal** agy/opencode job's conversation, using its recorded `sessionId`. `mode` and `taskType` default to parent job's; switching to `write` goes through worktree gate + lock. Relays to active Jules sessions via `action` (`message`\|`approve_plan`). Copilot unsupported. Delivers pending mailbox messages across turn boundaries. |
| `agents_metrics` | `{groupBy?: ('agent'\|'model'\|'mode'\|'taskType')[]}` | Success rate, p50/p95 latency, error kinds, tokens, cost (`costUsdTotal`/`costUsdAvg`), verification rate, judge verdicts histogram, revision count, and quality score from job history. |
| `execution_graph` | `{rootExecutionId?: string}` | Read-only execution lineage DAG: roots, nodes (`id`, `agent`, `model`, `status`, `workflow_id`, `step_id`, `attempt`, `parent`, `root`), and edges (`delegate`, `retry`, `resume`). Pass `rootExecutionId` to return a directed subtree. |
| `plan_task` | `{plan?, intent?, maxSteps?}` | Validates a `WorkflowPlan` (`goal` + role-bound `steps`) and materializes it into a runnable workflow without executing anything. Pass explicit `plan` (caller plans) or `intent` (when a planner is configured). Returns `{ ok, plan, workflow }` or validation errors. |
| `execute_plan` | `{plan, approve: true}` | Validates, materializes, and runs a plan via `runWorkflow`. **Approval gate**: strictly requires `approve: true` confirming the plan was reviewed; fails closed otherwise. |
| `jules_delegate` | `{task, cwd?, source?, startingBranch?, title?, requirePlanApproval?, automationMode?, account?, timeoutS?, taskType?}` | Starts a Jules cloud session on Google's servers against a connected GitHub repo. Returns `{jobId, status:'queued'}`; the result is a GitHub pull request. |
| `jules_sources` | `{account?}` | The GitHub repos connected to the Jules account. Connect new ones in the Jules web UI. |
| `jules_accounts` | `{}` | Configured Jules accounts, read-only: masked keys, rolling 24-hour and concurrent usage, and sources cache status. |
| `jules_schedules` | `{}` | Recurring Jules tasks, read-only, with next run and last result. Schedules run in the dashboard service. |
| `jules_check` | `{jobId?, sessionId?}` | One live read of a session without poller: `state`, `prUrl`, `branch`, `sessionUrl`, attention fields. Finalizes a local job whose remote session finished while the machine was off. |
| `jules_interact` | `{jobId?, sessionId?, action: 'reply'\|'approve_plan', message?}` | Talk to a live Jules session: `reply` (needs `message`) or `approve_plan`. Interacting does not restart background polling — observe outcome via `jules_wait` or `jules_check`. |
| `jules_wait` | `{jobId?, sessionId?, timeoutS?<=600, pollIntervalS?}` | Local orchestration wait until terminal or waiting state (`AWAITING_*`/`PAUSED`). Remote session unaffected on timeout. |
| `jules_sessions` | `{limit?, state?, account?}` | Lists sessions directly from the Jules API, newest first, with local `jobId` linkage when present. Recovery path when local records are missing. |
| `jules_supervise` | `{jobId?, sessionId?, autoApprovePlan? (=true), autoResolveFeedback?, maxAutoReplies? (=2), maxSafeContinues? (=3), pauseAfterAmbiguity?, timeoutS?, pollIntervalS?}` | Supervised autonomy loop: acquires watcher lease, continuously observes, auto-approves plans, and auto-replies to unambiguous feedback under strict mechanical allowlists. |
| `learning_propose` | `{text, agent?, model?, taskType?, sourceJobId?}` | Records a gotcha as **pending**; a human must approve it in the dashboard before it is injected into a matching prompt. Returns `{learning, note}`. |

Every tool also declares a zod `outputSchema` and returns the same payload as
`structuredContent` for clients that want typed output (the text content stays
JSON for compatibility).

### Resources

| URI | Contents |
|---|---|
| `agent-hub://jobs/{jobId}` | A job's full `result.json` record (the template also lists the 20 most recent jobs) |
| `agent-hub://jobs/{jobId}/response` | A job's `response.txt` as plain text, or empty until the CLI produces text |

### Prompts

| Prompt | Args | Purpose |
|---|---|---|
| `recon` | `{goal, cwd, files?}` | Delegate a bounded, read-only recon task off Claude quota |
| `adversarial-review` | `{goal, cwd, files?}` | Get a second, independently-hosted opinion in parallel with a third CLI |
| `guided-write` | `{goal, cwd, files?}` | Plan → review → execute → delivery-review a non-trivial write, staying in one session via `job_reply` |

