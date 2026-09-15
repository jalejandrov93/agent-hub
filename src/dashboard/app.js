/**
 * Dashboard entry point: boot, routing, data/SSE wiring, and the small bits
 * of glue (theme, drawer, tickers, action runner) that don't belong in a
 * single view. `document`/`window` are only ever touched inside function
 * bodies, so this module imports cleanly under `node --test`; boot() itself
 * only runs when `typeof document !== 'undefined'` (see the bottom of file).
 */

import { ROUTES, NAV_GROUPS } from './contracts.js'
import { createStore, initialState, applyServerState, applyConfig, appendEvent, setConnection, setBusy, shouldRefetchState } from './store.js'
import * as api from './api.js'
import * as router from './router.js'
import { icon } from './ui/icons.js'
import { navBadges } from './ui/badges.js'
import { formatAge, elapsedSeconds, formatDuration } from './ui/format.js'
import { confirmDialog } from './ui/dialog.js'
import { openRowMenu } from './ui/menu.js'
import { clear } from './ui/dom.js'

const THEME_STORAGE_KEY = 'agent-hub:theme'
const POLL_INTERVAL_MS = 15000
const TICK_INTERVAL_MS = 1000
const SSE_DEBOUNCE_MS = 2000

/** Read the persisted theme choice; localStorage can throw (private mode, blocked storage), so this stays defensive. */
function loadTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // ignore: storage unavailable, fall back to system
  }
  return 'system'
}

function saveTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // ignore: storage unavailable, theme just won't persist across reloads
  }
}

/** 'system' removes the data-theme override so prefers-color-scheme decides. */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme
  } else {
    delete document.documentElement.dataset.theme
  }
}

/** Injects the inline SVG for every empty span.nav-icon[data-icon] in both navs. */
function injectNavIcons(root) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon)
  })
}

/** Clones #nav's group structure into the drawer sheet (kept in sync at boot; both stay static after that). */
function cloneNavIntoDrawer() {
  const nav = document.getElementById('nav')
  const sheet = document.querySelector('.drawer-sheet')
  if (!nav || !sheet) return
  clear(sheet)
  Array.from(nav.children).forEach((group) => {
    sheet.appendChild(group.cloneNode(true))
  })
  injectNavIcons(sheet)
}

function boot() {
  const store = createStore(initialState())
  const theme = loadTheme()
  store.setState({ theme })
  applyTheme(theme)

  const sidebar = document.getElementById('sidebar')
  if (sidebar) injectNavIcons(sidebar)
  cloneNavIntoDrawer()

  function announce(message) {
    const region = document.getElementById('live-region')
    if (region) region.textContent = message
  }

  function showToast(message, tone = 'unavailable') {
    const region = document.getElementById('toast-region')
    if (!region) return
    const toast = document.createElement('div')
    toast.className = `toast tone-${tone}`
    toast.textContent = message
    region.appendChild(toast)
    setTimeout(() => toast.remove(), 6000)
  }

  async function refresh() {
    try {
      const [stateSnapshot, config] = await Promise.all([api.fetchState(), api.fetchConfig()])
      store.setState((s) => applyServerState(s, stateSnapshot, Date.now()))
      store.setState((s) => applyConfig(s, config))
    } catch {
      // transient failure — the next SSE/poll/manual refresh will catch up
    }
  }

  function runAction(key, fn) {
    store.setState((s) => setBusy(s, key, true))
    const targets = document.querySelectorAll(`[data-busy-key="${key}"]`)
    targets.forEach((el) => {
      el.setAttribute('aria-busy', 'true')
      el.disabled = true
    })
    return fn()
      .catch((error) => {
        showToast(error && error.message ? error.message : 'Action failed', 'unavailable')
      })
      .finally(() => {
        store.setState((s) => setBusy(s, key, false))
        targets.forEach((el) => {
          el.removeAttribute('aria-busy')
          el.disabled = false
        })
        return refresh()
      })
  }

  const ctx = {
    store,
    api,
    route: router.parseHash(window.location.hash),
    navigate: router.navigate,
    confirm: confirmDialog,
    openRowMenu,
    announce,
    refresh,
    runAction,
  }

  let currentView = null

  function updateNavCurrent(name) {
    document.querySelectorAll('.nav-item').forEach((el) => {
      if (el.dataset.route === name) el.setAttribute('aria-current', 'page')
      else el.removeAttribute('aria-current')
    })
  }

  async function mountRoute(route) {
    ctx.route = route
    const main = document.getElementById('main-content')
    if (!main) return
    if (currentView && typeof currentView.unmount === 'function') {
      try {
        currentView.unmount()
      } catch {
        // a view's cleanup failing must not block navigating away from it
      }
    }
    clear(main)
    const section = document.createElement('section')
    section.className = 'view'
    section.dataset.view = route.name
    section.setAttribute('aria-labelledby', 'view-title')
    main.appendChild(section)

    let mod
    try {
      mod = await import(`./views/${route.name}.js`)
    } catch {
      section.innerHTML = '<div class="callout callout-warn">view unavailable</div>'
      currentView = null
      return
    }

    currentView = mod
    mod.mount(section, ctx)
    mod.render(store.getState())

    updateNavCurrent(route.name)
    const meta = ROUTES[route.name]
    const title = document.getElementById('topbar-title')
    if (title) title.textContent = meta.label
    document.title = `${meta.label} — agent-hub dashboard`
    const heading = document.getElementById('view-title')
    if (heading) heading.focus()
    announce(`${meta.label} view`)
  }

  function renderNavBadges(state) {
    const badges = navBadges(state)
    document.querySelectorAll('.nav-badge[data-badge]').forEach((el) => {
      const entry = badges[el.dataset.badge]
      el.className = 'nav-badge' + (entry ? ` tone-${entry.tone}` : '')
      el.hidden = !entry
      el.textContent = entry ? String(entry.count) : ''
    })
  }

  const CONN_TEXT = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' }
  const CONN_TONE = { connecting: 'degraded', live: 'ready', reconnecting: 'degraded', offline: 'unavailable' }

  function renderConnBadge(state) {
    const badgeEl = document.getElementById('conn-badge')
    if (!badgeEl) return
    badgeEl.textContent = CONN_TEXT[state.connection] || CONN_TEXT.connecting
    badgeEl.className = `badge tone-${CONN_TONE[state.connection] || 'degraded'}`
  }

  function renderLastUpdated(state) {
    const el = document.getElementById('last-updated')
    if (!el) return
    el.textContent = state.lastUpdatedAt ? `updated ${formatAge(new Date(state.lastUpdatedAt).toISOString())}` : 'updated —'
  }

  store.subscribe((state) => {
    if (currentView && typeof currentView.render === 'function') currentView.render(state)
    renderNavBadges(state)
    renderConnBadge(state)
    renderLastUpdated(state)
  })
  renderNavBadges(store.getState())
  renderConnBadge(store.getState())
  renderLastUpdated(store.getState())

  // Each SSE message is appended immediately; only job.*/preflight/unknown
  // kinds (per shouldRefetchState) schedule a trailing-debounced /api/state
  // refetch, capped at one per SSE_DEBOUNCE_MS so a burst of events doesn't
  // hammer the server.
  let refetchPending = false

  function scheduleRefetch() {
    if (refetchPending) return
    refetchPending = true
    setTimeout(() => {
      refetchPending = false
      api
        .fetchState()
        .then((stateSnapshot) => store.setState((s) => applyServerState(s, stateSnapshot, Date.now())))
        .catch(() => {})
    }, SSE_DEBOUNCE_MS)
  }

  function handleSseEvent(event) {
    store.setState((s) => appendEvent(s, event))
    if (shouldRefetchState(event)) scheduleRefetch()
  }

  function handleSseConnection(connection) {
    store.setState((s) => setConnection(s, connection))
  }

  refresh()
  setInterval(refresh, POLL_INTERVAL_MS)
  api.connectEvents({ onEvent: handleSseEvent, onConnection: handleSseConnection })

  // Live elapsed-time ticker for [data-elapsed-since="ISO"] spans (running
  // jobs view) — updated in place every second, without re-rendering.
  setInterval(() => {
    document.querySelectorAll('[data-elapsed-since]').forEach((span) => {
      const sec = elapsedSeconds(span.dataset.elapsedSince)
      span.textContent = sec == null ? '—' : formatDuration(sec)
    })
    renderLastUpdated(store.getState())
  }, TICK_INTERVAL_MS)

  // 'r' refreshes unless the user is typing in a form control.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'r' || event.ctrlKey || event.metaKey || event.altKey) return
    const tag = document.activeElement && document.activeElement.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    refresh()
  })

  const refreshBtn = document.getElementById('btn-refresh')
  if (refreshBtn) refreshBtn.addEventListener('click', () => refresh())

  const themeSelect = document.getElementById('theme-select')
  if (themeSelect) {
    themeSelect.value = theme
    themeSelect.addEventListener('change', () => {
      const next = themeSelect.value
      store.setState({ theme: next })
      applyTheme(next)
      saveTheme(next)
    })
  }

  setupDrawer()

  router.start({ onChange: mountRoute })
}

/** Navigation drawer (below 960px): popover="manual", scroll-snap sheet, IntersectionObserver-driven aria-expanded. */
function setupDrawer() {
  const toggle = document.getElementById('drawer-toggle')
  const drawer = document.getElementById('nav-drawer')
  const scroller = drawer ? drawer.querySelector('.drawer-scroller') : null
  const sheet = document.querySelector('.drawer-sheet')
  if (!toggle || !drawer || !scroller || !sheet) return

  function openDrawer() {
    if (typeof drawer.showPopover === 'function') drawer.showPopover()
    scroller.scrollLeft = 0
    sheet.focus()
  }

  function closeDrawer() {
    toggle.setAttribute('aria-expanded', 'false')
    if (typeof drawer.hidePopover === 'function') drawer.hidePopover()
    toggle.focus()
  }

  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-expanded') === 'true') closeDrawer()
    else openDrawer()
  })

  if (typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) toggle.setAttribute('aria-expanded', String(entry.isIntersecting))
      },
      { root: scroller, threshold: 0.6 },
    )
    observer.observe(sheet)
  }

  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer()
  })

  sheet.addEventListener('click', (event) => {
    if (event.target.closest('.nav-item')) closeDrawer()
  })
}

// Boot only in a real document (browser); importing this module under
// `node --test` must be side-effect free.
if (typeof document !== 'undefined') {
  boot()
}
