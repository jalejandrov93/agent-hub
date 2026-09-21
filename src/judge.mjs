import { parseArtifactRef } from './artifacts.mjs'

export const JUDGE_VERDICTS = Object.freeze(['accepted', 'needs_revision', 'rejected', 'blocked'])

export function judgeVerdict({ verification = null, stepId = null, revision = 0, maxRevisionAttempts = 0, required = false } = {}) {
  const max = Number.isInteger(maxRevisionAttempts) && maxRevisionAttempts > 0 ? maxRevisionAttempts : 0
  const rev = Number.isInteger(revision) && revision >= 0 ? revision : 0

  if (verification == null) {
    return {
      verdict: 'accepted',
      reason: 'no verification configured',
      revision: rev,
      maxRevisionAttempts: max,
      required,
      failed: []
    }
  }

  if (verification.verified === true) {
    return {
      verdict: 'accepted',
      reason: 'all checks passed',
      revision: rev,
      maxRevisionAttempts: max,
      required,
      failed: []
    }
  }

  const failed = (verification.checks || []).filter(c => !c.passed)
  const failedNames = failed.map(c => c.name)

  const blockedCheck = failed.find(c => {
    if (c.kind === 'artifact' && c.ref) {
      const parsed = parseArtifactRef(c.ref)
      return Boolean(parsed && parsed.stepId !== stepId)
    }
    return false
  })

  if (blockedCheck) {
    return {
      verdict: 'blocked',
      reason: 'upstream evidence missing: ' + blockedCheck.ref,
      revision: rev,
      maxRevisionAttempts: max,
      required,
      failed: failedNames
    }
  }

  if (rev < max) {
    return {
      verdict: 'needs_revision',
      reason: 'verification failed: ' + failedNames.join(', ') + '; revision ' + (rev + 1) + '/' + max,
      revision: rev,
      maxRevisionAttempts: max,
      required,
      failed: failedNames
    }
  }

  return {
    verdict: 'rejected',
    reason: 'verification failed: ' + failedNames.join(', ') + '; no revision attempts left',
    revision: rev,
    maxRevisionAttempts: max,
    required,
    failed: failedNames
  }
}
