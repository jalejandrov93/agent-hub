export const HANDOFF_FIELDS = Object.freeze([
  'summary',
  'findings',
  'decisions',
  'constraints',
  'changedFiles',
  'openQuestions',
  'artifacts'
])

export const HANDOFF_LIMITS = Object.freeze({
  maxItems: 20,
  maxItemChars: 2000,
  maxSummaryChars: 4000
})

export const HANDOFF_SCHEMAS = Object.freeze({
  BaseHandoff: Object.freeze({
    name: 'BaseHandoff',
    requires: Object.freeze(['summary']),
    description: 'Base handoff requiring a non-empty summary'
  }),
  ResearchHandoff: Object.freeze({
    name: 'ResearchHandoff',
    requires: Object.freeze(['summary', 'findings']),
    description: 'Research handoff requiring summary and findings'
  }),
  SecurityReviewHandoff: Object.freeze({
    name: 'SecurityReviewHandoff',
    requires: Object.freeze(['summary', 'findings', 'constraints']),
    description: 'Security review handoff requiring summary, findings, and constraints'
  }),
  ImplementationHandoff: Object.freeze({
    name: 'ImplementationHandoff',
    requires: Object.freeze(['summary', 'changedFiles']),
    description: 'Implementation handoff requiring summary and changedFiles'
  }),
  ReviewHandoff: Object.freeze({
    name: 'ReviewHandoff',
    requires: Object.freeze(['summary', 'decisions']),
    description: 'Review handoff requiring summary and decisions'
  })
})

export function emptyHandoff() {
  return {
    summary: '',
    findings: [],
    decisions: [],
    constraints: [],
    changedFiles: [],
    openQuestions: [],
    artifacts: []
  }
}

export function normalizeHandoff(value) {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
  const source = isObject ? value : {}

  let summary = ''
  if (typeof source.summary === 'string') {
    const trimmed = source.summary.trim()
    summary = trimmed.length > HANDOFF_LIMITS.maxSummaryChars
      ? trimmed.slice(0, HANDOFF_LIMITS.maxSummaryChars)
      : trimmed
  }

  const result = { summary }

  for (const field of HANDOFF_FIELDS) {
    if (field === 'summary') continue
    const rawList = Array.isArray(source[field]) ? source[field] : []
    const items = []
    const limit = Math.min(rawList.length, HANDOFF_LIMITS.maxItems)
    for (let i = 0; i < limit; i++) {
      const item = rawList[i]
      // The contract is arrays of strings. A non-string item is dropped rather
      // than coerced: keeping a number/object here would let a handoff persist
      // a value that every consumer expects to be text.
      if (typeof item === 'string') {
        const trimmed = item.trim()
        const truncated = trimmed.length > HANDOFF_LIMITS.maxItemChars
          ? trimmed.slice(0, HANDOFF_LIMITS.maxItemChars) + '...'
          : trimmed
        items.push(truncated)
      }
    }
    result[field] = items
  }

  return result
}

export function resolveHandoffSchema(name) {
  if (typeof name !== 'string') return null
  return Object.hasOwn(HANDOFF_SCHEMAS, name) ? HANDOFF_SCHEMAS[name] : null
}

export function listHandoffSchemas() {
  return Object.keys(HANDOFF_SCHEMAS)
}

export function validateHandoff(value, { schema = 'BaseHandoff' } = {}) {
  const schemaObj = typeof schema === 'string'
    ? resolveHandoffSchema(schema)
    : (schema && typeof schema === 'object' && schema.name ? resolveHandoffSchema(schema.name) : null)

  if (!schemaObj) {
    return {
      ok: false,
      errors: [{ path: 'schema', message: `unknown handoff schema: ${schema}` }]
    }
  }

  const normalized = normalizeHandoff(value)
  const errors = []

  for (const field of schemaObj.requires) {
    const val = normalized[field]
    if (typeof val === 'string') {
      if (val.length === 0) {
        errors.push({ path: field, message: `${field} must not be empty` })
      }
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        errors.push({ path: field, message: `${field} must not be empty` })
      }
    } else if (!val) {
      errors.push({ path: field, message: `${field} must not be empty` })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, value: normalized }
}
