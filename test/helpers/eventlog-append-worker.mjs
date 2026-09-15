import { appendEvent } from '../../src/eventlog.mjs'

const [countArg, workerIdArg] = process.argv.slice(2)
const count = Number(countArg)
const workerId = Number(workerIdArg)

for (let seq = 0; seq < count; seq++) {
  appendEvent({
    kind: 'job.finished',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    cwd: '/tmp',
    title: `worker-${workerId}-${seq}`,
    workerId,
    seq,
  })
}

process.exit(0)
