import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createJob, updateResult } from '../src/jobstore.mjs'
import { resetDbInstances } from '../src/storage/index.mjs'
import {
  agentSendMessageTool,
  agentInboxTool,
  agentAckTool,
  agentPeersTool,
} from '../src/tools/messaging.mjs'
import { jobReplyTool } from '../src/tools/jobs.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-messaging-test-'))
}

beforeEach(() => {
  resetDbInstances()
})

test('an inbox call without rootExecutionId fails', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const resMissing = await agentInboxTool({ to: 'codex', env })
  assert.deepEqual(resMissing, { ok: false, error: 'rootExecutionId is required' })

  const resNull = await agentInboxTool({ to: 'codex', rootExecutionId: null, env })
  assert.deepEqual(resNull, { ok: false, error: 'rootExecutionId is required' })

  const resEmpty = await agentInboxTool({ to: 'codex', rootExecutionId: '', env })
  assert.deepEqual(resEmpty, { ok: false, error: 'rootExecutionId is required' })

  const resWhitespace = await agentInboxTool({ to: 'codex', rootExecutionId: '   ', env })
  assert.deepEqual(resWhitespace, { ok: false, error: 'rootExecutionId is required' })
})

test('explicit cross-root isolation: a message in root A is invisible to an inbox query in root B', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  await agentSendMessageTool({
    to: 'same-recipient',
    text: 'message in root A',
    rootExecutionId: 'root-alpha',
    env,
  })

  const inboxB = await agentInboxTool({
    to: 'same-recipient',
    rootExecutionId: 'root-beta',
    env,
  })
  assert.equal(inboxB.ok, true)
  assert.deepEqual(inboxB.messages, [])

  const inboxA = await agentInboxTool({
    to: 'same-recipient',
    rootExecutionId: 'root-alpha',
    env,
  })
  assert.equal(inboxA.ok, true)
  assert.equal(inboxA.messages.length, 1)
  assert.equal(inboxA.messages[0].text, 'message in root A')
})

test('send -> inbox round-trip', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const sendRes = await agentSendMessageTool({
    to: 'codex',
    text: 'hello from orchestrator',
    kind: 'notice',
    rootExecutionId: 'root-1',
    from: 'orchestrator',
    env,
  })

  assert.equal(sendRes.ok, true)
  assert.equal(sendRes.status, 'enqueued')
  assert.equal(sendRes.truncated, false)
  assert.equal(typeof sendRes.messageId, 'number')

  const inboxRes = await agentInboxTool({
    to: 'codex',
    rootExecutionId: 'root-1',
    env,
  })

  assert.equal(inboxRes.ok, true)
  assert.equal(inboxRes.messages.length, 1)
  const msg = inboxRes.messages[0]
  assert.equal(msg.id, sendRes.messageId)
  assert.equal(msg.from, 'orchestrator')
  assert.equal(msg.kind, 'notice')
  assert.equal(msg.text, 'hello from orchestrator')
  assert.ok(msg.createdAt)
  assert.ok(msg.deliveredAt)
  assert.equal(msg.ackAt, null)
})

test('ROOT ISOLATION (a message in root A is invisible to root B)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  await agentSendMessageTool({
    to: 'codex',
    text: 'message for root A only',
    kind: 'notice',
    rootExecutionId: 'root-A',
    env,
  })

  const inboxB = await agentInboxTool({
    to: 'codex',
    rootExecutionId: 'root-B',
    env,
  })
  assert.equal(inboxB.ok, true)
  assert.deepEqual(inboxB.messages, [])

  const inboxA = await agentInboxTool({
    to: 'codex',
    rootExecutionId: 'root-A',
    env,
  })
  assert.equal(inboxA.ok, true)
  assert.equal(inboxA.messages.length, 1)
  assert.equal(inboxA.messages[0].text, 'message for root A only')
})

test('truncation marker + truncated:true', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const longText = 'x'.repeat(4500)
  const sendRes = await agentSendMessageTool({
    to: 'codex',
    text: longText,
    rootExecutionId: 'root-trunc',
    env,
  })

  assert.equal(sendRes.ok, true)
  assert.equal(sendRes.truncated, true)

  const inboxRes = await agentInboxTool({
    to: 'codex',
    rootExecutionId: 'root-trunc',
    env,
  })
  assert.equal(inboxRes.ok, true)
  assert.equal(inboxRes.messages.length, 1)
  const msg = inboxRes.messages[0]
  assert.ok(msg.text.endsWith('...[truncated]'))
  assert.equal(msg.text.startsWith('x'.repeat(4000)), true)
})

test('mailbox_full after 10', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  for (let i = 0; i < 10; i++) {
    const res = await agentSendMessageTool({
      to: 'codex',
      from: `sender-${i}`,
      text: `notice ${i}`,
      rootExecutionId: 'root-cap',
      env,
    })
    assert.equal(res.ok, true, `message ${i} should succeed`)
  }

  const overflow = await agentSendMessageTool({
    to: 'codex',
    from: 'sender-overflow',
    text: 'notice 11',
    rootExecutionId: 'root-cap',
    env,
  })
  assert.equal(overflow.ok, false)
  assert.equal(overflow.error, 'mailbox_full')

  // Reading inbox marks delivered, clearing undelivered count
  const inboxRes = await agentInboxTool({
    to: 'codex',
    rootExecutionId: 'root-cap',
    env,
  })
  assert.equal(inboxRes.ok, true)
  assert.equal(inboxRes.messages.length, 10)

  // Now sending succeeds again
  const afterDrain = await agentSendMessageTool({
    to: 'codex',
    text: 'notice 11 retry',
    rootExecutionId: 'root-cap',
    env,
  })
  assert.equal(afterDrain.ok, true)
})

test('broadcast rejected', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  for (const wildcard of ['*', 'all', 'broadcast']) {
    const res = await agentSendMessageTool({
      to: wildcard,
      text: 'hello everyone',
      rootExecutionId: 'root-bc',
      env,
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'broadcast is not supported: address one peer')
  }
})

test('inbox marks delivered and a second inbox is empty', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  await agentSendMessageTool({
    to: 'opencode',
    text: 'first message',
    rootExecutionId: 'root-deliv',
    env,
  })

  const firstInbox = await agentInboxTool({
    to: 'opencode',
    rootExecutionId: 'root-deliv',
    env,
  })
  assert.equal(firstInbox.ok, true)
  assert.equal(firstInbox.messages.length, 1)
  assert.ok(firstInbox.messages[0].deliveredAt)

  const secondInbox = await agentInboxTool({
    to: 'opencode',
    rootExecutionId: 'root-deliv',
    env,
  })
  assert.equal(secondInbox.ok, true)
  assert.equal(secondInbox.messages.length, 0)

  // unreadOnly = false returns previously delivered messages
  const allInbox = await agentInboxTool({
    to: 'opencode',
    rootExecutionId: 'root-deliv',
    unreadOnly: false,
    env,
  })
  assert.equal(allInbox.ok, true)
  assert.equal(allInbox.messages.length, 1)
})

test('ack sets ackAt and unknown id fails', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const failAck = await agentAckTool({
    messageId: 999999,
    env,
  })
  assert.equal(failAck.ok, false)
  assert.ok(failAck.error)

  const sendRes = await agentSendMessageTool({
    to: 'agy',
    text: 'needs ack',
    rootExecutionId: 'root-ack',
    env,
  })
  assert.equal(sendRes.ok, true)

  const ackRes = await agentAckTool({
    messageId: sendRes.messageId,
    env,
  })
  assert.equal(ackRes.ok, true)
  assert.equal(ackRes.acked, true)
  assert.ok(ackRes.ackAt)

  const inbox = await agentInboxTool({
    to: 'agy',
    rootExecutionId: 'root-ack',
    unreadOnly: false,
    env,
  })
  assert.equal(inbox.messages[0].ackAt, ackRes.ackAt)
})

test('peers lists the jobs of a root with their messaging capabilities', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const job1 = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'task 1',
    cwd: '/tmp',
    root_execution_id: 'root-peers-1',
    step_id: 'step-1',
    env,
  })

  const job2 = createJob({
    agent: 'copilot',
    model: 'claude-3.5-sonnet',
    task: 'task 2',
    cwd: '/tmp',
    root_execution_id: 'root-peers-1',
    step_id: 'step-2',
    env,
  })

  createJob({
    agent: 'codex',
    model: 'o3-mini',
    task: 'task 3',
    cwd: '/tmp',
    root_execution_id: 'root-other',
    step_id: 'step-3',
    env,
  })

  const res = await agentPeersTool({
    rootExecutionId: 'root-peers-1',
    env,
  })

  assert.equal(res.ok, true)
  assert.equal(res.peers.length, 2)

  const peer1 = res.peers.find((p) => p.jobId === job1.jobId)
  assert.ok(peer1)
  assert.equal(peer1.agent, 'agy')
  assert.equal(peer1.stepId, 'step-1')
  assert.equal(peer1.messagingTurnBoundary, true)
  assert.equal(peer1.messagingMidRun, false)

  const peer2 = res.peers.find((p) => p.jobId === job2.jobId)
  assert.ok(peer2)
  assert.equal(peer2.agent, 'copilot')
  assert.equal(peer2.stepId, 'step-2')
  assert.equal(peer2.messagingTurnBoundary, false)
  assert.equal(peer2.messagingMidRun, false)
})

test("job_reply receives '[Inter-Agent Notice' block and marks delivered", async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const parent = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-medium',
    task: 'initial plan',
    cwd: '/tmp',
    sessionId: 'sess-boundary-1',
    root_execution_id: 'root-reply-1',
    step_id: 'step-plan',
    env,
  })
  updateResult(parent.jobId, { status: 'succeeded' }, env)

  await agentSendMessageTool({
    to: parent.jobId,
    text: 'orchestrator advice: use ESM only',
    rootExecutionId: 'root-reply-1',
    from: 'orchestrator',
    env,
  })

  let captured = null
  const fakeStartJob = (args) => {
    captured = args
    return { job: { jobId: 'reply-job-1', status: 'running', errorKind: null } }
  }

  const replyRes = await jobReplyTool({
    jobId: parent.jobId,
    message: 'execute the plan',
    startJobFn: fakeStartJob,
    env,
  })

  assert.equal(replyRes.status, 'running')
  assert.ok(captured, 'startJobFn should be called')
  assert.match(
    captured.task,
    /\[Inter-Agent Notice from orchestrator\]: orchestrator advice: use ESM only/
  )
  assert.match(captured.task, /execute the plan/)

  // The message was marked delivered: undelivered inbox should be empty
  const inbox = await agentInboxTool({
    to: parent.jobId,
    rootExecutionId: 'root-reply-1',
    unreadOnly: true,
    env,
  })
  assert.equal(inbox.messages.length, 0)
})

test('message loop guard: 6th undelivered message from same sender is rejected', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  // Send 5 messages from 'sender-A' to 'target-agent'
  for (let i = 0; i < 5; i++) {
    const res = await agentSendMessageTool({
      to: 'target-agent',
      from: 'sender-A',
      text: `notice ${i}`,
      rootExecutionId: 'root-loop-guard',
      env,
    })
    assert.equal(res.ok, true, `message ${i} should succeed`)
  }

  // The 6th message from 'sender-A' should be rejected
  const loopGuardMsg = await agentSendMessageTool({
    to: 'target-agent',
    from: 'sender-A',
    text: 'notice 6',
    rootExecutionId: 'root-loop-guard',
    env,
  })
  assert.equal(loopGuardMsg.ok, false)
  assert.equal(loopGuardMsg.error, 'message loop guard: too many undelivered messages for this pair')

  // A message from a different sender should still succeed
  const otherSenderMsg = await agentSendMessageTool({
    to: 'target-agent',
    from: 'sender-B',
    text: 'notice from B',
    rootExecutionId: 'root-loop-guard',
    env,
  })
  assert.equal(otherSenderMsg.ok, true)

  // Reading the inbox marks messages as delivered, clearing the undelivered count
  const inboxRes = await agentInboxTool({
    to: 'target-agent',
    rootExecutionId: 'root-loop-guard',
    env,
  })
  assert.equal(inboxRes.ok, true)
  assert.equal(inboxRes.messages.length, 6) // 5 from A, 1 from B

  // Now 'sender-A' should be able to send again
  const afterDrain = await agentSendMessageTool({
    to: 'target-agent',
    from: 'sender-A',
    text: 'notice 7',
    rootExecutionId: 'root-loop-guard',
    env,
  })
  assert.equal(afterDrain.ok, true)
})
