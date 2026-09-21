export const REVISION_LIMITS = Object.freeze({ maxFindings: 3, maxChars: 300 })

export function buildRevisionFeedback(input = {}) {
  const { judge = null, verification = null } = input && typeof input === 'object' ? input : {}

  if (!judge || typeof judge !== 'object' || judge.verdict !== 'needs_revision') {
    return ''
  }

  let failedChecks = []
  if (Array.isArray(judge.failed)) {
    for (const item of judge.failed) {
      if (typeof item === 'string' && item.trim().length > 0) {
        failedChecks.push(item.trim())
      }
    }
  }

  if (failedChecks.length === 0 && verification && typeof verification === 'object' && Array.isArray(verification.checks)) {
    for (const check of verification.checks) {
      if (check && typeof check === 'object' && !check.passed) {
        if (typeof check.name === 'string' && check.name.trim().length > 0) {
          failedChecks.push(check.name.trim())
        }
      }
    }
  }

  if (failedChecks.length > REVISION_LIMITS.maxFindings) {
    failedChecks = failedChecks.slice(0, REVISION_LIMITS.maxFindings)
  }

  const findings = []
  if (typeof judge.reason === 'string' && judge.reason.trim().length > 0) {
    findings.push(judge.reason.trim())
  }

  if (verification && typeof verification === 'object' && Array.isArray(verification.checks)) {
    for (const check of verification.checks) {
      if (check && typeof check === 'object' && !check.passed) {
        let text = null
        if (typeof check.reason === 'string' && check.reason.trim().length > 0) {
          text = check.reason.trim()
        } else if (typeof check.detail === 'string' && check.detail.trim().length > 0) {
          text = check.detail.trim()
        } else if (check.detail && typeof check.detail === 'object') {
          try {
            const json = JSON.stringify(check.detail)
            if (json && json !== '{}') {
              text = json
            }
          } catch {}
        }
        if (text) {
          findings.push(text)
        }
      }
    }
  }

  const cappedFindings = findings.slice(0, REVISION_LIMITS.maxFindings).map((f) => {
    return f.length > REVISION_LIMITS.maxChars
      ? f.slice(0, REVISION_LIMITS.maxChars) + '...'
      : f
  })

  if (failedChecks.length === 0 && cappedFindings.length === 0) {
    return ''
  }

  const lines = ['<agent-hub-revision>']
  if (failedChecks.length > 0) {
    lines.push('Failed checks:')
    for (const name of failedChecks) {
      lines.push(`- ${name}`)
    }
  }
  if (cappedFindings.length > 0) {
    lines.push('Findings:')
    for (const finding of cappedFindings) {
      lines.push(`- ${finding}`)
    }
  }
  lines.push('Do not change unrelated files.')
  lines.push('</agent-hub-revision>')

  return lines.join('\n')
}
