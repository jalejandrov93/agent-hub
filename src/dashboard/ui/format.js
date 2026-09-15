/**
 * Pure string/number formatting helpers. No DOM access — importable under
 * `node --test`. Ported 1:1 from the legacy src/dashboard.html script.
 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Safe string escaping for use inside HTML-string templates. */
export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c])
}

/** Model name humanizer (keeps the full model id available for a tooltip). */
export function formatModel(model) {
  if (!model) return '—'
  const m = String(model).trim()
  if (m.indexOf('claude-3-5-sonnet') !== -1) return 'Sonnet 3.5'
  if (m.indexOf('claude-3-7-sonnet') !== -1) return 'Sonnet 3.7'
  if (m.indexOf('claude-3-5-haiku') !== -1) return 'Haiku 3.5'
  if (m.indexOf('claude-3-opus') !== -1) return 'Opus 3'
  if (m.indexOf('gpt-4o-mini') !== -1) return 'GPT-4o Mini'
  if (m.indexOf('gpt-4o') !== -1) return 'GPT-4o'
  if (m.indexOf('o3-mini') !== -1) return 'o3-mini'
  if (m.indexOf('o1') !== -1) return 'o1'
  return m
}

/** Token/count formatter: 1_234 -> '1.2k', 2_500_000 -> '2.5M'. */
export function formatNumber(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const num = Number(n)
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return num.toLocaleString()
}

/** Seconds elapsed since an ISO timestamp; `now` is injectable for tests. */
export function elapsedSeconds(iso, now = Date.now()) {
  if (!iso) return null
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return null
  return Math.max(0, Math.floor((now - parsed) / 1000))
}

/** Human-readable age since an ISO timestamp, e.g. '12s ago'. */
export function formatAge(iso, now = Date.now()) {
  if (!iso) return '—'
  const ms = now - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Latency formatter: milliseconds below 1000, one-decimal seconds at 1000+, e.g. '3.8 s'. */
export function formatLatency(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—'
  const n = Number(ms)
  if (n < 1000) return `${n} ms`
  return `${(n / 1000).toFixed(1)} s`
}

/** Duration formatter for a count of seconds, e.g. '42s', '3m 05s', '1h 02m'. */
export function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '—'
  const s = Math.max(0, Math.floor(Number(seconds)))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return `${m}m ${String(remS).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  const remM = m % 60
  return `${h}h ${String(remM).padStart(2, '0')}m`
}
