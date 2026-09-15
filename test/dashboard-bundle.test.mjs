import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from '../src/dashboard.mjs'

// Integration seams between the parallel dashboard modules: everything the
// browser will request must be served, CSP-compatible and wired to the
// contract. These checks run on the real src/dashboard/ tree, not fixtures.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_DIR = path.join(HERE, '..', 'src', 'dashboard')
const VIEWS = ['overview', 'agents', 'jobs', 'history', 'subagents', 'timeline', 'config']
const ASSETS = [
  '/', '/styles.css', '/app.js', '/router.js', '/store.js', '/api.js', '/contracts.js',
  ...['dom', 'format', 'badges', 'dialog', 'menu', 'icons'].map((n) => `/ui/${n}.js`),
  ...VIEWS.map((v) => `/views/${v}.js`),
]

// Comments legitimately explain what is forbidden (for example "no style=\"\""),
// so policy scans run on code only. Line comments are only stripped when the
// `//` is not part of a URL scheme such as http://.
function stripComments(text, asset) {
  if (asset.endsWith('.css')) return text.replace(/\/\*[\s\S]*?\*\//g, '')
  if (asset === '/') return text.replace(/<!--[\s\S]*?-->/g, '')
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

async function withServer(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-bundle-'))
  const server = createServer({ env: { ...process.env, AGENT_HUB_HOME: home } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
}

async function fetchBundle(base) {
  const bundle = {}
  for (const asset of ASSETS) {
    const res = await fetch(base + asset)
    bundle[asset] = { status: res.status, text: await res.text() }
  }
  return bundle
}

test('every dashboard asset the browser loads is served', async () => {
  await withServer(async (base) => {
    const bundle = await fetchBundle(base)
    const failing = Object.entries(bundle).filter(([, r]) => r.status !== 200).map(([a, r]) => `${a} -> ${r.status}`)
    assert.deepEqual(failing, [])
  })
})

test('served bundle keeps the ids, routes and busy state the dashboard relies on', async () => {
  await withServer(async (base) => {
    const all = Object.values(await fetchBundle(base)).map((r) => r.text).join('\n')
    for (const needle of ['btn-revalidate-all', 'btn-rediscover', 'config-panel', '/api/agents/refresh', '/api/discovery/refresh', '/api/overrides', 'aria-busy']) {
      assert.ok(all.includes(needle), `missing ${needle} in served dashboard assets`)
    }
  })
})

test('served assets stay compatible with the strict content security policy', async () => {
  await withServer(async (base) => {
    const bundle = await fetchBundle(base)
    const problems = []
    for (const [asset, raw] of Object.entries(bundle)) {
      const text = stripComments(raw.text, asset)
      if (/style="/.test(text)) problems.push(`${asset}: inline style attribute`)
      if (/\beval\s*\(|new Function\s*\(/.test(text)) problems.push(`${asset}: eval or new Function`)
      if (/<script>|<script\s+(?![^>]*\bsrc=)[^>]*>/.test(text) && asset === '/') problems.push(`${asset}: inline script`)
      if (/\bon[a-z]+="/.test(text)) problems.push(`${asset}: inline event handler`)
      const external = (text.match(/https?:\/\/[^\s'"`)]+/g) || []).filter((u) => !u.startsWith('http://www.w3.org/'))
      if (external.length) problems.push(`${asset}: external URL ${external[0]}`)
    }
    assert.deepEqual(problems, [])
  })
})

test('every static relative import resolves to a served asset', async () => {
  await withServer(async (base) => {
    const bundle = await fetchBundle(base)
    const unresolved = []
    for (const [asset, { text }] of Object.entries(bundle)) {
      if (!asset.endsWith('.js')) continue
      const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1])
      for (const spec of specs) {
        const resolved = new URL(spec, `http://x${asset}`).pathname
        if (!ASSETS.includes(resolved)) unresolved.push(`${asset} imports ${spec} -> ${resolved}`)
      }
    }
    assert.deepEqual(unresolved, [])
  })
})

test('shell loads the module entry and the stylesheet the server serves', () => {
  const html = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf8')
  assert.match(html, /<script[^>]+type="module"[^>]+src="\/app\.js"|<script[^>]+src="\/app\.js"[^>]+type="module"/)
  assert.match(html, /<link[^>]+href="\/styles\.css"/)
})

for (const view of VIEWS) {
  test(`views/${view}.js implements the view module interface and imports under Node`, async () => {
    const mod = await import(pathToFileURL(path.join(DASHBOARD_DIR, 'views', `${view}.js`)).href)
    for (const fn of ['mount', 'render', 'unmount']) assert.equal(typeof mod[fn], 'function', `${view}.${fn}`)
  })
}
