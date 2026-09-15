#!/usr/bin/env node
// Runs the dashboard workspace build as part of `npm install` (via the
// "prepare" lifecycle script). The MCP server itself does not need the
// dashboard bundle to function, so a failure here must never fail
// `npm install` for a consumer of this package — it only prints a hint and
// exits 0.
import { spawnSync } from 'node:child_process'

const result = spawnSync('npm', ['run', '-w', 'dashboard', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.status !== 0) {
  console.error('agent-hub: dashboard build failed — run "npm run build" to see why')
}

process.exit(0)
