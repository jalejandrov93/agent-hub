/**
 * Hash router. Pure parsing/building; `window`/`location` are only touched
 * inside start()/navigate() function bodies so this module imports cleanly
 * under `node --test`.
 */

import { ROUTES, DEFAULT_ROUTE } from './contracts.js'

/** parseHash('' | '#' | '#/' | unknown | malformed) -> {name:'overview', query:{}}. */
export function parseHash(hash) {
  const raw = String(hash || '')
  const withoutHash = raw.replace(/^#/, '')
  const withoutSlash = withoutHash.replace(/^\//, '')
  const [namePart, queryPart] = withoutSlash.split('?')
  const name = namePart && Object.prototype.hasOwnProperty.call(ROUTES, namePart) ? namePart : DEFAULT_ROUTE
  const query = {}
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue
      const [rawKey, rawValue = ''] = pair.split('=')
      if (!rawKey) continue
      try {
        query[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue)
      } catch {
        // malformed percent-encoding: skip this pair rather than throw
      }
    }
  }
  return { name, query }
}

/** buildHash(name, query?) -> '#/<name>[?k=v&...]'; omits empty values. */
export function buildHash(name, query = {}) {
  const routeName = Object.prototype.hasOwnProperty.call(ROUTES, name) ? name : DEFAULT_ROUTE
  const params = Object.keys(query || {})
    .filter((key) => query[key] !== undefined && query[key] !== null && query[key] !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
  const qs = params.length ? `?${params.join('&')}` : ''
  return `#/${routeName}${qs}`
}

/** start({onChange}): listens to hashchange, fires onChange once immediately. Returns a stop function. */
export function start({ onChange }) {
  const handler = () => onChange(parseHash(window.location.hash))
  window.addEventListener('hashchange', handler)
  handler()
  return () => window.removeEventListener('hashchange', handler)
}

/** navigate(name, query?): sets location.hash via buildHash. */
export function navigate(name, query = {}) {
  window.location.hash = buildHash(name, query)
}
