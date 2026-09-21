# Workflows

## Workflow DAG

`runWorkflow({workflow, ctx})` executes delegate/fanout/fanin/notify nodes in
parallel waves (`Promise.all` per wave), persisting every transition
(`pending → ready → running → succeeded | failed | skipped | canceled`) to
SQLite so `runWorkflow({workflowId})` resumes after a restart without
re-running `succeeded` nodes. Dependencies resolve via `dependsOn` +
`condition` (safe expression over sibling results) with `onFailure` skip
propagation by default; `fanout` fans N children with distinct `dispatchKey`s
and `fanin` aggregates them. Per-node `maxAttempts` (backoff) and `timeoutS`;
concurrent schedulers can't double-claim a node (`claimed_by` CAS in
`claimWorkflowNode`). No quality/cost/adaptive scoring yet — nodes carry
`onSuccess`/`onFailure` hooks for the future judge (C4). Example:
`examples/software-pipeline.mjs` (research → implementation → review).

## Execution hardening

- `dispatch()` also returns an `ExecutionHandle {jobId, sessionId, abort()}`;
  the engine awaits real completion via `waitExecution()` — a node succeeds
  only on terminal job state, never on dispatch return. Timeout aborts first
  (`cancelJob` locally, stop-wait remotely), then retries.
- Nodes understand `waiting` (`user_feedback|plan_approval|external_event`):
  `running→waiting→running→succeeded`, resumed without duplicating execution.
- Conditions and fan-out `items` use a small safe DSL (`==,!=,===,!==,AND,
  OR,NOT,exists` over `steps.*`) — no `new Function`/`eval` anywhere in `src/`.
- All mutations go through `claimNode()` (sole `ready→running`) and
  `transitionNode()` (`assertValidTransition` always); resume only revives a
  `running` node whose lease expired *and* whose owner is dead, else it
  re-adopts. A `fork()`-based test pins cross-process single execution.
A dispatch result carrying a `jobId` is always waited on (`pendingJobHandle`;
a bare pending record never counts as success), and `dispatchKey` is scoped
by `workflowId` so identical steps in different runs never share a job.

## Workflow/supervisor link

A waiting node resumes only via `resumeWorkflowNodeFromExecution(jobId)`:
it reads the record's `workflow_id/step_id` (C0), no-ops unless the node is
`WAITING` (`not-waiting:<estado>`), and CASes `WAITING→RUNNING` without
stealing a live owner's claim (`owned-elsewhere` otherwise). Both
`jules_supervise` and `jules_interact` call it best-effort after every
successful interaction — the engine never polls Jules itself. Harness
session origin (`_meta.sessionId` → `harness_origins`, mapping only,
`supportsWake:false`) is recorded for the future lifecycle bridge.

## Workflow planner

Agent-hub can decompose high-level user goals into structured, executable
workflow DAGs without manual node authoring:

- **Plan schema (`WorkflowPlanSchema`)**: validates a plan with `goal` and `steps`
  (`id`, `role`, `dependsOn`, optional `task` and `taskType`).
- **Validation (`validatePlan`)**:
  - Confirms each step's `role` exists in `ROLES`.
  - Ensures unique step IDs and that all `dependsOn` references exist.
  - Detects dependency cycles using depth-first graph traversal (`findCycleInGraph`).
- **Materialization (`materializePlan`)**:
  - Resolves each step's `role` to capability requirements and default task types.
  - Invokes `route()` to select the optimal `agent` and `model`.
  - Produces a fully validated, runnable `WorkflowSchema` object.
- **Decomposition (`decompose`)**:
  - Accepts `{ intent, runPlanner, routeFn, maxSteps = 12 }`.
  - Executes a provided planner function (e.g. LLM-backed), validates the plan,
    enforces maximum step limits (`maxSteps`), and materializes the workflow.
- **Tools (`src/tools/planner.mjs`)**:
  - `plan_task`: validates and materializes a plan without executing anything.
    Accepts an explicit `plan` object (caller plans) or an `intent` (when a planner
    is configured). Returns `{ ok, plan, workflow }` or validation errors.
  - `execute_plan`: validates, materializes, and executes via `runWorkflow`.
    **Approval gate**: strictly requires `approve: true` confirming the plan was
    reviewed; without it, fails closed with `approval required: pass approve:true after reviewing the plan`.
    Never executes an unreviewed or invalid plan.

