/**
 * Frozen contracts for the dashboard modules. Every module in src/dashboard/
 * builds against this file, so parallel work on disjoint files stays
 * compatible. Change it only with every consumer updated in the same commit.
 *
 * This module must stay importable under `node --test`: no DOM access.
 */

// ---------------------------------------------------------------------------
// Data shapes returned by the server (unchanged JSON contracts)
// ---------------------------------------------------------------------------

/**
 * @typedef {'ready'|'degraded'|'unavailable'|'skipped'} AgentStatus
 * @typedef {Object} AgentRow  One preflight-cache row from GET /api/state.
 * @property {string} agent            'agy' | 'opencode' | 'copilot'
 * @property {string} model
 * @property {AgentStatus} status
 * @property {string|null} reason
 * @property {'L0'|'L1'|'L2'|'L3'} ladderLevel
 * @property {string} [quotaSignal]
 * @property {string} [dataPolicy]      'trains' | 'logs' | 'unknown'
 * @property {string|null} [binPath]
 * @property {string|null} [cliVersion]
 * @property {number} [latencyMs]
 * @property {string} checkedAt         ISO timestamp
 */

/**
 * @typedef {'queued'|'running'|'succeeded'|'failed'|'canceled'} JobStatus
 * @typedef {Object} Job
 * @property {string} jobId
 * @property {string} agent
 * @property {string} model
 * @property {string|null} title
 * @property {string} cwd
 * @property {'read'|'write'|'plan'} mode
 * @property {JobStatus} status
 * @property {string|null} errorKind   e.g. quota, billing, timeout, crash, canceled_by_user
 * @property {string|null} error
 * @property {string|null} variant
 * @property {string|null} sessionId
 * @property {string|null} parentJobId  set when the job is a job_reply turn
 * @property {number|null} tokens
 * @property {number|null} costUsd
 * @property {number|null} timeoutS
 * @property {string} createdAt         ISO
 * @property {string} updatedAt         ISO; there is no finishedAt, terminal time = updatedAt
 */

/**
 * @typedef {'preflight'|'job.queued'|'job.started'|'job.finished'|'job.failed'|'job.canceled'|'subagent.start'|'subagent.stop'} EventKind
 * @typedef {Object} HubEvent  One events.jsonl line (GET /api/state events, SSE /events data).
 * @property {string} ts                ISO
 * @property {'hub'|'claude-hook'} source
 * @property {EventKind} kind
 * @property {string} [agent]
 * @property {string} [model]
 * @property {string} [title]
 * @property {string} [summary]
 * @property {string} [jobId]
 * @property {string} [cwd]
 * @property {string} [errorKind]       job.failed
 * @property {number} [tokens]          job.finished, subagent.stop
 * @property {number} [costUsd]         job.finished
 * @property {string} [phase]           preflight: 'discovery' | 'agent' | 'ping'
 * @property {string} [status]          preflight
 * @property {string} [reason]          preflight
 * @property {string} [ladderLevel]     preflight
 * @property {number} [latencyMs]       preflight
 * @property {string} [agentId]         subagent.*
 * @property {string} [sessionId]       subagent.*
 */

/**
 * @typedef {Object} ChainStep
 * @property {string} agent             'claude' means run via the Claude Agent tool
 * @property {string} model
 * @property {'read'|'write'} [mode]
 * @property {ChainStep} [parallelWith]
 * @typedef {Object} DelegationEntry
 * @property {string} why
 * @property {ChainStep[]} chain
 *
 * @typedef {Object} DiscoveryEntry
 * @property {string} agent
 * @property {string} cmd
 * @property {string|null} binPath
 * @property {string|null} version
 * @property {{id:string,label?:string}[]} models
 * @property {string} checkedAt
 * @property {string|null} error
 * @property {string} [note]
 *
 * @typedef {Object} BreakerState
 * @property {string} agent
 * @property {string} model
 * @property {boolean} open
 * @property {number} failureCount
 * @property {string|null} lastFailureAt
 *
 * @typedef {Object} Override
 * @property {boolean} [hold]
 * @property {string} [breakerReset]    ISO
 * @property {string} [reason]
 * @property {string} setAt             ISO
 *
 * @typedef {Object} Config  GET /api/config
 * @property {Object<string, DelegationEntry>} delegationMap
 * @property {Object<string, DiscoveryEntry>} discovery   may be {} before the first discovery run
 * @property {Object<string, Object<string, number>>} timeouts   agent -> model|'default' -> seconds
 * @property {{windowMs:number, failureThreshold:number, failureKinds:string[], immediateKinds:string[]}} breaker
 * @property {number} ttlMs
 * @property {string} agentHubHome
 * @property {string[]} writeAllowlist
 * @property {BreakerState[]} breakerState
 * @property {Object<string, Override>} overrides        key "agent:model"
 * @property {{pid:number, nodeVersion:string, platform:string, pathEntries:string[], resolvedBins:Object<string, string|null>}} process
 */

// ---------------------------------------------------------------------------
// Client state and routing
// ---------------------------------------------------------------------------

/**
 * @typedef {'connecting'|'live'|'reconnecting'|'offline'} Connection
 * @typedef {'system'|'light'|'dark'} ThemeChoice
 * @typedef {Object} AppState
 * @property {AgentRow[]} agents
 * @property {Job[]} jobs              newest first (server order)
 * @property {HubEvent[]} subagents    events with source 'claude-hook'
 * @property {HubEvent[]} events       oldest first, capped at MAX_EVENTS
 * @property {Config|null} config
 * @property {Connection} connection
 * @property {number|null} lastUpdatedAt       epoch ms of the last successful /api/state
 * @property {string|null} lastSeenTimelineTs  ISO ts of the newest event seen in #/timeline
 * @property {ThemeChoice} theme
 * @property {Object<string, boolean>} busy    in-flight action keys, e.g. 'refresh:agy:gemini-3.8-flash-low'
 *
 * @typedef {Object} Route
 * @property {RouteName} name
 * @property {Object<string, string>} query   from '#/agents?filter=unhealthy'
 *
 * @typedef {'overview'|'agents'|'jobs'|'history'|'subagents'|'timeline'|'config'} RouteName
 */

export const MAX_EVENTS = 200

/** Sidebar order and grouping. `badge` names a navBadges() key; null = no badge. */
export const NAV_GROUPS = Object.freeze([
  { label: 'Monitor', items: ['overview', 'agents', 'jobs', 'history'] },
  { label: 'Activity', items: ['subagents', 'timeline'] },
  { label: 'System', items: ['config'] },
])

export const ROUTES = Object.freeze({
  overview: { label: 'Overview', icon: 'overview', badge: null },
  agents: { label: 'Agents', icon: 'agents', badge: 'agents' },
  jobs: { label: 'Running jobs', icon: 'jobs', badge: 'jobs' },
  history: { label: 'Job history', icon: 'history', badge: 'history' },
  subagents: { label: 'Claude subagents', icon: 'subagents', badge: null },
  timeline: { label: 'Timeline', icon: 'timeline', badge: 'timeline' },
  config: { label: 'Config', icon: 'config', badge: 'config' },
})

export const DEFAULT_ROUTE = 'overview'

/**
 * Agents view query: ?filter=all|unhealthy|held|breaker&q=text
 * History view query: ?status=all|failed|canceled|succeeded&agent=<name>&q=text
 * Config view query:  ?section=delegation|process|breaker|overrides|paths
 */

// ---------------------------------------------------------------------------
// Module signatures (implementations live in the named files)
// ---------------------------------------------------------------------------

/**
 * router.js
 *   parseHash(hash: string): Route        pure; '' '#' '#/' unknown or malformed -> {name:'overview', query:{}}
 *   buildHash(name: RouteName, query?: Object<string,string>): string   pure; omits empty values
 *   start({onChange: (route: Route) => void}): () => void               listens to hashchange, fires once immediately
 *   navigate(name: RouteName, query?: Object<string,string>): void      sets location.hash
 *
 * store.js
 *   createStore(initial: AppState): {getState(): AppState, setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void,
 *                                    subscribe(listener: (state: AppState, prev: AppState) => void): () => void}
 *   initialState(): AppState
 *   actions (pure, return a patch):
 *     applyServerState(state, apiState: {agents, jobs, subagents, events}, now: number)
 *     applyConfig(state, config: Config)
 *     appendEvent(state, event: HubEvent)   keeps MAX_EVENTS, also appends to subagents when source==='claude-hook'
 *     setConnection(state, connection: Connection)
 *     setBusy(state, key: string, busy: boolean)
 *     markTimelineSeen(state)
 *   shouldRefetchState(event: HubEvent): boolean   true for job.* , preflight and unknown kinds
 *
 * api.js  (every call rejects with Error{message, status} on non-2xx; JSON bodies; Content-Type application/json on writes)
 *   fetchState(): Promise<{agents, jobs, subagents, events}>
 *   fetchConfig(): Promise<Config>
 *   refreshAgents({agent?, model?, ping?}): Promise<{results: AgentRow[]}>
 *   refreshDiscovery(): Promise<Object<string, DiscoveryEntry>>
 *   setOverride({agent, model, hold?, breakerReset?}): Promise<Override>
 *   clearOverride(agent, model): Promise<{cleared: true}>   URL-encodes both segments
 *   cancelJob(jobId): Promise<object>
 *   connectEvents({onEvent(event: HubEvent), onConnection(c: Connection)}): () => void   wraps EventSource('/events')
 *
 * ui/dom.js
 *   h(tag, attrs?, children?): HTMLElement   attrs: class, text (textContent), dataset{}, aria-*, id, type, href, title, disabled, hidden, tabindex
 *   on(root, type, selector, handler(event, matchedEl)): () => void   delegated listener
 *   clear(node): void
 *   html strings are allowed only when every interpolated value goes through esc()
 *
 * ui/format.js  (pure)
 *   esc(value): string
 *   formatModel(model): string       human label, falls back to the raw id
 *   formatNumber(n): string          '—' for null
 *   formatAge(iso, now?): string     '12s ago', '5m ago', '3h ago', '2d ago'; '—' for null
 *   elapsedSeconds(iso, now?): number
 *   formatDuration(seconds): string  '42s', '3m 05s', '1h 02m'
 *
 * ui/badges.js  (pure; `now` injectable for tests)
 *   agentKey(agent, model): string                  'agent:model'
 *   overrideFor(state, agent, model): Override|null
 *   breakerFor(state, agent, model): BreakerState|null
 *   isUnhealthy(state, row: AgentRow): boolean      degraded | unavailable | held | breaker open
 *   unhealthyAgents(state): AgentRow[]
 *   heldPairs(state): string[]                      override keys with hold === true
 *   openBreakers(state): BreakerState[]
 *   unresolvedAgents(state): string[]               agents whose process.resolvedBins value is null
 *   runningJobs(state): Job[]                       queued + running
 *   failedJobsSince(state, sinceMs, now?): Job[]    status failed and updatedAt within the window
 *   unseenTimelineCount(state): number
 *   navBadges(state, now?): Object<string, {count:number, tone:Tone}|null>   keys agents, jobs, history, timeline, config; null when count is 0
 *   statusBadge(status): {label:string, tone:Tone, icon:string}
 *   errorBadge(errorKind): {label:string, tone:Tone}   tone from ERROR_KIND_SEVERITY below; unknown kinds -> 'degraded'
 *
 * ui/dialog.js
 *   confirmDialog({title, body, confirmLabel, danger?}): Promise<boolean>
 *     <dialog closedby="any"> + showModal(); click-outside fallback when !('closedBy' in HTMLDialogElement.prototype); focus returns to the invoker
 *
 * ui/menu.js
 *   openRowMenu(anchor: HTMLElement, items: {label, onSelect(), danger?, disabled?, title?}[]): () => void
 *     role="menu", arrow keys, Escape and outside click close, focus returns to anchor
 *
 * ui/icons.js
 *   icon(name: string, {size?}?): string   inline <svg aria-hidden="true" focusable="false"> markup; names: overview agents jobs history
 *     subagents timeline config refresh menu more close sun moon monitor check warn error clock play pause hold
 *
 * @typedef {'ready'|'running'|'degraded'|'unavailable'|'muted'} Tone
 */

/** Existing severity mapping from the single-file dashboard, kept 1:1. */
export const ERROR_KIND_SEVERITY = Object.freeze({
  billing: 'unavailable', auth: 'unavailable', model_unavailable: 'unavailable', crash: 'unavailable',
  worktree_denied: 'unavailable', locked: 'unavailable', unsupported: 'unavailable',
  quota: 'degraded', canceled: 'degraded', canceled_by_user: 'degraded', timeout: 'degraded', empty: 'degraded',
  orphaned: 'muted', not_terminal: 'muted', no_session: 'muted',
})

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * views/<name>.js exports:
 *   mount(root: HTMLElement, ctx: ViewContext): void   build the static skeleton once, attach ONE delegated listener on root
 *   render(state: AppState): void                      idempotent; called by app.js on every store change while mounted
 *   unmount(): void                                    remove listeners and timers
 *
 * @typedef {Object} ViewContext
 * @property {{getState():AppState, setState(patch):void, subscribe(fn):()=>void}} store
 * @property {typeof import('./api.js')} api
 * @property {Route} route
 * @property {(name: RouteName, query?: Object<string,string>) => void} navigate
 * @property {(opts:{title:string, body:string, confirmLabel:string, danger?:boolean}) => Promise<boolean>} confirm
 * @property {(anchor: HTMLElement, items: object[]) => () => void} openRowMenu
 * @property {(message: string) => void} announce      polite live-region message
 * @property {() => Promise<void>} refresh             refetch /api/state + /api/config now
 * @property {(key: string, fn: () => Promise<any>) => Promise<any>} runAction
 *           marks state.busy[key], sets aria-busy on the triggering button via [data-busy-key], shows a toast
 *           on failure, refetches state and config on completion
 *
 * app.js owns: <main id="main-content"> contains one <section class="view" data-view="<name>" aria-labelledby="view-title">.
 * Each view renders, as its first child, <header class="view-header"><h1 id="view-title" class="view-title" tabindex="-1">
 * then optional <div class="view-actions">. app.js focuses #view-title after every navigation.
 *
 * Required ids (asserted by test/dashboard.test.mjs against served assets):
 *   agents view: button#btn-revalidate-all, button#btn-rediscover
 *   config view: root element id="config-panel"
 * Behaviors that must survive the redesign:
 *   agents: unresolved-CLI banner (.callout.callout-warn) and disabled Revalidate/Ping with a title explaining PATH
 *   jobs: live elapsed time via [data-elapsed-since="ISO"] spans updated by app.js every second (no re-render)
 *   history: "reply of <parentJobId>" hint; errorBadge on failures; row detail with error, sessionId, tokens, costUsd
 *   timeline: source chips (all | hub | claude-hook) + kind filter + search; newest first
 *   confirm before: Ping (L3, spends quota), Reset breaker, Cancel job
 *   empty states: .empty-state with .empty-title and .empty-hint
 */

// ---------------------------------------------------------------------------
// CSS class contract (styles.css implements, views use). No inline style attributes (CSP style-src 'self').
// ---------------------------------------------------------------------------

/**
 * Shell:      .app  .sidebar  .sidebar-brand  .nav  .nav-group  .nav-group-label  .nav-item[aria-current="page"]
 *             .nav-icon  .nav-label  .nav-badge.tone-<Tone>  .topbar  .topbar-title  .topbar-meta  .drawer-toggle
 *             .skip-link  .sr-only  .toast-region  .toast.tone-<Tone>
 * View:       .view  .view-header  .view-title  .view-subtitle  .view-actions  .section  .section-title
 * Controls:   .btn  .btn-primary  .btn-ghost  .btn-danger  .btn-sm  .btn-icon (needs aria-label)
 *             .chips  .chip[aria-pressed]  .search  .search-input  .select  .tabs  .tab[aria-selected]
 * Data:       .table-wrap (overflow-x:auto, sticky thead)  .table  .table-dense  tr.is-clickable  tr.is-selected
 *             .group-row (CLI group header inside tables)  .cell-mono  .cell-truncate  .cell-actions  .num
 *             .badge.tone-<Tone> (always text + icon, never color only)  .tag  .kbd
 * Cards:      .kpi-grid  .kpi-card (an <a>)  .kpi-label  .kpi-value  .kpi-hint  .card  .card-title  .card-body
 *             .attention-list  .attention-item.tone-<Tone>  .chain (delegation chain)  .chain-step  .chain-arrow
 * Panels:     .detail-panel[hidden]  .detail-header  .detail-body  .kv (dl grid)  .kv dt  .kv dd
 * Feedback:   .callout.callout-warn  .callout.callout-info  .empty-state  .empty-title  .empty-hint  .spinner
 * Overlays:   dialog.confirm  .confirm-actions  .menu[role="menu"]  .menu-item[role="menuitem"]  .menu-item.is-danger
 * Utilities:  .row  .stack  .gap-sm  .gap-md  .muted  .mono  .truncate  [hidden]{display:none!important}
 * Themes:     :root { color-scheme: light dark }  :root[data-theme="light"] { color-scheme: light }  :root[data-theme="dark"] { color-scheme: dark }
 * z-index:    sidebar 10, sticky headers 20, toasts 40; drawer, menu and dialog use the top layer or 50
 */

// ---------------------------------------------------------------------------
// Shell markup contract (index.html implements, app.js and ui/dialog.js use)
// ---------------------------------------------------------------------------

/**
 * <head>: <meta name="color-scheme" content="light dark">, <title>agent-hub dashboard</title>,
 *         <link rel="stylesheet" href="/styles.css">, <script type="module" src="/app.js"></script>
 * a.skip-link[href="#main-content"]
 * aside#sidebar.sidebar > .sidebar-brand + nav#nav.nav[aria-label="Primary"]
 *   > .nav-group > .nav-group-label + a.nav-item[data-route=<name>][href="#/<name>"]
 *     > span.nav-icon[data-icon=<name>] (empty, app.js injects svg) + span.nav-label + span.nav-badge[data-badge=<name>][hidden]
 * div#nav-drawer.drawer[popover="manual"] > .drawer-scroller > nav.drawer-sheet[tabindex="-1"][aria-label="Primary"]  (app.js clones #nav groups into it)
 * div.app-main > header.topbar
 *   > button#drawer-toggle.drawer-toggle.btn.btn-icon[aria-controls="nav-drawer"][aria-expanded="false"][aria-label="Open navigation"]
 *   + h2#topbar-title.topbar-title + div.topbar-meta > span#conn-badge.badge + span#last-updated.muted
 *   + button#btn-refresh.btn.btn-ghost + label[for="theme-select"].sr-only + select#theme-select (system|light|dark)
 * div.app-main > main#main-content[tabindex="-1"]   (empty; app.js mounts the view section)
 * div#live-region.sr-only[aria-live="polite"]   div#toast-region.toast-region[aria-live="polite"]
 * dialog#confirm-dialog.confirm[closedby="any"][aria-labelledby="confirm-title"]
 *   > h2#confirm-title + p#confirm-body + div.confirm-actions > button#confirm-cancel.btn + button#confirm-ok.btn.btn-primary
 * Layout: sidebar visible >= 960px; below, sidebar hidden and #drawer-toggle shown.
 */
