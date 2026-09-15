/**
 * openRowMenu(anchor, items) -> close(). Manually positioned popup menu
 * (no `popover` attribute): a role="menu" <div> appended to <body>, placed
 * under the anchor and kept inside the viewport. `document`/`window` are
 * only touched inside the function body, so this file imports cleanly
 * under `node --test`.
 */

export function openRowMenu(anchor, items) {
  const menu = document.createElement('div')
  menu.className = 'menu'
  menu.setAttribute('role', 'menu')
  menu.tabIndex = -1

  const menuItemEls = items.map((item) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'menu-item' + (item.danger ? ' is-danger' : '')
    el.setAttribute('role', 'menuitem')
    el.tabIndex = -1
    el.textContent = item.label
    if (item.title) el.title = item.title
    if (item.disabled) {
      el.disabled = true
      el.setAttribute('aria-disabled', 'true')
    }
    el.addEventListener('click', () => {
      if (item.disabled) return
      close()
      if (item.onSelect) item.onSelect()
    })
    menu.appendChild(el)
    return el
  })

  document.body.appendChild(menu)

  function position() {
    const anchorRect = anchor.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    let top = anchorRect.bottom
    let left = anchorRect.left
    if (left + menuRect.width > viewportWidth) left = Math.max(0, viewportWidth - menuRect.width)
    if (top + menuRect.height > viewportHeight) top = Math.max(0, anchorRect.top - menuRect.height)
    // Positioning a manually-managed popup requires per-instance coordinates;
    // CSSOM property assignment (not a style="" attribute) is the sanctioned
    // escape hatch under this CSP.
    menu.style.position = 'fixed'
    menu.style.top = `${top}px`
    menu.style.left = `${left}px`
  }

  const enabledIndexes = () => menuItemEls.reduce((acc, el, i) => (el.disabled ? acc : [...acc, i]), [])
  let currentIndex = -1

  function focusIndex(i) {
    currentIndex = i
    menuItemEls[i].focus()
  }
  function focusFirst() {
    const idxs = enabledIndexes()
    if (idxs.length) focusIndex(idxs[0])
  }
  function focusLast() {
    const idxs = enabledIndexes()
    if (idxs.length) focusIndex(idxs[idxs.length - 1])
  }
  function focusStep(step) {
    const idxs = enabledIndexes()
    if (!idxs.length) return
    const pos = idxs.indexOf(currentIndex)
    const nextPos = pos === -1 ? 0 : (pos + step + idxs.length) % idxs.length
    focusIndex(idxs[nextPos])
  }

  function onKeydown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusStep(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusStep(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusFirst()
    } else if (event.key === 'End') {
      event.preventDefault()
      focusLast()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Tab') {
      close()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const el = menuItemEls[currentIndex]
      if (el && !el.disabled) el.click()
    }
  }

  function onOutsideClick(event) {
    if (!menu.contains(event.target) && event.target !== anchor) close()
  }

  let closed = false
  function close() {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('click', onOutsideClick, true)
    if (menu.parentNode) menu.parentNode.removeChild(menu)
    if (anchor && typeof anchor.focus === 'function') anchor.focus()
  }

  document.addEventListener('keydown', onKeydown, true)
  // Deferred so the click that opened this menu doesn't immediately close it.
  setTimeout(() => {
    if (!closed) document.addEventListener('click', onOutsideClick, true)
  }, 0)

  position()
  focusFirst()

  return close
}
