import fs from 'node:fs'
import path from 'node:path'
import { paths } from './config.mjs'
import { validateHandoff } from './handoff.mjs'
import { writeArtifact, readArtifact } from './artifacts.mjs'
import {
  getDb,
  upsertHandoff,
  getHandoff,
  listHandoffs as listHandoffsStorage,
  addContextEntry,
  listContextEntries,
} from './storage/index.mjs'

const VALID_CONTEXT_KINDS = new Set(['note', 'decision', 'finding'])

function formatContextEntry(row) {
  if (!row) return null
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    workflowId: row.workflow_id,
    step_id: row.step_id,
    stepId: row.step_id,
    kind: row.kind,
    text: row.text,
    created_at: row.created_at,
    createdAt: row.created_at,
  }
}

export function writeHandoff({ workflowId, stepId, handoff, schema = 'BaseHandoff' }, env = process.env) {
  const validation = validateHandoff(handoff, { schema })
  if (!validation.ok) {
    const errorPaths = validation.errors.map((e) => e.path).join(', ')
    throw new Error(`invalid handoff: ${errorPaths}`)
  }

  const persistedHandoff = validation.value
  const ctx = getDb(env)
  upsertHandoff(ctx, {
    workflow_id: workflowId,
    step_id: stepId,
    handoff_json: JSON.stringify(persistedHandoff),
    updated_at: new Date().toISOString(),
  })

  writeArtifact({
    workflowId,
    stepId,
    name: 'handoff.json',
    content: JSON.stringify(handoff, null, 2),
  }, env)

  return persistedHandoff
}

export function readHandoff({ workflowId, stepId }, env = process.env) {
  const ctx = getDb(env)
  const row = getHandoff(ctx, workflowId, stepId)
  if (row?.handoff_json) {
    try {
      return JSON.parse(row.handoff_json)
    } catch {
      return null
    }
  }

  try {
    const art = readArtifact({ workflowId, stepId, name: 'handoff.json' }, env)
    if (art?.content) {
      return JSON.parse(art.content)
    }
  } catch {}

  return null
}

export function listHandoffs(workflowId, env = process.env) {
  const ctx = getDb(env)
  const rows = listHandoffsStorage(ctx, workflowId)
  if (rows && rows.length > 0) {
    return rows.map((row) => ({
      stepId: row.step_id,
      handoff: typeof row.handoff_json === 'string' ? JSON.parse(row.handoff_json) : row.handoff_json,
    }))
  }

  try {
    const wfDir = path.join(paths(env).runsDir, workflowId)
    if (fs.existsSync(wfDir)) {
      const stepDirs = fs.readdirSync(wfDir, { withFileTypes: true })
      const results = []
      for (const stepEnt of stepDirs) {
        if (stepEnt.isDirectory()) {
          const stepId = stepEnt.name
          try {
            const art = readArtifact({ workflowId, stepId, name: 'handoff.json' }, env)
            if (art?.content) {
              results.push({
                stepId,
                handoff: JSON.parse(art.content),
              })
            }
          } catch {}
        }
      }
      return results.sort((a, b) => a.stepId.localeCompare(b.stepId))
    }
  } catch {}

  return []
}

export function addContext({ workflowId, stepId = null, kind, text }, env = process.env) {
  if (!VALID_CONTEXT_KINDS.has(kind)) {
    throw new Error(`invalid context kind: ${kind}; must be one of note, decision, finding`)
  }

  const ctx = getDb(env)
  const row = addContextEntry(ctx, {
    workflow_id: workflowId,
    step_id: stepId ?? null,
    kind,
    text,
    created_at: new Date().toISOString(),
  })

  return formatContextEntry(row)
}

export function listContext({ workflowId, stepId = null }, env = process.env) {
  const ctx = getDb(env)
  const rows = listContextEntries(ctx, workflowId, stepId)
  return rows.map(formatContextEntry)
}
