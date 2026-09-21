/**
 * Pure execution graph builder over a list of job records.
 * Provides deterministic node and edge representations of multi-agent and workflow executions.
 */

/**
 * Derives the unique node identity for a job record.
 * Falls back across executionId, execution_id, and jobId.
 *
 * @param {object} [job]
 * @returns {string|null}
 */
export function nodeIdentity(job) {
  return job?.executionId ?? job?.execution_id ?? job?.jobId ?? null
}

/**
 * Builds a deterministic execution graph from an array of job records.
 *
 * Relationship inference is BEST-EFFORT:
 * - 'retry': Number(job.attempt) > 1
 * - 'resume': job.sessionId matches its parent's sessionId (resumed conversation)
 * - 'delegate': default relationship
 *
 * @param {object} [options]
 * @param {Array<object>} [options.jobs] - List of JobRecord objects
 * @param {string|null} [options.rootExecutionId] - Subtree filter root id
 * @returns {{ roots: string[], nodes: Record<string, object>, edges: Array<{ from: string, to: string, relation: string }> }}
 */
export function buildExecutionGraph({ jobs = [], rootExecutionId = null } = {}) {
  const jobsById = new Map()
  for (const job of jobs) {
    const id = nodeIdentity(job)
    if (id) jobsById.set(id, job)
  }

  const allNodes = {}
  for (const job of jobs) {
    const id = nodeIdentity(job)
    if (!id) continue

    const parent = job.parent_execution_id ?? job.parentExecutionId ?? null
    const root = job.root_execution_id ?? job.rootExecutionId ?? id

    // Best-effort relationship classification
    let relation = 'delegate'
    const parentJob = parent ? jobsById.get(parent) : null
    if (Number(job.attempt) > 1) {
      relation = 'retry'
    } else if (
      job.sessionId &&
      parentJob &&
      parentJob.sessionId &&
      job.sessionId === parentJob.sessionId
    ) {
      relation = 'resume'
    }

    allNodes[id] = {
      id,
      jobId: job.jobId ?? null,
      agent: job.agent ?? null,
      model: job.model ?? null,
      status: job.status ?? null,
      workflow_id: job.workflow_id ?? null,
      step_id: job.step_id ?? null,
      attempt: job.attempt ?? null,
      parent,
      root,
      relation,
    }
  }

  let selectedNodeIds
  let roots

  if (rootExecutionId) {
    if (!allNodes[rootExecutionId]) {
      return { roots: [], nodes: {}, edges: [] }
    }

    // Adjacency map for subtree traversal
    const childrenMap = new Map()
    for (const node of Object.values(allNodes)) {
      if (node.parent) {
        if (!childrenMap.has(node.parent)) {
          childrenMap.set(node.parent, [])
        }
        childrenMap.get(node.parent).push(node.id)
      }
    }

    const subtreeSet = new Set()
    const queue = [rootExecutionId]
    while (queue.length > 0) {
      const currentId = queue.shift()
      if (subtreeSet.has(currentId)) continue
      subtreeSet.add(currentId)
      const children = childrenMap.get(currentId) || []
      for (const childId of children) {
        if (!subtreeSet.has(childId)) {
          queue.push(childId)
        }
      }
    }

    selectedNodeIds = Array.from(subtreeSet).sort()
    roots = [rootExecutionId]
  } else {
    selectedNodeIds = Object.keys(allNodes).sort()
    roots = Object.values(allNodes)
      .filter((n) => n.parent === null)
      .map((n) => n.id)
      .sort()
  }

  const nodes = {}
  for (const id of selectedNodeIds) {
    nodes[id] = allNodes[id]
  }

  const edges = []
  for (const node of Object.values(nodes)) {
    if (node.parent && nodes[node.parent]) {
      edges.push({
        from: node.parent,
        to: node.id,
        relation: node.relation,
      })
    }
  }

  edges.sort((a, b) => {
    const cmp = a.from.localeCompare(b.from)
    return cmp !== 0 ? cmp : a.to.localeCompare(b.to)
  })

  return { roots, nodes, edges }
}

/**
 * Aggregates summary statistics for an execution graph.
 *
 * @param {object} [graph]
 * @returns {{ roots: string[], nodeCount: number, edgeCount: number, byStatus: Record<string, number> }}
 */
export function summarizeExecutionGraph(graph = {}) {
  const roots = graph.roots ? [...graph.roots] : []
  const nodes = graph.nodes ?? {}
  const edges = graph.edges ?? []
  const byStatus = {}

  for (const node of Object.values(nodes)) {
    const s = node.status ?? 'unknown'
    byStatus[s] = (byStatus[s] ?? 0) + 1
  }

  return {
    roots,
    nodeCount: Object.keys(nodes).length,
    edgeCount: edges.length,
    byStatus,
  }
}
