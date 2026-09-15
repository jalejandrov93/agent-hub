// Agents view: grouped-by-CLI table with filter chips, search, a row menu
// per agent/model pair and a detail panel. Ported 1:1 from the legacy
// #agents panel plus the unresolved-CLI banner text (dashboard.html
// renderAgents/unresolvedAgents), now split across CLI groups.
import { h, on, clear } from '../ui/dom.js'
import { formatModel, formatNumber, formatAge, formatLatency } from '../ui/format.js'
import {
  overrideFor, breakerFor, isUnhealthy, unhealthyAgents, heldPairs,
  openBreakers, unresolvedAgents, statusBadge,
} from '../ui/badges.js'
import { icon } from '../ui/icons.js'

const CHIPS = [
  { value: 'all', label: 'All' },
  { value: 'unhealthy', label: 'Unhealthy' },
  { value: 'held', label: 'Held' },
  { value: 'breaker', label: 'Breaker open' },
]

let ctx_ = null
let els = null
let offClick = null
let offKeydown = null
let closeMenu = null
let ui = { filter: 'all', search: '', selectedKey: null }

function badgeEl({ label, tone, icon: iconName }) {
  const span = h('span', { class: `badge tone-${tone}` })
  if (iconName) {
    const i = h('span', { class: 'badge-icon', 'aria-hidden': 'true' })
    i.innerHTML = icon(iconName)
    span.append(i)
  }
  span.append(h('span', { text: label }))
  return span
}

function matchesFilter(state, row) {
  const override = overrideFor(state, row.agent, row.model)
  const breaker = breakerFor(state, row.agent, row.model)
  if (ui.filter === 'unhealthy') return isUnhealthy(state, row)
  if (ui.filter === 'held') return !!(override && override.hold)
  if (ui.filter === 'breaker') return !!(breaker && breaker.open)
  return true
}

function matchesSearch(row) {
  if (!ui.search) return true
  const q = ui.search.toLowerCase()
  const haystack = [row.agent, row.model, row.reason || ''].join(' ').toLowerCase()
  return haystack.indexOf(q) !== -1
}

function renderChips(state) {
  clear(els.chips)
  const counts = {
    all: state.agents.length,
    unhealthy: unhealthyAgents(state).length,
    held: heldPairs(state).length,
    breaker: openBreakers(state).length,
  }
  for (const c of CHIPS) {
    const chip = h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(ui.filter === c.value),
    })
    chip.dataset.action = 'filter'
    chip.dataset.filter = c.value
    chip.append(h('span', { text: c.label }), h('span', { class: 'tag', text: String(counts[c.value]) }))
    els.chips.append(chip)
  }
}

function renderBanner(state) {
  clear(els.banner)
  const missing = unresolvedAgents(state)
  if (!missing.length) return
  els.banner.append(h('div', { class: 'callout callout-warn', role: 'alert' }, [
    h('strong', { text: `The dashboard process cannot find: ${missing.join(', ')}.` }),
    h('span', {
      text: ' These CLIs are not on this process’s own PATH, so Revalidate/Ping here would only poison the cached status instead of refreshing it. '
        + 'Put PATH=... in ~/.config/agent-hub/env and restart the agent-hub-dashboard systemd unit, then check the Config panel.',
    }),
  ]))
}

function groupByCli(rows) {
  const order = []
  const groups = new Map()
  for (const row of rows) {
    if (!groups.has(row.agent)) { groups.set(row.agent, []); order.push(row.agent) }
    groups.get(row.agent).push(row)
  }
  return order.map((agent) => ({ agent, rows: groups.get(agent) }))
}

/** Group header parts: only what's actually known, joined by the caller with ' · '. */
function groupHeaderParts(state, agent, first, rowCount) {
  const resolvedBins = state.config && state.config.process ? state.config.process.resolvedBins : undefined
  const parts = []
  if (first.cliVersion) parts.push(`v${first.cliVersion}`)
  const bin = first.binPath || (resolvedBins ? resolvedBins[agent] : null)
  if (bin) {
    parts.push(bin)
  } else if (resolvedBins && Object.prototype.hasOwnProperty.call(resolvedBins, agent) && resolvedBins[agent] === null) {
    parts.push('not on dashboard PATH')
  }
  parts.push(`${rowCount} model${rowCount === 1 ? '' : 's'}`)
  return parts
}

function closeDetail() {
  ui.selectedKey = null
  if (els) { clear(els.detail); els.detail.hidden = true }
}

function openDetail(state, row) {
  const panel = els.detail
  clear(panel)
  panel.hidden = false
  const breaker = breakerFor(state, row.agent, row.model)
  const override = overrideFor(state, row.agent, row.model)
  const discovery = state.config && state.config.discovery ? state.config.discovery[row.agent] : null

  const closeBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Close detail panel' })
  closeBtn.dataset.action = 'close-detail'
  closeBtn.innerHTML = icon('close')

  const header = h('div', { class: 'detail-header' }, [
    h('h3', { text: `${row.agent} / ${formatModel(row.model)}` }),
    closeBtn,
  ])

  const kv = h('dl', { class: 'kv' })
  const entries = [
    ['Reason', row.reason || '—'],
    ['Ladder level', row.ladderLevel || '—'],
    ['Latency', formatLatency(row.latencyMs)],
    ['Quota signal', row.quotaSignal || '—'],
    ['Data policy', row.dataPolicy || '—'],
    ['Bin path', row.binPath || '—'],
    ['CLI version', row.cliVersion || '—'],
    ['Discovery models', discovery ? String(discovery.models.length) : '—'],
    ['Discovery error', discovery && discovery.error ? discovery.error : '—'],
    ['Breaker failures', breaker ? String(breaker.failureCount) : '0'],
    ['Breaker last failure', breaker ? formatAge(breaker.lastFailureAt) : '—'],
    ['Hold', override && override.hold ? 'yes' : 'no'],
    ['Override set at', override ? formatAge(override.setAt) : '—'],
    ['Breaker reset at', override && override.breakerReset ? override.breakerReset : '—'],
  ]
  for (const [label, value] of entries) kv.append(h('dt', { text: label }), h('dd', { text: value }))

  panel.append(header, h('div', { class: 'detail-body' }, [kv]))
  panel.tabIndex = -1
  panel.focus()
}

function menuItemsFor(state, row) {
  const missing = unresolvedAgents(state)
  const isUnresolved = missing.indexOf(row.agent) !== -1
  const breaker = breakerFor(state, row.agent, row.model)
  const override = overrideFor(state, row.agent, row.model)
  const held = !!(override && override.hold)
  const items = []

  items.push({
    label: 'Revalidate',
    disabled: isUnresolved,
    title: isUnresolved ? `the dashboard process cannot find "${row.agent}" on its own PATH` : undefined,
    onSelect: () => ctx_.runAction(`refresh:${row.agent}:${row.model}`, () => ctx_.api.refreshAgents({ agent: row.agent, model: row.model })),
  })

  if (row.status === 'degraded' || row.status === 'unavailable') {
    items.push({
      label: 'Ping (L3)',
      disabled: isUnresolved,
      title: isUnresolved ? `the dashboard process cannot find "${row.agent}" on its own PATH` : 'sends a real prompt and spends quota',
      danger: true,
      onSelect: async () => {
        const ok = await ctx_.confirm({
          title: 'Ping this agent?',
          body: `This sends a real prompt to ${row.agent} / ${formatModel(row.model)} and spends quota (L3).`,
          confirmLabel: 'Ping',
          danger: true,
        })
        if (!ok) return
        return ctx_.runAction(`ping:${row.agent}:${row.model}`, () => ctx_.api.refreshAgents({ agent: row.agent, model: row.model, ping: true }))
      },
    })
  }

  items.push({
    label: held ? 'Release' : 'Hold',
    onSelect: () => ctx_.runAction(`hold:${row.agent}:${row.model}`, () => (
      held
        ? ctx_.api.clearOverride(row.agent, row.model)
        : ctx_.api.setOverride({ agent: row.agent, model: row.model, hold: true })
    )),
  })

  if (breaker && breaker.open) {
    items.push({
      label: 'Reset breaker',
      danger: true,
      onSelect: async () => {
        const ok = await ctx_.confirm({
          title: 'Reset breaker?',
          body: `Clears the open breaker for ${row.agent} / ${formatModel(row.model)}.`,
          confirmLabel: 'Reset breaker',
          danger: true,
        })
        if (!ok) return
        return ctx_.runAction(`reset-breaker:${row.agent}:${row.model}`, () => ctx_.api.setOverride({ agent: row.agent, model: row.model, breakerReset: true }))
      },
    })
  }

  return items
}

function renderTable(state) {
  clear(els.tableWrap)
  const rows = state.agents.filter((r) => matchesFilter(state, r) && matchesSearch(r))

  if (!rows.length) {
    els.tableWrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'No matching agents' }),
      h('div', { class: 'empty-hint', text: 'Adjust the filter or search, or run Revalidate all / Rediscover above' }),
    ]))
    return
  }

  const table = h('table', { class: 'table table-dense' })
  const thead = h('thead', {}, [
    h('tr', {}, ['Model', 'Status', 'Ladder', 'Latency', 'Data policy', 'Checked', 'Tags', 'Actions'].map((t) => h('th', { text: t }))),
  ])
  const tbody = h('tbody')

  for (const group of groupByCli(rows)) {
    const first = group.rows[0]
    const parts = groupHeaderParts(state, group.agent, first, group.rows.length)
    tbody.append(h('tr', { class: 'group-row' }, [
      h('td', { colspan: '8' }, [
        h('strong', { text: group.agent }),
        h('span', { class: 'muted', text: ` · ${parts.join(' · ')}` }),
      ]),
    ]))

    for (const row of group.rows) {
      const key = `${row.agent}:${row.model}`
      const breaker = breakerFor(state, row.agent, row.model)
      const override = overrideFor(state, row.agent, row.model)
      const sb = statusBadge(row.status)

      const statusCell = h('td')
      statusCell.append(badgeEl(sb))
      if (row.reason) statusCell.append(h('div', { class: 'muted cell-truncate', title: row.reason, text: row.reason }))

      const tagsCell = h('td')
      if (breaker && breaker.open) tagsCell.append(h('span', { class: 'tag', title: `${breaker.failureCount} failure(s)`, text: 'breaker open' }))
      if (override && override.hold) tagsCell.append(h('span', { class: 'tag', text: 'held' }))
      if (!tagsCell.childNodes.length) tagsCell.append(h('span', { class: 'muted', text: '—' }))

      const menuBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': `More actions for ${row.agent} ${row.model}` })
      menuBtn.dataset.action = 'menu'
      menuBtn.innerHTML = icon('more')

      const tr = h('tr', { class: 'is-clickable' }, [
        h('td', {}, [h('span', { title: row.model, text: formatModel(row.model) })]),
        statusCell,
        h('td', { text: row.ladderLevel || '—' }),
        h('td', { class: 'num', text: formatLatency(row.latencyMs) }),
        h('td', { text: row.dataPolicy || '—' }),
        h('td', { text: formatAge(row.checkedAt) }),
        tagsCell,
        h('td', { class: 'cell-actions' }, [menuBtn]),
      ])
      tr.dataset.action = 'row'
      tr.dataset.agentKey = key
      if (ui.selectedKey === key) tr.classList.add('is-selected')
      tbody.append(tr)
    }
  }

  table.append(thead, tbody)
  els.tableWrap.append(table)
}

export function mount(root, ctx) {
  ctx_ = ctx
  ui = { filter: ctx.route.query.filter || 'all', search: '', selectedKey: null }

  const revalidateAllBtn = h('button', { type: 'button', id: 'btn-revalidate-all', class: 'btn btn-primary', text: 'Revalidate all' })
  revalidateAllBtn.dataset.action = 'revalidate-all'
  revalidateAllBtn.dataset.busyKey = 'agents:revalidate-all'
  const rediscoverBtn = h('button', { type: 'button', id: 'btn-rediscover', class: 'btn btn-ghost', text: 'Rediscover' })
  rediscoverBtn.dataset.action = 'rediscover'
  rediscoverBtn.dataset.busyKey = 'agents:rediscover'

  const header = h('header', { class: 'view-header' }, [
    h('h1', { id: 'view-title', class: 'view-title', tabindex: '-1', text: 'Agents' }),
    h('div', { class: 'view-actions' }, [revalidateAllBtn, rediscoverBtn]),
  ])

  const banner = h('div', { class: 'banner-slot' })
  const chips = h('div', { class: 'chips', role: 'tablist' })
  const searchInput = h('input', { type: 'search', class: 'search-input', placeholder: 'Search agent, model or reason', 'aria-label': 'Search agents' })
  const toolbar = h('div', { class: 'row gap-md' }, [chips, h('div', { class: 'search' }, [searchInput])])
  const tableWrap = h('div', { class: 'table-wrap' })
  const detail = h('div', { class: 'detail-panel', hidden: 'true' })

  root.append(header, banner, toolbar, tableWrap, detail)
  els = { banner, chips, search: searchInput, tableWrap, detail }

  // One delegated click listener drives every interactive element in this
  // view (chips, row-open, menu toggle, detail close); it is registered
  // once in mount and never re-attached by render().
  offClick = on(root, 'click', '[data-action]', (event, matched) => {
    const state = ctx_.store.getState()
    const action = matched.dataset.action
    if (action === 'filter') {
      ui.filter = matched.dataset.filter
      ctx_.navigate('agents', { filter: ui.filter === 'all' ? undefined : ui.filter })
      return
    }
    if (action === 'revalidate-all') { ctx_.runAction('agents:revalidate-all', () => ctx_.api.refreshAgents({})); return }
    if (action === 'rediscover') { ctx_.runAction('agents:rediscover', () => ctx_.api.refreshDiscovery()); return }
    if (action === 'close-detail') { closeDetail(); return }
    if (action === 'menu') {
      event.stopPropagation()
      const tr = matched.closest('tr[data-agent-key]')
      const key = tr.dataset.agentKey
      const sep = key.indexOf(':')
      const row = state.agents.find((r) => r.agent === key.slice(0, sep) && r.model === key.slice(sep + 1))
      if (closeMenu) closeMenu()
      if (row) closeMenu = ctx_.openRowMenu(matched, menuItemsFor(state, row))
      return
    }
    if (action === 'row') {
      const key = matched.dataset.agentKey
      ui.selectedKey = ui.selectedKey === key ? null : key
      if (!ui.selectedKey) { closeDetail(); return }
      const sep = key.indexOf(':')
      const row = state.agents.find((r) => r.agent === key.slice(0, sep) && r.model === key.slice(sep + 1))
      if (row) openDetail(state, row)
      render(state)
    }
  })

  const handleKeydown = (event) => { if (event.key === 'Escape' && ui.selectedKey) closeDetail() }
  root.addEventListener('keydown', handleKeydown)
  offKeydown = () => root.removeEventListener('keydown', handleKeydown)

  searchInput.addEventListener('input', () => {
    ui.search = searchInput.value
    render(ctx_.store.getState())
  })
}

export function render(state) {
  if (!els) return
  renderBanner(state)
  renderChips(state)
  renderTable(state)
}

export function unmount() {
  if (offClick) offClick()
  if (offKeydown) offKeydown()
  if (closeMenu) closeMenu()
  offClick = null
  offKeydown = null
  closeMenu = null
  els = null
  ctx_ = null
}
