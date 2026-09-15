// Running jobs view: queued + running jobs. The elapsed-time column is a
// plain [data-elapsed-since] span — app.js ticks it every second without a
// re-render, per contract; this module never touches it after mount.
import { h, on, clear } from '../ui/dom.js'
import { formatModel } from '../ui/format.js'
import { runningJobs, statusBadge } from '../ui/badges.js'
import { icon } from '../ui/icons.js'

let ctx_ = null
let els = null
let offClick = null

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

function renderTable(state) {
  clear(els.tableWrap)
  const jobs = runningJobs(state)

  if (!jobs.length) {
    els.tableWrap.append(h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-title', text: 'No running jobs' }),
      h('div', { class: 'empty-hint', text: 'Trigger delegation tasks through your MCP client (delegate) to see them here' }),
    ]))
    return
  }

  const table = h('table', { class: 'table table-dense' })
  const thead = h('thead', {}, [
    h('tr', {}, ['Agent & model', 'Task', 'Status', 'Mode', 'Elapsed', 'Actions'].map((t) => h('th', { text: t }))),
  ])
  const tbody = h('tbody')

  for (const j of jobs) {
    const agentCell = h('td', {}, [
      h('div', {}, [h('strong', { text: j.agent })]),
      h('div', { class: 'muted', title: j.model, text: formatModel(j.model) }),
    ])
    if (j.variant) agentCell.append(h('span', { class: 'tag', title: 'reasoning effort', text: j.variant }))

    const taskCell = h('td', {}, [
      h('div', { class: 'cell-truncate', title: j.title || '', text: j.title || 'Untitled job' }),
    ])
    if (j.parentJobId) {
      taskCell.append(h('div', {
        class: 'muted', title: `Reply to job ${j.parentJobId}`,
        text: `↳ reply of …${String(j.parentJobId).slice(-8)}`,
      }))
    }

    const elapsed = h('span', { class: 'cell-mono' })
    elapsed.dataset.elapsedSince = j.createdAt || ''
    elapsed.textContent = '—'

    const cancelBtn = h('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Cancel' })
    cancelBtn.dataset.action = 'cancel'
    cancelBtn.dataset.jobId = j.jobId
    cancelBtn.dataset.busyKey = `cancel:${j.jobId}`

    tbody.append(h('tr', {}, [
      agentCell,
      taskCell,
      h('td', {}, [badgeEl(statusBadge(j.status))]),
      h('td', { text: j.mode || '—' }),
      h('td', {}, [elapsed]),
      h('td', { class: 'cell-actions' }, [cancelBtn]),
    ]))
  }

  table.append(thead, tbody)
  els.tableWrap.append(table)
}

export function mount(root, ctx) {
  ctx_ = ctx
  const header = h('header', { class: 'view-header' }, [
    h('h1', { id: 'view-title', class: 'view-title', tabindex: '-1', text: 'Running jobs' }),
  ])
  const tableWrap = h('div', { class: 'table-wrap' })
  root.append(header, tableWrap)
  els = { tableWrap }

  offClick = on(root, 'click', '[data-action="cancel"]', async (event, matched) => {
    const jobId = matched.dataset.jobId
    const ok = await ctx_.confirm({
      title: 'Cancel this job?',
      body: 'This stops the running job and marks it canceled.',
      confirmLabel: 'Cancel job',
      danger: true,
    })
    if (!ok) return
    ctx_.runAction(`cancel:${jobId}`, () => ctx_.api.cancelJob(jobId))
  })
}

export function render(state) {
  if (!els) return
  renderTable(state)
}

export function unmount() {
  if (offClick) offClick()
  offClick = null
  els = null
  ctx_ = null
}
