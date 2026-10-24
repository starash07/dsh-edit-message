/**
 * Edit a message that was already sent — the browser half.
 *
 * The Session log is append-only, so nothing here rewrites history. Instead:
 *   1. right-click the LAST user bubble and choose 编辑;
 *   2. its original text returns to the composer;
 *   3. on send, one marker line is prepended to the new text:
 *          【上一条用户消息及其回答作废】
 *   4. the page replaces that line with a small `#编辑#` capsule, so the model
 *      reads the marker and the reader sees only the capsule.
 *
 * Only the latest user message can be edited, which makes the marker
 * unambiguous: "the previous user message" is the one that was edited. Editing
 * an older message would need the marker to name its target.
 */
window.__ModuleLoader__.load({
  id: 'dsh-edit-message',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'edit-message'
    const MARKER_LEAD = '【上一条用户消息及其回答作废】'
    // Earlier builds wrote an id-bearing wording; still recognised so those
    // markers keep turning into capsules.
    const MARKER_ANY = /【(?:上一条用户消息及其回答作废|(?:我上一条|用户消息及回答)作废 #[A-Za-z0-9_]{1,32})】/
    const MARKER_LINE = /^\s*【(?:上一条用户消息及其回答作废|(?:我上一条|用户消息及回答)作废 #[A-Za-z0-9_]{1,32})】\s*$/

    const DICTS = {
      'zh-CN': {
        title: '消息操作',
        edit: '编辑',
        editHint: '原文回到输入框，重发后这条作废',
        noComposer: '找不到输入框，请先点一下输入框再试',
        cancelled: '已取消',
        editing: '编辑中',
        cancelEdit: '取消这次编辑',
        pendingHint: '发送后这条会作废上一条；点 × 取消',
      },
      'en-US': {
        title: 'Message actions',
        edit: 'Edit',
        editHint: 'The text returns to the composer; resending voids this one',
        noComposer: 'Composer not found; click the composer and try again',
        cancelled: 'Cancelled',
        editing: 'Editing',
        cancelEdit: 'Cancel this edit',
        pendingHint: 'Sending this voids the previous message; click × to cancel',
      },
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function fallbackTranslate(key) {
      const dict = DICTS['zh-CN']
      return dict[key] !== undefined ? dict[key] : (DICTS['en-US'][key] !== undefined ? DICTS['en-US'][key] : key)
    }

    function makeTranslator(locale) {
      let bound = null
      if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
        try { bound = locale.bind(NS) } catch { bound = null }
      }
      return (key) => {
        if (bound !== null) {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch { /* fall back to the built-in dictionary */ }
        }
        return fallbackTranslate(key)
      }
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    /**
     * Drop marker lines from authored text.
     *
     * Editing a message that already carries a marker would otherwise copy that
     * marker back into the composer, and the next send would stack a second one
     * on top of it.
     */
    function stripMarkerLines(text) {
      const lines = String(text).split(/\r?\n/)
      const kept = lines.filter((line) => !MARKER_LINE.test(line))
      return kept.join('\n').replace(/^[\s\n]+/, '').trim()
    }

    /** Visible text of a user bubble, without the clock line or a hidden marker. */
    function domTextOfRow(row) {
      const clone = row.cloneNode(true)
      for (const hidden of clone.querySelectorAll('[data-dsh-edit-hidden], [data-dsh-edit-chip]')) hidden.remove()
      const raw = clone.innerText === undefined ? String(clone.textContent || '') : String(clone.innerText)
      const lines = raw.split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^\d{1,2}:\d{2}$/.test(line))
      return lines.join('\n').trim()
    }

    // ── React identity ───────────────────────────────────────────────────────

    function fiberOf(element) {
      for (const key of Object.getOwnPropertyNames(element)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return element[key]
      }
      return null
    }

    /** The Chat node, its durable identity and its Session, read from the fiber chain. */
    function nodeInfo(element) {
      const info = { messageId: null, seq: null, sessionId: null, node: null }
      let fiber = fiberOf(element)
      let hops = 0
      while (fiber !== null && fiber !== undefined && hops < 150) {
        const props = fiber.memoizedProps
        if (props !== null && typeof props === 'object') {
          if (info.sessionId === null && typeof props.sessionId === 'string') info.sessionId = props.sessionId
          if (info.node === null) {
            const candidate = props.node
            // Only a Chat node carries `kind`; other components also take a
            // `node` prop (references, AST wrappers), and stopping at one of
            // those made plain message text look like a foreign node.
            if (candidate !== null && typeof candidate === 'object'
              && typeof candidate.kind === 'string'
              && candidate.data !== null && typeof candidate.data === 'object') {
              info.node = candidate
              if (typeof candidate.messageId === 'string') info.messageId = candidate.messageId
              if (info.seq === null && typeof candidate.anchorSeq === 'number' && Number.isSafeInteger(candidate.anchorSeq)) info.seq = candidate.anchorSeq
              if (info.seq === null && typeof candidate.seq === 'number' && Number.isSafeInteger(candidate.seq)) info.seq = candidate.seq
            }
          }
        }
        fiber = fiber.return
        hops += 1
      }
      return info
    }

    /**
     * Node identity looked up from a click target or from a flow row.
     *
     * The row wrapper that carries `data-chat-flow-kind` sits ABOVE the node
     * view in the React tree, so walking up from the wrapper never reaches the
     * component that owns the `node` prop. Seed the walk from a descendant
     * instead, which passes through the node view.
     */
    function nodeInfoNear(element) {
      const direct = nodeInfo(element)
      if (direct.node !== null) return direct
      const seed = element.querySelector('div, span, p')
      if (seed === null) return direct
      const nested = nodeInfo(seed)
      return nested.node === null ? direct : nested
    }

    /** The authored text of one user message, from its content parts. */
    function textOfNode(node) {
      const data = node === null || node === undefined ? null : node.data
      if (data === null || data === undefined) return null
      if (!Array.isArray(data.content)) {
        const plain = typeof data.text === 'string' ? data.text.trim() : ''
        return plain === '' ? null : plain
      }
      const parts = []
      for (const part of data.content) {
        if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      }
      const text = parts.join('\n').trim()
      return text === '' ? null : text
    }

    // ── composer bridges ─────────────────────────────────────────────────────

    const bridges = new Map()

    function pickBridge(sessionId) {
      if (typeof sessionId === 'string') {
        const exact = bridges.get(sessionId)
        if (exact !== undefined) return exact
      }
      if (bridges.size === 1) {
        for (const bridge of bridges.values()) return bridge
      }
      return undefined
    }

    /** Best-effort composer text for a build without the live input hook. */
    function composerDomText() {
      const card = document.querySelector('[data-composer-card]')
      if (card === null) return null
      const editable = card.querySelector('[contenteditable="true"], [contenteditable=""]')
      if (editable !== null) return editable.innerText
      const area = card.querySelector('textarea')
      return area === null ? null : area.value
    }

    function makeBridge(latest, sessionId, live) {
      return {
        sessionId,
        draft() {
          if (live) return latest.current.draft
          const dom = composerDomText()
          return dom === null ? latest.current.draft : dom
        },
        rev: () => latest.current.rev,
        setDraft(text) {
          const actions = latest.current.inputActions
          if (actions === null || actions === undefined) return false
          const draft = latest.current.draft
          try {
            if (draft.trim() !== '' && typeof actions.insertText === 'function') {
              const span = { start: 0, end: draft.length, draftRev: latest.current.rev }
              if (actions.insertText(text, span)) return true
            }
            if (typeof actions.setDraft === 'function') {
              actions.setDraft(text)
              return true
            }
          } catch { return false }
          return false
        },
        submit() {
          const actions = latest.current.inputActions
          if (actions === null || actions === undefined || typeof actions.submit !== 'function') return false
          try {
            actions.submit()
            return true
          } catch { return false }
        },
        waitFor(text, timeoutMs) {
          return new Promise((resolve) => {
            const started = Date.now()
            const tick = () => {
              const current = live ? latest.current.draft : (composerDomText() ?? latest.current.draft)
              if (current.trim() === text.trim()) return resolve(true)
              if (Date.now() - started > timeoutMs) return resolve(false)
              window.setTimeout(tick, 40)
            }
            tick()
          })
        },
      }
    }

    /** The edit waiting to be sent; cleared once its message leaves the composer. */
    const pendingEdit = { current: null }
    const pendingListeners = new Set()

    function setPendingEdit(next) {
      pendingEdit.current = next
      for (const listener of Array.from(pendingListeners)) {
        try { listener() } catch { /* one bad listener must not stop the rest */ }
      }
    }

    function clearPendingEdit() {
      if (pendingEdit.current !== null) setPendingEdit(null)
    }

    function usePendingEdit() {
      const [state, setState] = React.useState(pendingEdit.current)
      React.useEffect(() => {
        const listener = () => setState(pendingEdit.current)
        pendingListeners.add(listener)
        return () => { pendingListeners.delete(listener) }
      }, [])
      return state
    }

    // ── menu state ───────────────────────────────────────────────────────────

    const menuStore = { current: null, listeners: new Set() }

    function setMenu(next) {
      menuStore.current = next
      for (const listener of Array.from(menuStore.listeners)) {
        try { listener() } catch { /* one bad listener must not stop the rest */ }
      }
    }

    function useMenu() {
      const [state, setState] = React.useState(menuStore.current)
      React.useEffect(() => {
        const listener = () => setState(menuStore.current)
        menuStore.listeners.add(listener)
        return () => { menuStore.listeners.delete(listener) }
      }, [])
      return state
    }

    // ── menu component ───────────────────────────────────────────────────────

    function placeMenu(x, y) {
      const width = 210
      const height = 138
      return {
        left: clamp(x, 8, Math.max(8, window.innerWidth - width - 8)) + 'px',
        top: clamp(y, 8, Math.max(8, window.innerHeight - height - 8)) + 'px',
      }
    }

    function MenuHost(props) {
      const t = props.t
      const state = useMenu()
      const [error, setError] = React.useState('')

      React.useEffect(() => { setError('') }, [state])

      if (state === null) return null

      const startEdit = () => {
        const bridge = pickBridge(state.sessionId)
        if (bridge === undefined) {
          setError(t('noComposer'))
          return
        }
        if (!bridge.setDraft(state.text)) {
          setError(t('noComposer'))
          return
        }
        pendingEdit.current = {
          sessionId: state.sessionId,
          snippet: state.snippet,
        }
        setPendingEdit(pendingEdit.current)
        setMenu(null)
      }

      const close = () => setMenu(null)

      return h('div', {
        'data-edit-menu-ui': '',
        className: 'demMenu',
        role: 'menu',
        'aria-label': t('title'),
        style: placeMenu(state.x, state.y),
        onContextMenu: (event) => event.preventDefault(),
      },
      h('div', { className: 'demHeader' }, h('span', { className: 'demName' }, state.snippet)),
      h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'demItem',
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          startEdit()
        },
      }, h('span', { className: 'demItemLabel' }, t('edit'))),
      h('div', { className: 'demHint' }, t('editHint')),
      error === '' ? null : h('div', { className: 'demHint demHintError', role: 'alert' }, error))
    }

    /** Visible while an edit is pending; the text itself lives in the tooltip. */
    function PendingChip(props) {
      const t = props.t
      const pending = usePendingEdit()
      if (pending === null) return null
      return h('div', { className: 'demPending', title: pending.snippet + '\n' + t('pendingHint') },
        h('span', { className: 'demPendingLabel' }, t('editing')),
        h('button', {
          type: 'button',
          className: 'demPendingCancel',
          'aria-label': t('cancelEdit'),
          title: t('cancelEdit'),
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            clearPendingEdit()
          },
        }, '×'))
    }

    // ── the marker capsule ───────────────────────────────────────────────────

    /**
     * Replace the marker text with a small `#编辑#` capsule.
     *
     * User text is not Markdown: it renders as plain-text runs, so the marker is
     * one substring inside a text node rather than its own paragraph. Cutting it
     * out also swallows the blank lines it was separated by, which would
     * otherwise leave an empty gap at the top of the bubble.
     * @returns whether this row carried a marker.
     */
    function wrapMarker(row) {
      if (row.querySelector('[data-dsh-edit-chip]') !== null) return true
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        const text = node.nodeValue === null ? '' : node.nodeValue
        const match = MARKER_ANY.exec(text)
        if (match === null) continue
        const parentNode = node.parentNode
        if (parentNode === null) return false
        const chip = document.createElement('span')
        chip.setAttribute('data-dsh-edit-chip', '')
        chip.textContent = '#编辑#'
        const before = text.slice(0, match.index)
        const after = text.slice(match.index + match[0].length).replace(/^[ \t]*\r?\n+/, '')
        if (before !== '') parentNode.insertBefore(document.createTextNode(before), node)
        parentNode.insertBefore(chip, node)
        if (after !== '') parentNode.insertBefore(document.createTextNode(after), node)
        parentNode.removeChild(node)
        return true
      }
      return false
    }

    function syncVoidedHistory() {
      for (const row of document.querySelectorAll('[data-chat-flow-kind="user"]')) {
        wrapMarker(row)
      }
    }

    // ── styles ───────────────────────────────────────────────────────────────

    const CSS = `
.demMenu{
  position:fixed; z-index:79; box-sizing:border-box; min-width:210px; padding:5px;
  pointer-events:auto; border-radius:10px; font-size:12.5px;
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1); box-shadow:0 12px 34px rgba(0,0,0,.22);
}
.demHeader{padding:5px 9px 7px; color:var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1.4}
.demName{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.demItem{
  display:flex; align-items:center; width:100%; box-sizing:border-box;
  height:30px; padding:0 10px; border:0; border-radius:6px; cursor:pointer;
  background:transparent; color:var(--dsw-alias-label-primary); font:inherit; text-align:left;
}
.demItem:hover{background:var(--dsw-alias-bg-layer-2)}
.demItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px}
.demItemLabel{overflow:hidden; text-overflow:ellipsis}
.demHint{padding:3px 10px 3px; font-size:11px; line-height:1.45; color:var(--dsw-alias-label-secondary)}
.demHintError{color:var(--dsw-alias-state-error-primary)}
.demPending{
  display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 4px 0 10px;
  border-radius:999px; font-size:11.5px; white-space:nowrap;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);
}
.demPendingLabel{line-height:1}
.demPendingCancel{
  width:18px; height:18px; padding:0; border:0; border-radius:50%; cursor:pointer;
  font:inherit; font-size:12px; line-height:1; color:var(--dsw-alias-label-secondary);
  background:transparent;
}
.demPendingCancel:hover{background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary)}
[data-dsh-edit-chip]{
  display:inline-flex; align-items:center; height:18px; padding:0 7px; margin-right:5px;
  border-radius:999px; font-size:11px; line-height:1; vertical-align:middle;
  color:color-mix(in srgb, #2e9e5b 62%, var(--dsw-alias-label-primary));
  background:color-mix(in srgb, #2e9e5b 15%, var(--dsw-alias-bg-layer-1));
  border:1px solid color-mix(in srgb, #2e9e5b 38%, var(--dsw-alias-border-l1));
  user-select:none;
}
`

    // ── plugin entry ─────────────────────────────────────────────────────────

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-edit-message', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => {
        if (style.parentNode !== null) style.parentNode.removeChild(style)
      })

      const locale = ctx.get('locale')
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        ctx.effect(() => {
          const disposers = []
          for (const id of ['zh-CN', 'zh', 'en-US', 'en']) {
            const dict = id.indexOf('zh') === 0 ? DICTS['zh-CN'] : DICTS['en-US']
            try {
              const dispose = locale.register(NS, id, dict)
              if (typeof dispose === 'function') disposers.push(dispose)
            } catch { /* custom namespaces may not be registrable in every profile */ }
          }
          return () => { for (const dispose of disposers) dispose() }
        })
      }
      const t = makeTranslator(locale)

      /** Send the composer draft with its void marker in front. */
      async function commitEdit() {
        const edit = pendingEdit.current
        if (edit === null) return false
        const bridge = pickBridge(edit.sessionId)
        if (bridge === undefined) return false
        const draft = bridge.draft()
        if (draft.trim() === '') {
          clearPendingEdit()
          return false
        }
        const final = MARKER_LEAD + '\n\n' + draft
        if (!bridge.setDraft(final)) return false
        const applied = await bridge.waitFor(final, 1500)
        if (!applied) return false
        clearPendingEdit()
        bridge.submit()
        return true
      }

      /** Whether the composer still holds a draft worth marking; clears a stale edit. */
      function holdsEditableDraft() {
        const edit = pendingEdit.current
        if (edit === null) return false
        const bridge = pickBridge(edit.sessionId)
        if (bridge === undefined || bridge.draft().trim() === '') {
          clearPendingEdit()
          return false
        }
        return true
      }

      ctx.effect(() => {
        let openedAt = 0

        /** The last user bubble in document order — the only one this can edit. */
        const latestUserRow = () => {
          const rows = document.querySelectorAll('[data-chat-flow-kind="user"]')
          return rows.length === 0 ? null : rows[rows.length - 1]
        }

        /** Whether a right-click target resolves to one editable user message. */
        const evaluate = (target) => {
          if (pendingEdit.current !== null && target.closest('[data-composer-card]') !== null) return null
          if (target.closest('[data-edit-menu-ui]') !== null) return null
          if (target.closest('[data-file-menu-ui]') !== null) return null
          if (target.closest('[data-codex-ui]') !== null) return null
          if (target.closest('[data-tool]') !== null) return null
          if (target.closest('[data-composer-card]') !== null) return null
          const row = target.closest('[data-chat-flow-kind="user"]')
          if (row === null) return null
          // Other plugins' own affordances keep their own right-click.
          const link = target.closest('button')
          if (link !== null && String(link.className).indexOf('fileLink') !== -1) return null
          if (target.closest('[data-ref-chip]') !== null) return null
          if (row.hasAttribute('data-submission-echo')) return null
          const info = nodeInfoNear(target)
          const authored = info.node !== null && String(info.node.kind) === 'user' ? textOfNode(info.node) : null
          const text = stripMarkerLines(authored !== null ? authored : domTextOfRow(row))
          if (text === '') return null
          // A marker can only name its target by position, so editing is offered
          // on the newest user message alone — and nowhere else, rather than
          // showing a menu whose only entry is disabled.
          if (row !== latestUserRow()) return null
          return {
            sessionId: info.sessionId,
            text,
            snippet: text.length > 24 ? text.slice(0, 24) + '…' : text,
          }
        }

        const openMenu = (event, resolved) => {
          openedAt = Date.now()
          setMenu({ x: event.clientX, y: event.clientY, ...resolved })
        }

        const onContextMenu = (event) => {
          const target = event.target instanceof Element ? event.target : null
          if (target === null) return
          const resolved = evaluate(target)
          if (resolved === null) return
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
          // The pointerdown fallback already opened this menu.
          if (Date.now() - openedAt < 400) return
          openMenu(event, resolved)
        }

        const onKeyDown = (event) => {
          if (pendingEdit.current === null) return
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
          const target = event.target instanceof Element ? event.target : null
          if (target === null || target.closest('[data-composer-card]') === null) return
          if (target.closest('[data-edit-menu-ui]') !== null) return
          if (!holdsEditableDraft()) return
          event.preventDefault()
          event.stopImmediatePropagation()
          commitEdit()
        }

        const onClick = (event) => {
          if (pendingEdit.current === null) return
          const target = event.target instanceof Element ? event.target : null
          if (target === null || target.closest('[data-composer-card]') === null) return
          const button = target.closest('button')
          if (button === null) return
          if (String(button.className).indexOf('primary') === -1) return
          // A running turn turns the primary button into stop; never intercept it.
          if (button.querySelector('rect') !== null) return
          if (!holdsEditableDraft()) return
          event.preventDefault()
          event.stopImmediatePropagation()
          commitEdit()
        }

        const onPointerDown = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-edit-menu-ui]') !== null) return
          if (menuStore.current !== null) setMenu(null)
        }

        const onKeyEscape = (event) => {
          if (event.key !== 'Escape' || menuStore.current === null) return
          event.stopPropagation()
          setMenu(null)
        }

        const onDismiss = () => {
          if (menuStore.current !== null) setMenu(null)
        }

        document.addEventListener('contextmenu', onContextMenu, true)
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('click', onClick, true)
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyEscape, true)
        window.addEventListener('scroll', onDismiss, true)
        window.addEventListener('resize', onDismiss)

        let frame = 0
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            syncVoidedHistory()
          })
        }
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        schedule()

        return () => {
          observer.disconnect()
          if (frame !== 0) window.cancelAnimationFrame(frame)
          document.removeEventListener('contextmenu', onContextMenu, true)
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('click', onClick, true)
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyEscape, true)
          window.removeEventListener('scroll', onDismiss, true)
          window.removeEventListener('resize', onDismiss)
        }
      })

      // The composer bridge reads the live draft and submits for the user.
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'edit-message-bridge',
        order: 95,
      }, (slotProps) => h(ComposerBridge, slotProps)))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'edit-message-menu',
        order: 45,
      }, () => h(MenuHost, { t })))

      // The pending-edit chip names the message a send will void.
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'edit-message-pending',
        order: 55,
      }, () => h(PendingChip, { t })))
    }

    // ── composer bridge component ────────────────────────────────────────────

    function ComposerBridge(props) {
      if (typeof props.useInput === 'function') return h(ComposerBridgeLive, props)
      return h(ComposerBridgeFallback, props)
    }

    function ComposerBridgeLive(props) {
      const state = props.useInput((snapshot) => snapshot)
      const latest = React.useRef({ draft: '', rev: 0, inputActions: null, sessionId: props.sessionId })
      latest.current.draft = state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''
      latest.current.rev = state !== null && state !== undefined && typeof state.draftRev === 'number' ? state.draftRev : 0
      latest.current.inputActions = props.inputActions
      latest.current.sessionId = props.sessionId

      React.useEffect(() => {
        if (typeof props.sessionId !== 'string') return undefined
        const bridge = makeBridge(latest, props.sessionId, true)
        bridges.set(props.sessionId, bridge)
        return () => {
          if (bridges.get(props.sessionId) === bridge) bridges.delete(props.sessionId)
        }
      }, [props.sessionId])

      return null
    }

    function ComposerBridgeFallback(props) {
      const latest = React.useRef({ draft: '', rev: 0, inputActions: props.inputActions, sessionId: props.sessionId })
      latest.current.inputActions = props.inputActions
      latest.current.sessionId = props.sessionId

      React.useEffect(() => {
        if (typeof props.sessionId !== 'string') return undefined
        const bridge = makeBridge(latest, props.sessionId, false)
        bridges.set(props.sessionId, bridge)
        return () => {
          if (bridges.get(props.sessionId) === bridge) bridges.delete(props.sessionId)
        }
      }, [props.sessionId, props.inputActions])

      return null
    }

    return {
      name: 'dsh-edit-message-client',
      inject: ['slots'],
      apply,
    }
  },
})
