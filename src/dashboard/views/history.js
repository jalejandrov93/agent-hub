// Job history view: terminal jobs (succeeded/failed/canceled), newest first
// by updatedAt. Ported from dashboard.html renderJobHistory (reply hint,
// errorBadge, tokens/session) plus new status/agent filters and a detail panel.
import { h, on, clear } from '../ui/dom.js'
import { formatModel, formatNumber, formatAge } from '../ui/format.js'
import { statusBadge, errorBadge } from '../ui/badges.js'
import { icon } from '../ui/icons.js'

const STATUS_CHIPS = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'succeeded', label: 'Succeeded' },
]

let ctx_ = null
let els = null
let offClick = null
let ui = { status: 'all', agent: '', search: '', selectedId: null }

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

function isTerminal(status) {
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

function agentOptions(state) {
  const set = new Set(state.jobs.map((j) => j.agent).filter(Boolean))
  return ['', ...Array.from(set).sort()]
}

function matchesFilters(row) {
  if (ui.status !== 'all' && row.status !== ui.status) return false
  if (ui.agent && row.agent !== ui.agent) return false
  if (ui.search) {
    const q = ui.search.toLowerCase()
    const haystack = [row.title || '', row.model, row.error || ''].join(' ').toLowerCase()
    if (haystack.indexOf(q) === -1) return false
  }
  return true
}

function renderChips() {
  clear(els.chips)
  for (const c of STATUS_CHIPS) {
    const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(ui.status === c.value), text: c.label })
    chip.dataset.action = 'status'
    chip.dataset.status = c.value
    els.chips.append(chip)
  }
}

function renderAgentSelect(state) {
  clear(els.agentSelect)
  for (const a of agentOptions(state)) {
    const opt = h('option', { value: a, text: a || 'All agents' })
    if (a === ui.agent) opt.selected = true
    els.agentSelect.append(opt)
  }
}

function closeDetail() {
  ui.selectedId = null
  if (els) { clear(els.detail); els.detail.hidden = true }
}

function openDetail(row) {
  clear(els.detail)
  els.detail.hidden = false
  const closeBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Close detail panel' })
  closeBtn.dataset.action = 'close-detail'
  closeBtn.innerHTML = icon('close')
  const header = h('div', { class: 'detail-header' }, [
    h('h3', { text: row.title || 'Untitled job' }),
    closeBtn,
  ])
  const kv = h('dl', { class: 'kv' })
  const entries = [
    ['Job id', row.jobId],
    ['Session id', row.sessionId || '—'],
    ['Cwd', row.cwd || '—'],
    ['Mode', row.mode || '—'],
    ['Error kind', row.errorKind || '—'],
    ['Error', row.error || '—'],
    ['Tokens', row.tokens != null ? formatNumber(row.tokens) : '—'],
    ['Cost (USD)', row.costUsd != null ? row.costUsd.toFixed(4) : '—'],
    ['Created at', row.createdAt || '—'],
    ['Updated at', row.updatedAt || '—'],
  ]
  for (const [label, value] of entries) kv.append(h('dt', { text: label }), h('dd', { text: value }))
  els.detail.append(header, h('div', { class: 'detail-body' }, [kv]))
  els.detail.tabIndex = -1
  els.detail.focus()
}

function renderTable(state) {
  clear(els.tableWrap)
  const rows = state.jobs
    .filter((j) => isTerminal(j.status) && matchesFilters(j))
    .slice()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))

  if (!rows.length) {
    els.tableWrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'No finished jobs yet' }),
      h('div', { class: 'empty-hint', text: 'Succeeded, failed and canceled jobs will show up here' }),
    ]))
    return
  }

  const table = h('table', { class: 'table table-dense' })
  const thead = h('thead', {}, [
    h('tr', {}, ['Agent & model', 'Task', 'Status', 'Error', 'Tokens', 'Updated'].map((t) => h('th', { text: t }))),
  ])
  const tbody = h('tbody')

  for (const j of rows) {
    const agentCell = h('td', {}, [
      h('div', {}, [h('strong', { text: j.agent })]),
      h('div', { class: 'muted', title: j.model, text: formatModel(j.model) }),
    ])
    const taskCell = h('td', {}, [h('div', { class: 'cell-truncate', title: j.title || '', text: j.title || 'Untitled job' })])
    if (j.parentJobId) {
      taskCell.append(h('div', {
        class: 'muted', title: `Reply to job ${j.parentJobId}`,
        text: `↳ reply of …${String(j.parentJobId).slice(-8)}`,
      }))
    }
    const errorCell = j.errorKind
      ? h('td', {}, [badgeEl(errorBadge(j.errorKind))])
      : h('td', {}, [h('span', { class: 'muted', text: '—' })])
    const tr = h('tr', { class: 'is-clickable' }, [
      agentCell, taskCell,
      h('td', {}, [badgeEl(statusBadge(j.status))]),
      errorCell,
      h('td', { class: 'num', text: j.tokens != null ? formatNumber(j.tokens) : '—' }),
      h('td', { text: formatAge(j.updatedAt) }),
    ])
    tr.dataset.action = 'row'
    tr.dataset.jobId = j.jobId
    if (ui.selectedId === j.jobId) tr.classList.add('is-selected')
    tbody.append(tr)
  }

  table.append(thead, tbody)
  els.tableWrap.append(table)
}

export function mount(root, ctx) {
  ctx_ = ctx
  ui = { status: ctx.route.query.status || 'all', agent: ctx.route.query.agent || '', search: '', selectedId: null }

  const header = h('header', { class: 'view-header' }, [
    h('h1', { id: 'view-title', class: 'view-title', tabindex: '-1', text: 'Job history' }),
  ])
  const chips = h('div', { class: 'chips', role: 'tablist' })
  const agentSelect = h('select', { class: 'select', 'aria-label': 'Filter by agent' })
  const searchInput = h('input', { type: 'search', class: 'search-input', placeholder: 'Search title, model or error', 'aria-label': 'Search history' })
  const toolbar = h('div', { class: 'row gap-md' }, [chips, agentSelect, h('div', { class: 'search' }, [searchInput])])
  const tableWrap = h('div', { class: 'table-wrap' })
  const detail = h('div', { class: 'detail-panel', hidden: 'true' })

  root.append(header, toolbar, tableWrap, detail)
  els = { chips, agentSelect, tableWrap, detail }

  offClick = on(root, 'click', '[data-action]', (event, matched) => {
    const action = matched.dataset.action
    if (action === 'status') {
      ui.status = matched.dataset.status
      ctx_.navigate('history', { status: ui.status === 'all' ? undefined : ui.status, agent: ui.agent || undefined })
      return
    }
    if (action === 'close-detail') { closeDetail(); return }
    if (action === 'row') {
      const jobId = matched.dataset.jobId
      ui.selectedId = ui.selectedId === jobId ? null : jobId
      if (!ui.selectedId) { closeDetail(); return }
      const row = ctx_.store.getState().jobs.find((j) => j.jobId === jobId)
      if (row) openDetail(row)
      render(ctx_.store.getState())
    }
  })

  agentSelect.addEventListener('change', () => {
    ui.agent = agentSelect.value
    ctx_.navigate('history', { status: ui.status === 'all' ? undefined : ui.status, agent: ui.agent || undefined })
  })

  searchInput.addEventListener('input', () => {
    ui.search = searchInput.value
    render(ctx_.store.getState())
  })

  const handleKeydown = (event) => { if (event.key === 'Escape' && ui.selectedId) closeDetail() }
  root.addEventListener('keydown', handleKeydown)
  els.offKeydown = () => root.removeEventListener('keydown', handleKeydown)
}

export function render(state) {
  if (!els) return
  renderChips()
  renderAgentSelect(state)
  renderTable(state)
}

export function unmount() {
  if (offClick) offClick()
  if (els && els.offKeydown) els.offKeydown()
  offClick = null
  els = null
  ctx_ = null
}
