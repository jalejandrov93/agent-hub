// Claude subagents view: subagent.stop events, newest first. Ported from
// dashboard.html renderSubagents (title/model/summary/tokens columns).
import { h, clear } from '../ui/dom.js'
import { formatModel, formatNumber, formatAge } from '../ui/format.js'

let els = null

function renderTable(state) {
  clear(els.tableWrap)
  const stops = state.subagents.filter((e) => e.kind === 'subagent.stop').slice(-20).reverse()

  if (!stops.length) {
    els.tableWrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'No subagent activity recorded' }),
      h('div', {
        class: 'empty-hint',
        text: 'Claude Code SubagentStart/Stop hooks will stream lifecycle events here when active',
      }),
    ]))
    return
  }

  const table = h('table', { class: 'table table-dense' })
  const thead = h('thead', {}, [
    h('tr', {}, ['Title', 'Model', 'Summary', 'Tokens', 'Age'].map((t) => h('th', { text: t }))),
  ])
  const tbody = h('tbody')
  for (const e of stops) {
    tbody.append(h('tr', {}, [
      h('td', {}, [h('strong', { text: e.title || 'subagent' })]),
      h('td', { title: e.model || '', text: formatModel(e.model) }),
      h('td', { class: 'cell-truncate', title: e.summary || '', text: e.summary || '—' }),
      h('td', { class: 'num', text: e.tokens != null ? formatNumber(e.tokens) : '—' }),
      h('td', { text: formatAge(e.ts) }),
    ]))
  }
  table.append(thead, tbody)
  els.tableWrap.append(table)
}

export function mount(root) {
  const header = h('header', { class: 'view-header' }, [
    h('h1', { id: 'view-title', class: 'view-title', tabindex: '-1', text: 'Claude subagents' }),
  ])
  const tableWrap = h('div', { class: 'table-wrap' })
  root.append(header, tableWrap)
  els = { tableWrap }
}

export function render(state) {
  if (!els) return
  renderTable(state)
}

export function unmount() {
  els = null
}
