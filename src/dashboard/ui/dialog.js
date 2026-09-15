/**
 * confirmDialog({title, body, confirmLabel, danger?}) -> Promise<boolean>.
 * Reuses dialog#confirm-dialog from the shell markup (creating it if the
 * shell is somehow missing it), shown with showModal(). `document` is only
 * touched inside function bodies so this file imports cleanly under
 * `node --test`.
 */

function ensureDialog() {
  let dialog = document.getElementById('confirm-dialog')
  if (dialog) return dialog

  dialog = document.createElement('dialog')
  dialog.id = 'confirm-dialog'
  dialog.className = 'confirm'
  dialog.setAttribute('closedby', 'any')
  dialog.setAttribute('aria-labelledby', 'confirm-title')
  dialog.innerHTML =
    '<h2 id="confirm-title"></h2>' +
    '<p id="confirm-body"></p>' +
    '<div class="confirm-actions">' +
    '<button id="confirm-cancel" type="button" class="btn">Cancel</button>' +
    '<button id="confirm-ok" type="button" class="btn btn-primary">OK</button>' +
    '</div>'
  document.body.appendChild(dialog)
  return dialog
}

export function confirmDialog({ title, body, confirmLabel, danger } = {}) {
  return new Promise((resolve) => {
    const dialog = ensureDialog()
    const titleEl = dialog.querySelector('#confirm-title')
    const bodyEl = dialog.querySelector('#confirm-body')
    const cancelBtn = dialog.querySelector('#confirm-cancel')
    const okBtn = dialog.querySelector('#confirm-ok')
    const previouslyFocused = document.activeElement

    titleEl.textContent = title || ''
    bodyEl.textContent = body || ''
    okBtn.textContent = confirmLabel || 'OK'
    okBtn.classList.toggle('btn-danger', Boolean(danger))
    okBtn.classList.toggle('btn-primary', !danger)

    let settled = false
    let usesFallback = false

    function finish(result) {
      if (settled) return
      settled = true
      cleanup()
      if (dialog.open) dialog.close()
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus()
      resolve(result)
    }

    function onOkClick() {
      finish(true)
    }
    function onCancelClick() {
      finish(false)
    }
    function onDialogCancel() {
      // fires on Escape (native, regardless of closedby support)
      finish(false)
    }
    function onDialogClose() {
      // covers a native closedby="any" backdrop dismissal that skips 'cancel'
      finish(false)
    }
    function onOutsideClick(event) {
      const rect = dialog.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      if (!inside) finish(false)
    }

    function cleanup() {
      okBtn.removeEventListener('click', onOkClick)
      cancelBtn.removeEventListener('click', onCancelClick)
      dialog.removeEventListener('cancel', onDialogCancel)
      dialog.removeEventListener('close', onDialogClose)
      if (usesFallback) dialog.removeEventListener('click', onOutsideClick)
    }

    okBtn.addEventListener('click', onOkClick)
    cancelBtn.addEventListener('click', onCancelClick)
    dialog.addEventListener('cancel', onDialogCancel)
    dialog.addEventListener('close', onDialogClose)

    // Only browsers without native closedby="any" support need the
    // click-outside fallback; modern browsers already dispatch cancel/close.
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      usesFallback = true
      dialog.addEventListener('click', onOutsideClick)
    }

    dialog.showModal()
  })
}
