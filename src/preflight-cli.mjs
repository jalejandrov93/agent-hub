import { runPreflight, pingAgent } from './preflight.mjs'
import { defaultPairs } from './tools/agents.mjs'

function parseArgs(argv) {
  const out = { ping: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') out.agent = argv[++i]
    else if (argv[i] === '--model') out.model = argv[++i]
    else if (argv[i] === '--ping') out.ping = true
  }
  return out
}

function printRow(entry) {
  const status = entry.status.padEnd(11)
  const level = (entry.ladderLevel ?? '-').padEnd(3)
  const latency = entry.latencyMs != null ? `${entry.latencyMs}ms` : '-'
  console.log(`${entry.agent.padEnd(9)} ${String(entry.model).padEnd(38)} ${status} ${level} ${latency.padEnd(8)} ${entry.reason ?? ''}`)
}

export async function runPreflightCli(argv) {
  const { agent, model, ping } = parseArgs(argv)
  const cwd = process.cwd()

  console.log(`${'AGENT'.padEnd(9)} ${'MODEL'.padEnd(38)} ${'STATUS'.padEnd(11)} LVL LATENCY  REASON`)

  if (agent && model) {
    const entry = ping ? await pingAgent({ agent, model, cwd }) : await runPreflight({ agent, model, cwd, level: 'L2' })
    printRow(entry)
    return
  }

  // --agent alone (no --model): filter the default pairs down to that agent,
  // instead of silently running the full table.
  const pairs = agent ? defaultPairs().filter((p) => p.agent === agent) : defaultPairs()
  for (const pair of pairs) {
    const entry = await runPreflight({ agent: pair.agent, model: pair.model, cwd, level: 'L2' })
    printRow(entry)
  }
}
