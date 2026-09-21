import { CAPABILITY_KEYS } from './capabilities.mjs'
import { resolveHandoffSchema } from './handoff.mjs'

export const ROLES = Object.freeze({
  TRACE_ANALYST: Object.freeze({
    name: 'TRACE_ANALYST',
    description: 'Traces execution paths and code references to cite findings',
    capabilities: Object.freeze([]),
    handoffSchema: 'ResearchHandoff',
    handoffRequired: false,
    acceptance: Object.freeze(['findings cite file:line'])
  }),
  SECURITY_REVIEWER: Object.freeze({
    name: 'SECURITY_REVIEWER',
    description: 'Reviews code for security vulnerabilities, risks, and policy constraints',
    capabilities: Object.freeze(['read']),
    handoffSchema: 'SecurityReviewHandoff',
    handoffRequired: true,
    acceptance: Object.freeze(['every finding names the risk and the evidence'])
  }),
  ARCHITECT: Object.freeze({
    name: 'ARCHITECT',
    description: 'Evaluates architecture and design decisions with explicit tradeoffs',
    capabilities: Object.freeze(['read']),
    handoffSchema: 'BaseHandoff',
    handoffRequired: false,
    acceptance: Object.freeze(['decisions list tradeoffs'])
  }),
  IMPLEMENTER: Object.freeze({
    name: 'IMPLEMENTER',
    description: 'Implements code changes matching diff expectations and requirements',
    capabilities: Object.freeze(['read', 'write']),
    handoffSchema: 'ImplementationHandoff',
    handoffRequired: true,
    acceptance: Object.freeze(['changedFiles matches the diff'])
  }),
  TEST_ANALYST: Object.freeze({
    name: 'TEST_ANALYST',
    description: 'Analyzes test failures and authors reproduction tests',
    capabilities: Object.freeze(['read', 'write']),
    handoffSchema: 'BaseHandoff',
    handoffRequired: false,
    acceptance: Object.freeze(['findings include the failing test'])
  }),
  ADVERSARIAL_REVIEWER: Object.freeze({
    name: 'ADVERSARIAL_REVIEWER',
    description: 'Adversarially reviews proposals and code to challenge assumptions',
    capabilities: Object.freeze(['read']),
    handoffSchema: 'ReviewHandoff',
    handoffRequired: true,
    acceptance: Object.freeze(['decisions explain what must change'])
  })
})

export function getRole(name) {
  if (typeof name !== 'string') return null
  return Object.hasOwn(ROLES, name) ? ROLES[name] : null
}

export function listRoles() {
  return Object.keys(ROLES)
}

export function requirementsForRole(name) {
  const role = getRole(name)
  return role ? role.capabilities : []
}

export function validateRoles(roles = ROLES) {
  const errors = []
  const roleEntries = roles && typeof roles === 'object' ? Object.entries(roles) : []

  for (const [roleName, role] of roleEntries) {
    if (!Array.isArray(role?.capabilities)) {
      errors.push({
        role: roleName,
        field: 'capabilities',
        message: 'capabilities must be an array'
      })
    } else {
      for (const cap of role.capabilities) {
        if (!CAPABILITY_KEYS.includes(cap)) {
          errors.push({
            role: roleName,
            field: 'capabilities',
            message: `unknown capability: ${cap}`
          })
        }
      }
    }

    if (!resolveHandoffSchema(role?.handoffSchema)) {
      errors.push({
        role: roleName,
        field: 'handoffSchema',
        message: `unknown handoff schema: ${role?.handoffSchema}`
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true }
}

const initialValidation = validateRoles(ROLES)
if (!initialValidation.ok) {
  const details = initialValidation.errors
    .map((e) => `${e.role}.${e.field}: ${e.message}`)
    .join('; ')
  throw new Error(`Roles validation failed at module load: ${details}`)
}
