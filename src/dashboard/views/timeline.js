// Timeline view: full event log with source/kind/search filters, newest
// first. Ported from dashboard.html renderFilters/renderTimeline. Marks the
// timeline seen (for the sidebar "unseen" badge) on mount and on every
// render, since staying on this view keeps consuming new events.
import { h, on, clear } from '../ui/dom.js'
import { formatAge } from '../ui/format.js'
import { errorBadge } from '../ui/badges.js'
import { markTimelineSeen } from '../store.js'

const SOURCE_CHIPS = [
  { value: 'all', label: 'All' },
  { value: 'hub', label: 'hub' },
  { value: 'claude-hook', label: 'claude-hook' },
]

let ctx_ = null
let els = null
let offClick = null
let ui = { source: 'all', kind: '', search: '' }

function badgeEl({ label, tone }) {
  return h('span', { class: `badge tone-${tone}`, text: label })
}

function presentKinds(state) {
  return Array.from(new Set(state.events.map((e) => e.kind).filter(Boolean))).sort()
}

function matchesFilters(e) {
  if (ui.source !== 'all' && e.source !== ui.source) return false
  if (ui.kind && e.kind !== ui.kind) return false
  if (ui.search) {
    const q = ui.search.toLowerCase()
    const haystack = [e.kind, e.agent, e.title, e.summary, e.source].filter(Boolean).join(' ').toLowerCase()
    if (haystack.indexOf(q) === -1) return false
  }
  return true
}

function renderChips() {
  clear(els.chips)
  for (const c of SOURCE_CHIPS) {
    const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(ui.source === c.value), text: c.label })
    chip.dataset.action = 'source'
    chip.dataset.source = c.value
    els.chips.append(chip)
  }
}

function renderKindSelect(state) {
  clear(els.kindSelect)
  els.kindSelect.append(h('option', { value: '', text: 'All kinds' }))
  for (const k of presentKinds(state)) els.kindSelect.append(h('option', { value: k, text: k }))
  els.kindSelect.value = ui.kind || ''
}

function renderTable(state) {
  clear(els.tableWrap)
  const rows = state.events.filter(matchesFilters).slice(-200).reverse()

  if (!rows.length) {
    els.tableWrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: ui.search ? 'No matching events found' : 'No events in event log' }),
      h('div', {
        class: 'empty-hint',
        text: ui.search ? 'Try clearing your search query' : 'System and hook events will stream here live',
      }),
    ]))
    return
  }

  const table = h('table', { class: 'table table-dense' })
  const thead = h('thead', {}, [
    h('tr', {}, ['Time', 'Source', 'Kind', 'Agent & model', 'Detail', 'Tokens'].map((t) => h('th', { text: t }))),
  ])
  const tbody = h('tbody')
  for (const e of rows) {
    const kindLabel = e.kind === 'preflight' && e.phase ? `${e.kind}:${e.phase}` : (e.kind || 'event')
    const kindCell = h('td', {}, [h('span', { class: 'tag', text: kindLabel })])
    if (e.kind === 'job.failed' && e.errorKind) kindCell.append(badgeEl(errorBadge(e.errorKind)))
    tbody.append(h('tr', {}, [
      h('td', { class: 'cell-mono', text: e.ts ? new Date(e.ts).toLocaleTimeString() : '—' }),
      h('td', { text: e.source || '—' }),
      kindCell,
      h('td', { title: e.model || '', text: [e.agent, e.model].filter(Boolean).join(' / ') || '—' }),
      h('td', { class: 'cell-truncate', title: e.title || e.summary || '', text: e.title || e.summary || '—' }),
      h('td', { class: 'num', text: e.tokens != null ? String(e.tokens) : '—' }),
    ]))
  }
  table.append(thead, tbody)
  els.tableWrap.append(table)
}

export function mount(root, ctx) {
  ctx_ = ctx
  ui = { source: 'all', kind: '', search: '' }

  const header = h('header', { class: 'view-header sticky-toolbar' }, [
    h('h1', { id: 'view-title', class: 'view-title', tabindex: '-1', text: 'Timeline' }),
  ])
  const chips = h('div', { class: 'chips', role: 'tablist' })
  const kindSelect = h('select', { class: 'select', 'aria-label': 'Filter by kind' })
  const searchInput = h('input', { type: 'search', class: 'search-input', placeholder: 'Search kind, agent, title or summary', 'aria-label': 'Search timeline' })
  const toolbar = h('div', { class: 'row gap-md sticky-toolbar' }, [chips, kindSelect, h('div', { class: 'search' }, [searchInput])])
  const tableWrap = h('div', { class: 'table-wrap' })

  root.append(header, toolbar, tableWrap)
  els = { chips, kindSelect, tableWrap }

  offClick = on(root, 'click', '[data-action="source"]', (event, matched) => {
    ui.source = matched.dataset.source
    render(ctx_.store.getState())
  })

  kindSelect.addEventListener('change', () => {
    ui.kind = kindSelect.value
    render(ctx_.store.getState())
  })

  searchInput.addEventListener('input', () => {
    ui.search = searchInput.value
    render(ctx_.store.getState())
  })

  markSeenIfNeeded(ctx_.store.getState())
}

function markSeenIfNeeded(state) {
  // setState always notifies subscribers (no equality check), and render()
  // is itself called on every store change — so this must be a no-op once
  // caught up, or mounting this view would loop forever.
  const newest = state.events.length ? state.events[state.events.length - 1].ts : null
  if (newest && newest !== state.lastSeenTimelineTs) {
    ctx_.store.setState((s) => markTimelineSeen(s))
  }
}

export function render(state) {
  if (!els) return
  renderChips()
  renderKindSelect(state)
  renderTable(state)
  markSeenIfNeeded(state)
}

export function unmount() {
  if (offClick) offClick()
  offClick = null
  els = null
  ctx_ = null
}
