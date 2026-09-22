#!/usr/bin/env node
// Install the runtime copy of agent-hub (server + built dashboard + skills)
// into the directory Claude Code points at, keeping this git checkout as the
// development copy. Nothing under AGENT_HUB_HOME is touched.
//
// Only a clean `main` checkout is installed, so an in-progress branch never
// becomes the runtime every client loads; --allow-branch overrides that.
//
// Usage: node scripts/install-local.mjs [--target <dir>] [--skip-build] [--restart] [--allow-branch]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkInstallSource, readGitState } from './install-guard.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const target = path.resolve(
  value('--target', process.env.AGENT_HUB_INSTALL_DIR ?? path.join(os.homedir(), '.claude', 'mcp-servers', 'agent-hub'))
)
if (target === REPO) {
  console.error('agent-hub: the install target is this checkout; pass --target <dir>')
  process.exit(1)
}

const gitState = readGitState(REPO)
const guard = checkInstallSource({ ...gitState, allowBranch: flag('--allow-branch') })
if (!guard.ok) {
  console.error(`agent-hub: refusing to install — ${guard.reason}`)
  process.exit(1)
}

const run = (cmd, cmdArgs, cwd) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })

if (!flag('--skip-build')) {
  console.log('agent-hub: building the dashboard…')
  run('npm', ['run', 'build'], REPO)
}
const distIndex = path.join(REPO, 'dashboard', 'dist', 'index.html')
if (!fs.existsSync(distIndex)) {
  console.error(`agent-hub: ${distIndex} is missing — run "npm run build" first`)
  process.exit(1)
}

// Replace only the payload directories, so the target keeps its node_modules
// (a reinstall stays fast) and never inherits stale files from an older copy.
const payload = ['bin', 'src', 'skills', 'systemd', 'integrations']
fs.mkdirSync(target, { recursive: true })
for (const dir of [...payload, 'dashboard']) fs.rmSync(path.join(target, dir), { recursive: true, force: true })
for (const dir of payload) fs.cpSync(path.join(REPO, dir), path.join(target, dir), { recursive: true })
fs.mkdirSync(path.join(target, 'dashboard'), { recursive: true })
fs.cpSync(path.join(REPO, 'dashboard', 'dist'), path.join(target, 'dashboard', 'dist'), { recursive: true })
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
  if (fs.existsSync(path.join(REPO, file))) fs.cpSync(path.join(REPO, file), path.join(target, file))
}

// A runtime package.json: no workspaces, no dev dependencies and no prepare
// hook, so `npm install` in the target only fetches what the server imports.
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const runtimePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: pkg.type,
  bin: pkg.bin,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
  private: true,
}
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n')

let commit = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
} catch {
  // installing from a tarball or a copy without git history
}
fs.writeFileSync(
  path.join(target, 'INSTALL.json'),
  JSON.stringify(
    {
      version: pkg.version,
      commit,
      branch: gitState.branch ?? null,
      dirty: gitState.dirty ?? null,
      source: REPO,
      installedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
)

console.log('agent-hub: installing runtime dependencies…')
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], target)

if (flag('--restart')) {
  try {
    run('systemctl', ['--user', 'restart', 'agent-hub-dashboard'], target)
  } catch {
    console.error('agent-hub: could not restart agent-hub-dashboard (is the unit installed?)')
  }
}

console.log(`agent-hub ${pkg.version} installed in ${target}`)
console.log('Restart Claude Code so the MCP server picks up this build.')
