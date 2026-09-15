/**
 * Minimal DOM helpers. `document` is only ever touched inside function
 * bodies, never at module top level, so this file imports cleanly under
 * `node --test`.
 */

const ARIA_PREFIX = 'aria-'

/**
 * h(tag, attrs?, children?): build one element.
 * attrs: class, text (-> textContent), dataset{}, aria-*, id, type, href,
 * title, disabled, hidden, tabindex. Anything else is set as a plain
 * attribute via setAttribute, so callers never need style="".
 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag)
  for (const key of Object.keys(attrs || {})) {
    const value = attrs[key]
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') {
      el.className = value
    } else if (key === 'text') {
      el.textContent = value
    } else if (key === 'dataset') {
      for (const dataKey of Object.keys(value)) el.dataset[dataKey] = value[dataKey]
    } else if (key === 'disabled' || key === 'hidden') {
      el[key] = Boolean(value)
    } else if (key.startsWith(ARIA_PREFIX)) {
      el.setAttribute(key, String(value))
    } else {
      el.setAttribute(key, String(value))
    }
  }
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    if (child === undefined || child === null || child === false) continue
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return el
}

/** Delegated listener: fires handler(event, matchedEl) when event.target matches selector inside root. */
export function on(root, type, selector, handler) {
  const listener = (event) => {
    const matchedEl = event.target.closest ? event.target.closest(selector) : null
    if (matchedEl && root.contains(matchedEl)) handler(event, matchedEl)
  }
  root.addEventListener(type, listener)
  return () => root.removeEventListener(type, listener)
}

/** Remove every child node from `node`. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}
