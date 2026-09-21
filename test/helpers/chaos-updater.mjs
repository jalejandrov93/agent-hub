import { updateResult } from '../../src/jobstore.mjs'

const [jobId, workerTag, countStr] = process.argv.slice(2)
const count = parseInt(countStr || '10', 10)
const env = { ...process.env }

for (let i = 0; i < count; i++) {
  updateResult(
    jobId,
    (current) => {
      const updates = Array.isArray(current.updates) ? [...current.updates] : []
      updates.push(`${workerTag}:${i}`)
      return {
        updates,
        [`${workerTag}_count`]: (current[`${workerTag}_count`] || 0) + 1
      }
    },
    env
  )
}

process.exit(0)
