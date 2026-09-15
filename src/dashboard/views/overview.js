// Overview: needs-attention summary. No filters of its own — every number
// here is a link into the view that owns the underlying filter, so this
// stays a dashboard of pointers rather than a second copy of the data.
import { h, on, clear } from '../ui/dom.js'
import { formatAge } from '../ui/format.js'
import {
  unhealthyAgents, openBreakers, heldPairs, unresolvedAgents,
  runningJobs, failedJobsSince, errorBadge,
} from '../ui/badges.js'

const DAY_MS = 24 * 60 * 60 * 1000

let els = null
let offListener = null

function badgeEl(tone, label) {
  return h('span', { class: `badge tone-${tone}`, text: label })
}

function kpiCard({ route, query, label, value, hint }) {
  const card = h('a', { class: 'kpi-card', href: `#/${route}` })
  card.dataset.route = route
  if (query) card.dataset.query = JSON.stringify(query)
  card.append(
    h('span', { class: 'kpi-label', text: label }),
    h('span', { class: 'kpi-value', text: value }),
  )
  if (hint) card.append(h('span', { class: 'kpi-hint', text: hint }))
  return card
}

function attentionItem({ route, query, tone, text }) {
  const item = h('a', { class: `attention-item tone-${tone}`, href: `#/${route}` })
  item.dataset.route = route
  if (query) item.dataset.query = JSON.stringify(query)
  item.append(h('span', { text }))
  return item
}

export function mount(root, ctx) {
  const header = h('header', { class: 'view-header' }, [
    h('h1', { id: 'view-title', class: 'view-title', tabindex: '-1', text: 'Overview' }),
  ])
  const kpiGrid = h('div', { class: 'kpi-grid' })
  const attentionSection = h('section', { class: 'section' }, [
    h('h2', { class: 'section-title', text: 'Needs attention' }),
    h('div', { class: 'attention-list' }),
  ])
  const activitySection = h('section', { class: 'section' }, [
    h('h2', { class: 'section-title', text: 'Recent activity' }),
    h('div', { class: 'table-wrap' }),
  ])

  root.append(header, kpiGrid, attentionSection, activitySection)

  els = {
    kpiGrid,
    attentionList: attentionSection.querySelector('.attention-list'),
    activityWrap: activitySection.querySelector('.table-wrap'),
  }

  offListener = on(root, 'click', 'a[data-route]', (event, matched) => {
    event.preventDefault()
    const query = matched.dataset.query ? JSON.parse(matched.dataset.query) : undefined
    ctx.navigate(matched.dataset.route, query)
  })
}

export function render(state) {
  if (!els) return
  const now = Date.now()

  const totalAgents = state.agents.length
  const unhealthy = unhealthyAgents(state)
  const healthy = totalAgents - unhealthy.length
  const running = runningJobs(state)
  const failed24h = failedJobsSince(state, DAY_MS, now)
  const breakers = openBreakers(state)
  const holds = heldPairs(state)
  const unresolved = unresolvedAgents(state)

  clear(els.kpiGrid)
  els.kpiGrid.append(
    kpiCard({
      route: 'agents', query: { filter: 'unhealthy' },
      label: 'Agents healthy', value: totalAgents ? `${healthy} / ${totalAgents}` : '0',
      hint: unhealthy.length ? `${unhealthy.length} need attention` : 'all healthy',
    }),
    kpiCard({ route: 'jobs', label: 'Running jobs', value: String(running.length) }),
    kpiCard({
      route: 'history', query: { status: 'failed' },
      label: 'Failed (24h)', value: String(failed24h.length),
    }),
    kpiCard({
      route: 'agents', query: { filter: 'breaker' },
      label: 'Breakers open', value: String(breakers.length),
    }),
    kpiCard({
      route: 'agents', query: { filter: 'held' },
      label: 'Holds', value: String(holds.length),
    }),
    kpiCard({
      route: 'config', query: { section: 'process' },
      label: 'Unresolved CLIs', value: String(unresolved.length),
    }),
  )

  clear(els.attentionList)
  const items = []
  for (const a of unhealthy) {
    items.push(attentionItem({
      route: 'agents', query: { filter: 'unhealthy' }, tone: 'degraded',
      text: `${a.agent} / ${a.model}: ${a.reason || a.status}`,
    }))
  }
  for (const b of breakers) {
    items.push(attentionItem({
      route: 'agents', query: { filter: 'breaker' }, tone: 'unavailable',
      text: `Breaker open: ${b.agent} / ${b.model} (${b.failureCount} failure(s))`,
    }))
  }
  for (const j of failed24h) {
    const wrap = attentionItem({
      route: 'history', query: { status: 'failed' }, tone: 'unavailable',
      text: `${j.title || 'Untitled job'} `,
    })
    const eb = errorBadge(j.errorKind)
    wrap.append(badgeEl(eb.tone, eb.label))
    items.push(wrap)
  }
  for (const agent of unresolved) {
    items.push(attentionItem({
      route: 'config', query: { section: 'process' }, tone: 'degraded',
      text: `${agent} is not on the dashboard process PATH`,
    }))
  }

  if (!items.length) {
    els.attentionList.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'All clear' }),
      h('div', { class: 'empty-hint', text: 'No unhealthy agents, open breakers, recent failures or unresolved CLIs' }),
    ]))
  } else {
    els.attentionList.append(...items)
  }

  clear(els.activityWrap)
  const recent = state.events.slice(-10).reverse()
  if (!recent.length) {
    els.activityWrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'No activity yet' }),
      h('div', { class: 'empty-hint', text: 'Hub and hook events will appear here as they happen' }),
    ]))
  } else {
    const table = h('table', { class: 'table table-dense' })
    const thead = h('thead', {}, [
      h('tr', {}, [
        h('th', { text: 'Time' }), h('th', { text: 'Kind' }),
        h('th', { text: 'Agent' }), h('th', { text: 'Detail' }),
      ]),
    ])
    const tbody = h('tbody')
    for (const e of recent) {
      tbody.append(h('tr', {}, [
        h('td', { class: 'cell-mono', text: formatAge(e.ts, now) }),
        h('td', { text: e.kind }),
        h('td', { text: e.agent || '—' }),
        h('td', { class: 'cell-truncate', title: e.title || e.summary || '', text: e.title || e.summary || '—' }),
      ]))
    }
    table.append(thead, tbody)
    els.activityWrap.append(table)
  }
}

export function unmount() {
  if (offListener) offListener()
  offListener = null
  els = null
}
