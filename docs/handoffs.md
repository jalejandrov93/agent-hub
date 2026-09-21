# Context, handoffs and messaging

## Context, handoffs and roles

Multi-step workflows require structured state transfer between nodes without
forcing downstream models to parse unstructured conversational logs. Agent-hub
provides role definitions and schema-validated handoffs backed by SQLite and
disk artifacts.

**Roles (`src/roles.mjs`)** define responsibilities, required capabilities,
acceptance criteria, and default handoff schemas:

| Role | Default Task Type | Capabilities | Handoff Schema | Required? | Acceptance Rule |
|---|---|---|---|---|---|
| `TRACE_ANALYST` | `recon` | none | `ResearchHandoff` | No | Findings cite file:line |
| `SECURITY_REVIEWER` | `adversarial-review` | `read` | `SecurityReviewHandoff` | Yes | Every finding names the risk and the evidence |
| `ARCHITECT` | `architecture` | `read` | `BaseHandoff` | No | Decisions list tradeoffs |
| `IMPLEMENTER` | `mechanical-edit` | `read`, `write` | `ImplementationHandoff` | Yes | `changedFiles` matches the diff |
| `TEST_ANALYST` | `mechanical-edit` | `read`, `write` | `BaseHandoff` | No | Findings include the failing test |
| `ADVERSARIAL_REVIEWER` | `adversarial-review` | `read` | `ReviewHandoff` | Yes | Decisions explain what must change |
| `PLANNER` | `architecture` | none | `BaseHandoff` | No | The plan validates against `WorkflowPlan` |

**Structured handoffs (`src/handoff.mjs`)** enforce typed contract schemas:
- `BaseHandoff`: requires non-empty `summary`.
- `ResearchHandoff`: requires `summary` and `findings`.
- `SecurityReviewHandoff`: requires `summary`, `findings`, and `constraints`.
- `ImplementationHandoff`: requires `summary` and `changedFiles`.
- `ReviewHandoff`: requires `summary` and `decisions`.

Handoff payloads contain standard fields: `summary`, `findings`, `decisions`,
`constraints`, `changedFiles`, `openQuestions`, `artifacts`. String-only items
are enforced, bounded by `HANDOFF_LIMITS` (max 20 items per field, max 2000
chars per item, max 4000 chars for summary).

**Persistence & consumption (`src/context.mjs`)**:
- A node declares `handoff: { schema: 'ImplementationHandoff', required: true }`
  (or shorthand `handoff: true`). The engine directs the worker to write
  `handoff.json` into its artifacts directory.
- On completion, `validateHandoff` validates the payload. Valid handoffs are
  persisted to SQLite table `task_handoffs` (`workflow_id`, `step_id`,
  `handoff_json`, `updated_at`) and mirrored to `artifacts/handoff.json`.
- When `required: true`, schema validation failure fails the node.
- Downstream steps receive upstream dependency handoffs pre-formatted into their
  dispatched prompt context.
- Fine-grained workflow notes, decisions, and findings are captured in SQLite
  table `task_context` (`workflow_id`, `step_id`, `kind`, `text`, `created_at`).

## Inter-agent messaging

For collaborative workflows and peer coordination, agent-hub provides an
asynchronous, SQLite-backed inter-agent mailbox (`task_messages`) scoped to a
`rootExecutionId` (or inferred from a recipient `jobId`):

- **Tools**:
  - `agent_send_message`: `{to, text, kind?, rootExecutionId?, from?, workflowId?}`
    enqueues a message to a peer mailbox.
  - `agent_inbox`: `{to?, rootExecutionId?, unreadOnly?}` retrieves messages
    oldest-first and marks them delivered (`delivered_at`).
  - `agent_ack`: `{messageId}` acknowledges receipt of a message (`ack_at`).
  - `agent_peers`: `{rootExecutionId}` lists participating peers and their
    messaging capabilities (`messagingTurnBoundary`, `messagingMidRun`).
- **Honest ACK semantics**: an ACK means the message was deposited into the peer's
  context envelope. It **NEVER** implies the peer read, understood, agreed with,
  or acted on the message.
- **Turn-boundary delivery**: pending mailbox messages are delivered across
  conversation turn boundaries via `job_reply`.
- **Bounded communication**:
  - **No broadcast**: addressing wildcards (`*`, `all`, `broadcast`) are rejected;
    all messages must be addressed point-to-point to a specific peer or `jobId`.
  - **Message size limit**: text is capped at 4,000 characters (`MAX_TEXT_LEN = 4000`);
    oversized messages are truncated with `...[truncated]` and flagged with `truncated: true`.
  - **Mailbox queue cap**: max 10 unread messages per recipient; further sends fail
    with `{ ok: false, error: 'mailbox_full' }` until the recipient drains them.

