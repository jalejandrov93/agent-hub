// Config view: read-only delegation map, process/CLI resolution, breaker/TTL
// settings and overrides, plus write-allowlist paths. Edits only ever
// happen through the Overrides tab's Release action (ported from
// dashboard.html renderConfig) — everything else here is read-only,
// matching the legacy panel's intent.
import { h, on, clear } from '../ui/dom.js'
import { formatModel, formatAge } from '../ui/format.js'

const TABS = [
  { value: 'delegation', label: 'Delegation map' },
  { value: 'process', label: 'Process & CLIs' },
  { value: 'breaker', label: 'Breaker & TTL' },
  { value: 'overrides', label: 'Overrides' },
  { value: 'paths', label: 'Paths' },
]

let ctx_ = null
let els = null
let offClick = null
let ui = { section: 'delegation' }

function kv(entries) {
  const dl = h('dl', { class: 'kv' })
  for (const [label, value] of entries) dl.append(h('dt', { text: label }), h('dd', { text: value }))
  return dl
}

function chainStepLabel(step) {
  if (!step) return ''
  return step.agent === 'claude' ? 'Claude Agent tool' : `${step.agent}${step.model ? `:${formatModel(step.model)}` : ''}`
}

function renderDelegation(config) {
  const wrap = h('div', { class: 'stack gap-md' })
  const taskTypes = Object.keys(config.delegationMap || {})
  if (!taskTypes.length) {
    wrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'No delegation map configured' }),
      h('div', { class: 'empty-hint', text: 'Task-type routing will appear here once configured' }),
    ]))
    return wrap
  }
  for (const taskType of taskTypes) {
    const entry = config.delegationMap[taskType]
    const chain = h('div', { class: 'chain' })
    entry.chain.forEach((step, i) => {
      if (i > 0) chain.append(h('span', { class: 'chain-arrow', 'aria-hidden': 'true', text: '→' }))
      const stepEl = h('span', { class: 'chain-step', text: chainStepLabel(step) })
      if (step.parallelWith) {
        stepEl.append(h('span', { text: ' + ' }), h('span', { class: 'chain-step', text: chainStepLabel(step.parallelWith) }))
      }
      chain.append(stepEl)
    })
    wrap.append(h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: taskType }),
      h('div', { class: 'card-body' }, [chain, h('p', { class: 'muted', text: entry.why })]),
    ]))
  }
  return wrap
}

function renderProcess(config) {
  const wrap = h('div', { class: 'stack gap-md' })
  const proc = config.process || {}
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Dashboard process' }),
    h('div', { class: 'card-body' }, [kv([
      ['PID', String(proc.pid != null ? proc.pid : '—')],
      ['Node version', proc.nodeVersion || '—'],
      ['Platform', proc.platform || '—'],
    ])]),
  ]))

  const bins = proc.resolvedBins || {}
  const binsTable = h('table', { class: 'table table-dense' }, [
    h('thead', {}, [h('tr', {}, [h('th', { text: 'Agent' }), h('th', { text: 'Resolved bin' })])]),
  ])
  const binsBody = h('tbody')
  for (const agent of Object.keys(bins)) {
    const path = bins[agent]
    const cell = path
      ? h('span', { class: 'cell-mono', title: path, text: path })
      : h('span', { class: 'badge tone-unavailable', text: 'not found' })
    binsBody.append(h('tr', {}, [h('td', { text: agent }), h('td', {}, [cell])]))
  }
  binsTable.append(binsBody)

  const pathList = (proc.pathEntries || []).length
    ? h('ul', { class: 'stack gap-sm' }, (proc.pathEntries || []).map((p) => h('li', { class: 'cell-mono', text: p })))
    : h('div', { class: 'empty-hint', text: 'PATH is empty for this process' })

  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Resolved CLI binaries' }),
    h('div', { class: 'card-body' }, [binsTable]),
  ]))
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Dashboard process PATH' }),
    h('div', { class: 'card-body' }, [pathList]),
  ]))

  const discovery = config.discovery || {}
  const discoveryAgents = Object.keys(discovery)
  const discoveryTable = h('table', { class: 'table table-dense' }, [
    h('thead', {}, [h('tr', {}, ['Agent', 'Version', 'Models', 'Error', 'Checked'].map((t) => h('th', { text: t })))]),
  ])
  const discoveryBody = h('tbody')
  for (const agent of discoveryAgents) {
    const d = discovery[agent]
    discoveryBody.append(h('tr', {}, [
      h('td', { text: agent }),
      h('td', { text: d.version || '—' }),
      h('td', { class: 'num', text: String((d.models || []).length) }),
      h('td', { text: d.error || '—' }),
      h('td', { text: formatAge(d.checkedAt) }),
    ]))
  }
  discoveryTable.append(discoveryBody)
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Discovery' }),
    h('div', { class: 'card-body' }, [
      discoveryAgents.length ? discoveryTable : h('div', { class: 'empty-hint', text: 'No discovery data yet — run Rediscover on the Agents view' }),
    ]),
  ]))
  return wrap
}

function renderBreaker(config) {
  const wrap = h('div', { class: 'stack gap-md' })
  const b = config.breaker || {}
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Breaker & TTL settings' }),
    h('div', { class: 'card-body' }, [kv([
      ['Preflight TTL', `${Math.round((config.ttlMs || 0) / 60000)}m`],
      ['Breaker window', `${Math.round((b.windowMs || 0) / 60000)}m`],
      ['Breaker threshold', `${b.failureThreshold || 0} failure(s)`],
      ['Breaker failure kinds', (b.failureKinds || []).join(', ') || '—'],
      ['Breaker immediate kinds', (b.immediateKinds || []).join(', ') || '—'],
    ])]),
  ]))

  const timeoutRows = []
  const timeouts = config.timeouts || {}
  for (const agent of Object.keys(timeouts)) {
    for (const model of Object.keys(timeouts[agent])) {
      timeoutRows.push(h('tr', {}, [
        h('td', { text: agent }), h('td', { text: model }), h('td', { class: 'num', text: `${timeouts[agent][model]}s` }),
      ]))
    }
  }
  const timeoutTable = h('table', { class: 'table table-dense' }, [
    h('thead', {}, [h('tr', {}, [h('th', { text: 'Agent' }), h('th', { text: 'Model' }), h('th', { text: 'Timeout' })])]),
    h('tbody', {}, timeoutRows),
  ])
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Timeouts' }),
    h('div', { class: 'card-body' }, [timeoutTable]),
  ]))

  const states = config.breakerState || []
  const breakerBody = h('tbody')
  for (const s of states) {
    const tr = h('tr', {}, [
      h('td', { text: s.agent }), h('td', { text: s.model }),
      h('td', {}, [h('span', { class: `badge tone-${s.open ? 'unavailable' : 'ready'}`, text: s.open ? 'open' : 'closed' })]),
      h('td', { class: 'num', text: String(s.failureCount) }),
      h('td', { text: formatAge(s.lastFailureAt) }),
    ])
    if (s.open) tr.classList.add('is-selected')
    breakerBody.append(tr)
  }
  const breakerTable = h('table', { class: 'table table-dense' }, [
    h('thead', {}, [h('tr', {}, ['Agent', 'Model', 'State', 'Failures', 'Last failure'].map((t) => h('th', { text: t })))]),
  ])
  breakerTable.append(breakerBody)
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Breaker state' }),
    h('div', { class: 'card-body' }, [
      states.length ? breakerTable : h('div', { class: 'empty-hint', text: 'No breaker state recorded' }),
    ]),
  ]))
  return wrap
}

function renderOverrides(config) {
  const wrap = h('div', { class: 'stack gap-md' })
  const keys = Object.keys(config.overrides || {})
  if (!keys.length) {
    wrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'No overrides set' }),
      h('div', { class: 'empty-hint', text: 'No manual holds or breaker resets are currently set' }),
    ]))
    return wrap
  }
  const table = h('table', { class: 'table table-dense' }, [
    h('thead', {}, [h('tr', {}, ['Pair', 'Hold', 'Breaker reset', 'Set at', 'Actions'].map((t) => h('th', { text: t })))]),
  ])
  const tbody = h('tbody')
  for (const key of keys) {
    const o = config.overrides[key]
    const releaseBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Release' })
    releaseBtn.dataset.action = 'release'
    releaseBtn.dataset.key = key
    releaseBtn.dataset.busyKey = `release:${key}`
    tbody.append(h('tr', {}, [
      h('td', { class: 'cell-mono', text: key }),
      h('td', {}, [o.hold ? h('span', { class: 'badge tone-degraded', text: 'held' }) : h('span', { class: 'muted', text: '—' })]),
      h('td', { text: o.breakerReset || '—' }),
      h('td', { text: o.setAt || '—' }),
      h('td', { class: 'cell-actions' }, [releaseBtn]),
    ]))
  }
  table.append(tbody)
  wrap.append(table)
  return wrap
}

function renderPaths(config) {
  const wrap = h('div', { class: 'stack gap-md' })
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Paths' }),
    h('div', { class: 'card-body' }, [kv([['State dir', config.agentHubHome || '—']])]),
  ]))
  const allow = config.writeAllowlist || []
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: 'Write allowlist' }),
    h('div', { class: 'card-body' }, [
      allow.length
        ? h('ul', { class: 'stack gap-sm' }, allow.map((p) => h('li', { class: 'cell-mono', text: p })))
        : h('div', { class: 'empty-state' }, [
          h('div', { class: 'empty-title', text: 'Write allowlist is empty' }),
          h('div', { class: 'empty-hint', text: 'Write mode requires a secondary git worktree registered in the allowlist' }),
        ]),
    ]),
  ]))
  return wrap
}

function renderTabs() {
  clear(els.tabs)
  TABS.forEach((t, i) => {
    const tab = h('button', {
      type: 'button', class: 'tab', role: 'tab', id: `tab-${t.value}`,
      'aria-selected': String(ui.section === t.value), tabindex: ui.section === t.value ? '0' : '-1', text: t.label,
    })
    tab.dataset.action = 'tab'
    tab.dataset.section = t.value
    els.tabs.append(tab)
  })
}

function renderSection(config) {
  clear(els.panel)
  if (!config) {
    els.panel.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'Config not loaded yet' }),
      h('div', { class: 'empty-hint', text: 'Waiting for the first successful refresh' }),
    ]))
    return
  }
  const renderers = {
    delegation: renderDelegation, process: renderProcess, breaker: renderBreaker,
    overrides: renderOverrides, paths: renderPaths,
  }
  els.panel.append(renderers[ui.section](config))
}

function focusTab(delta) {
  const i = TABS.findIndex((t) => t.value === ui.section)
  const next = TABS[(i + delta + TABS.length) % TABS.length]
  ui.section = next.value
  ctx_.navigate('config', { section: ui.section })
  const btn = els.tabs.querySelector(`#tab-${next.value}`)
  if (btn) btn.focus()
}

export function mount(root, ctx) {
  ctx_ = ctx
  root.id = 'config-panel'
  ui = { section: ctx.route.query.section || 'delegation' }

  const header = h('header', { class: 'view-header' }, [
    h('h1', { id: 'view-title', class: 'view-title', tabindex: '-1', text: 'Config' }),
  ])
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Config sections' })
  const panel = h('div', { class: 'section', role: 'tabpanel' })

  root.append(header, tabs, panel)
  els = { tabs, panel }

  offClick = on(root, 'click', '[data-action]', (event, matched) => {
    const action = matched.dataset.action
    if (action === 'tab') {
      ui.section = matched.dataset.section
      ctx_.navigate('config', { section: ui.section })
      return
    }
    if (action === 'release') {
      const key = matched.dataset.key
      const sep = key.indexOf(':')
      const agent = key.slice(0, sep)
      const model = key.slice(sep + 1)
      ctx_.runAction(`release:${key}`, () => ctx_.api.clearOverride(agent, model))
    }
  })

  const handleKeydown = (event) => {
    if (!event.target.closest('[role="tab"]')) return
    if (event.key === 'ArrowRight') { event.preventDefault(); focusTab(1) }
    if (event.key === 'ArrowLeft') { event.preventDefault(); focusTab(-1) }
  }
  root.addEventListener('keydown', handleKeydown)
  els.offKeydown = () => root.removeEventListener('keydown', handleKeydown)
}

export function render(state) {
  if (!els) return
  renderTabs()
  renderSection(state.config)
}

export function unmount() {
  if (offClick) offClick()
  if (els && els.offKeydown) els.offKeydown()
  offClick = null
  els = null
  ctx_ = null
}
