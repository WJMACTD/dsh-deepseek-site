window.__ModuleLoader__.load({
  id: 'dsh-deepseek-site',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'deepseek-site'
    /** The `sidebar.panellist` id, the `main` key and the `conversation.view` id. */
    const PANEL_ID = 'deepseek-site'
    const SITE_URL = 'https://chat.deepseek.com/'
    /** Prefix every site document shares; the guest also loads about:blank first. */
    const SITE_ORIGIN = 'https://chat.deepseek.com'

    /**
     * Storage identity for the embedded guest. The desktop shell maps it to one
     * process-lifetime partition, so cookies/login survive panel re-mounts.
     */
    const WORKSPACE_KEY = 'dsh-deepseek-site'
    /**
     * Durable copy of the site's sign-in state. The desktop shell hands every
     * guest a process-lifetime partition, so the guest's own localStorage is
     * empty again after a restart; the application document's localStorage does
     * survive restarts, so the token is parked there and replayed into a fresh
     * guest before the site boots.
     */
    const SIGN_IN_KEY = 'deepseek-site:sign-in:v1'
    /** Local-only diagnostic trail; never contains credentials or response bodies. */
    const DIAG_KEY = 'deepseek-site:diag:v1'

    /**
     * The only guest keys worth keeping. `userToken` is the credential and
     * `__appKit_userInfo` carries the session identity the site restores from;
     * every other key (feature flags, remote experiment id) is rebuildable by
     * the site itself and is deliberately NOT copied out of the guest.
     */
    const SNAPSHOT_KEYS = ['userToken', '__appKit_userInfo']
    /** A single stored value larger than this is treated as corrupt and skipped. */
    const MAX_VALUE_LENGTH = 65536
    /** How often a mounted, visible panel refreshes the stored snapshot. */
    const CAPTURE_INTERVAL_MS = 15000
    /** Replay attempts per guest mount, so a rejected token cannot reload forever. */
    const RESTORE_ATTEMPT_LIMIT = 2
    /** Ring-buffer size for the diagnostic trail. */
    const DIAG_LIMIT = 20
    /** One off-site link clicked twice within this window opens the browser once. */
    const EXTERNAL_DEDUPE_MS = 2000
    /** How often the floating page re-reads its anchor rectangle. */
    const PLACE_INTERVAL_MS = 200

    /**
     * @param url - a guest URL as reported by `webview.getURL()` or a navigation event.
     * @returns whether the guest is currently on the site document rather than about:blank.
     */
    function isSiteUrl(url) {
      return typeof url === 'string' && url.indexOf(SITE_ORIGIN) === 0
    }

    /**
     * Pick the URL to judge a load by. The placeholder document the lease
     * requires (`about:blank#<lease>`) has an opaque origin, so it must never be
     * mistaken for the site: its URL is dropped on both sides and the live
     * `getURL()` value is preferred over the remembered navigation event.
     * @param lastUrl - last main-frame URL seen by a navigation event.
     * @param elementUrl - `webview.getURL()`, or '' when unavailable.
     * @returns the site URL, or '' when the guest is not on a real document.
     */
    function pickUrl(lastUrl, elementUrl) {
      const usable = (value) => typeof value === 'string' && value !== '' && value.indexOf('about:') !== 0
      if (usable(elementUrl)) return elementUrl
      if (usable(lastUrl)) return lastUrl
      return ''
    }

    /**
     * @param visibilityState - `document.visibilityState` of the host window.
     * @param nextJson - candidate snapshot, already serialized.
     * @param lastJson - snapshot this panel last wrote, or null.
     * @returns whether the candidate is worth a localStorage write.
     */
    function shouldCapture(visibilityState, nextJson, lastJson) {
      if (visibilityState !== 'visible') return false
      if (typeof nextJson !== 'string' || nextJson === '' || nextJson === '{}') return false
      return nextJson !== lastJson
    }

    /**
     * Reduce a raw capture to the keys this plugin is willing to persist.
     * @param raw - parsed `CAPTURE_SCRIPT` output.
     * @returns the minimized snapshot, or null when it carries no usable token.
     */
    function minimizeSnapshot(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const out = {}
      for (let i = 0; i < SNAPSHOT_KEYS.length; i += 1) {
        const key = SNAPSHOT_KEYS[i]
        const value = raw[key]
        if (typeof value === 'string' && value !== '' && value.length <= MAX_VALUE_LENGTH) out[key] = value
      }
      return tokenValue(out.userToken) === '' ? null : out
    }

    /**
     * Guest-side read of the two persisted keys.
     * @returns source for `webview.executeJavaScript`, resolving to a JSON object string.
     */
    const CAPTURE_SCRIPT =
      '(function(){try{var keys=' +
      JSON.stringify(SNAPSHOT_KEYS) +
      ';var out={};for(var i=0;i<keys.length;i+=1){var k=keys[i];var v=localStorage.getItem(k);' +
      'if(typeof v==="string"&&v.length>0&&v.length<=' +
      String(MAX_VALUE_LENGTH) +
      ')out[k]=v}return JSON.stringify(out)}catch(e){return ""}})()'

    /**
     * Guest-side expression yielding the *effective* token, or '' when the site
     * has none. The site parks a logged-out marker (`{"value":null}`) in
     * `userToken`, so "the key exists" is not the same as "signed in".
     */
    const TOKEN_EXPR =
      '(function(){try{var r=localStorage.getItem("userToken");if(r===null||r==="")return "";' +
      'try{var o=JSON.parse(r);return o&&typeof o.value==="string"?(o.value||""):""}catch(e){' +
      'return r==="null"?"":r}}catch(e){return ""}})()'

    /** Guest-side wipe, used by the "forget saved sign-in" action. */
    const CLEAR_SCRIPT =
      '(function(){try{var keys=' +
      JSON.stringify(SNAPSHOT_KEYS) +
      ';for(var i=0;i<keys.length;i+=1)localStorage.removeItem(keys[i]);return true}catch(e){return false}})()'

    /**
     * Build the guest-side script that replays a stored snapshot.
     * @param snapshot - key/value pairs captured from an earlier sign-in.
     * @returns source for `webview.executeJavaScript`, resolving to whether it wrote anything.
     */
    function restoreScript(snapshot) {
      return (
        '(function(){try{var data=' +
        JSON.stringify(snapshot) +
        ';if(!data||typeof data!=="object")return false;var cur=' +
        TOKEN_EXPR +
        ';var blank=(cur==="");var wrote=false;' +
        'for(var k in data){if(!Object.prototype.hasOwnProperty.call(data,k))continue;' +
        'if(k==="userToken"&&!blank)continue;var v=data[k];if(typeof v!=="string"||v.length===0)continue;' +
        'if(k==="userToken"||localStorage.getItem(k)===null){try{localStorage.setItem(k,v);wrote=true}catch(e){}}}' +
        'return wrote}catch(e){return false}})()'
      )
    }

    /**
     * @param raw - a stored `userToken` value (`{"value":"…"}` or a bare token).
     * @returns the token itself, or '' for a logged-out marker.
     */
    function tokenValue(raw) {
      if (typeof raw !== 'string' || raw === '' || raw === 'null') return ''
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return ''
        return typeof parsed.value === 'string' ? parsed.value : ''
      } catch (_error) {
        return raw
      }
    }

    /**
     * Drop only the `Electron/<version>` product token from a user agent. The
     * site's risk control flags non-browser hosts by that token, while nothing
     * else in the Chromium fingerprint is touched: platform, versions and
     * feature set stay honest, so this is not browser spoofing.
     * @param ua - `navigator.userAgent`.
     * @returns the same user agent without the Electron token.
     */
    function stripElectronToken(ua) {
      if (typeof ua !== 'string' || ua === '') return ''
      return ua
        .replace(/\s*Electron\/[0-9A-Za-z.\-_]+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    }

    /**
     * Decide whether an off-site link should leave the app. Same-site links stay
     * in the guest; a repeated off-site URL inside the dedupe window is dropped
     * so one click (mousedown + click, or a redirect chain) opens one window.
     * @param url - the requested URL.
     * @param last - `{ url, at }` of the previous off-site open, or null.
     * @param now - `Date.now()`.
     * @returns the URL to hand to the system browser, or null.
     */
    function planExternalOpen(url, last, now) {
      if (typeof url !== 'string' || url.indexOf('https://') !== 0) return null
      if (isSiteUrl(url)) return null
      if (last && last.url === url && now - last.at < EXTERNAL_DEDUPE_MS) return null
      return url
    }

    /** Log a recoverable failure without swallowing it silently. */
    function warn(label, error) {
      try {
        console.warn('deepseek-site: ' + label, error)
      } catch (_error) {
        /* console may be unavailable in a stripped renderer. */
      }
    }

    /**
     * Append one local-only diagnostic entry. The trail deliberately holds no
     * token, no response body and no cookie names.
     * @param entry - `{ at, note, attempts, tokenLen }`.
     */
    function writeDiag(entry) {
      try {
        let list = []
        try {
          const prev = JSON.parse(window.localStorage.getItem(DIAG_KEY) || '[]')
          if (Array.isArray(prev)) list = prev
        } catch (_error) {
          list = []
        }
        list.push(entry)
        while (list.length > DIAG_LIMIT) list.shift()
        window.localStorage.setItem(DIAG_KEY, JSON.stringify(list))
      } catch (error) {
        warn('diagnostics skipped', error)
      }
    }

    /** @returns the stored snapshot, or null when this application has never seen a sign-in. */
    function readSignIn() {
      try {
        const raw = window.localStorage.getItem(SIGN_IN_KEY)
        if (raw === null || raw === '') return null
        return minimizeSnapshot(JSON.parse(raw))
      } catch (error) {
        warn('stored snapshot unreadable', error)
        return null
      }
    }

    /**
     * @param snapshot - minimized capture from the guest.
     * @returns whether the application document accepted the write.
     */
    function writeSignIn(snapshot) {
      try {
        window.localStorage.setItem(SIGN_IN_KEY, JSON.stringify(snapshot))
        return true
      } catch (error) {
        warn('snapshot write failed', error)
        return false
      }
    }

    /** Drop the stored snapshot and the diagnostic trail. */
    function forgetSignIn() {
      try {
        window.localStorage.removeItem(SIGN_IN_KEY)
      } catch (error) {
        warn('snapshot removal failed', error)
      }
      try {
        window.localStorage.removeItem(DIAG_KEY)
      } catch (error) {
        warn('diagnostics removal failed', error)
      }
    }

    const zh = {
      nav: 'DeepSeek 官网',
      tab: '官网',
      title: 'DeepSeek 官网',
      loading: '正在加载 chat.deepseek.com…',
      reload: '重新加载',
      external: '在系统浏览器打开',
      forget: '忘记本机登录',
      forgetHint: '清除本机保存的登录快照（站点会回到登录页）',
      remembered: '已记住登录',
      rememberedHint: '登录快照以明文保存在本机应用数据目录，等同于账号凭据',
      keepAliveHint: '切到别的面板不会卸载这个页面，回来时对话、滚动位置和正在生成的回答都还在原处',
      unsupportedTitle: '当前窗口无法内嵌网页',
      unsupportedHint:
        '内嵌需要 Harness 桌面版提供的受限浏览器容器（window.dshDesktop.browser）。请在桌面版应用中打开本面板；在普通浏览器里只能走外部窗口。',
      failedTitle: '页面加载失败',
      failedHint: '可能是网络不可用，或者内嵌容器被拒绝。可以重试，或改用系统浏览器。',
      retry: '重试',
      restoreSaved: '已回填登录',
      restoreLive: '登录有效',
      restoreMiss: '无登录快照',
    }
    const en = {
      nav: 'DeepSeek site',
      tab: 'DeepSeek',
      title: 'DeepSeek',
      loading: 'Loading chat.deepseek.com…',
      reload: 'Reload',
      external: 'Open in system browser',
      forget: 'Forget saved sign-in',
      forgetHint: 'Delete the sign-in snapshot stored on this machine (the site returns to its sign-in page)',
      remembered: 'Sign-in saved',
      rememberedHint:
        'The snapshot is stored in plain text in this app’s data directory; treat it as an account credential',
      keepAliveHint:
        'Switching panels never unloads this page: your conversation, scroll position and a streaming answer are still there when you come back',
      unsupportedTitle: 'This window cannot embed pages',
      unsupportedHint:
        'Embedding needs the restricted browser container the Harness desktop shell exposes as window.dshDesktop.browser. Open this panel inside the desktop app; a plain browser tab can only use an external window.',
      failedTitle: 'The page failed to load',
      failedHint:
        'The network may be unavailable, or the embed container refused the page. Retry, or use the system browser.',
      retry: 'Retry',
      restoreSaved: 'Sign-in replayed',
      restoreLive: 'Sign-in active',
      restoreMiss: 'No saved sign-in',
    }

    /**
     * Sidebar glyph: an outbound arrow leaving a rounded square, drawn in
     * currentColor so it follows the sidebar's own active/idle styling.
     * @param props.size - square edge requested by the sidebar owner.
     * @param props.active - whether this panel is the selected one.
     */
    function Mark(props) {
      const size = props.size || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M6.4 2.6H3.9c-.72 0-1.3.58-1.3 1.3v8.2c0 .72.58 1.3 1.3 1.3h8.2c.72 0 1.3-.58 1.3-1.3V9.6',
          stroke: 'currentColor',
          strokeWidth: props.active ? 1.7 : 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M9.1 2.6h4.3v4.3',
          stroke: 'currentColor',
          strokeWidth: props.active ? 1.7 : 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.2 2.8 7.8 8.2',
          stroke: 'currentColor',
          strokeWidth: props.active ? 1.7 : 1.5,
          strokeLinecap: 'round',
        })
      )
    }

    /** Small action used in the page toolbar. */
    function ToolbarButton(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          title: props.title,
          disabled: props.disabled,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 10px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent',
            color: props.disabled ? 'var(--dsw-alias-state-idle-primary)' : 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1,
            cursor: props.disabled ? 'default' : 'pointer',
          },
        },
        props.children
      )
    }

    /**
     * Toolbar: identity, load state, sign-in state and the actions. The
     * conversation-tab entry renders the compact form, because that strip is
     * already inside the conversation chrome.
     */
    function Toolbar(props) {
      const t = props.t
      const pill = () =>
        h(
          'span',
          {
            title: t('rememberedHint'),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 22,
              padding: '0 8px',
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 11,
              whiteSpace: 'nowrap',
            },
          },
          t('remembered')
        )
      const noteText = t(
        props.restoreNote === 'saved' ? 'restoreSaved' : props.restoreNote === 'live' ? 'restoreLive' : 'restoreMiss'
      )
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: props.compact ? '0 12px 8px' : '0 16px 10px',
            flex: '0 0 auto',
          },
        },
        h(
          'div',
          {
            title: t('keepAliveHint'),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              flex: '1 1 auto',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13,
              fontWeight: 600,
            },
          },
          h(Mark, { size: 15 }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('title'))
        ),
        props.loading
          ? h(
              'span',
              { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, whiteSpace: 'nowrap' } },
              t('loading')
            )
          : null,
        props.remembered ? pill() : null,
        props.restoreNote === ''
          ? null
          : h(
              'span',
              {
                title: noteText,
                style: {
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                  opacity: 0.8,
                },
              },
              noteText
            ),
        props.remembered ? h(ToolbarButton, { onClick: props.onForget, title: t('forgetHint') }, t('forget')) : null,
        props.showGuest ? h(ToolbarButton, { onClick: props.onReload, title: t('reload') }, t('reload')) : null,
        h(ToolbarButton, { onClick: props.onExternal, title: t('external') }, t('external'))
      )
    }

    /** Shown instead of the page when embedding is unavailable or the load failed. */
    function FallbackCard(props) {
      const t = props.t
      const unsupported = props.status === 'unsupported'
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            flex: '1 1 auto',
            padding: '0 24px 40px',
            textAlign: 'center',
          },
        },
        h(
          'div',
          {
            style: {
              maxWidth: 460,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              alignItems: 'center',
            },
          },
          h(
            'div',
            { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 15, fontWeight: 600 } },
            t(unsupported ? 'unsupportedTitle' : 'failedTitle')
          ),
          h(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.7 } },
            t(unsupported ? 'unsupportedHint' : 'failedHint')
          ),
          props.detail === ''
            ? null
            : h(
                'div',
                {
                  style: {
                    color: 'var(--dsw-alias-label-secondary)',
                    fontSize: 12,
                    opacity: 0.75,
                    wordBreak: 'break-word',
                  },
                },
                props.detail
              ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, paddingTop: 4 } },
            unsupported ? null : h(ToolbarButton, { onClick: props.onRetry, title: t('retry') }, t('retry')),
            h(ToolbarButton, { onClick: props.onExternal, title: t('external') }, t('external'))
          )
        )
      )
    }

    /* ------------------------------------------------------------------ *
     * One page for the whole application
     *
     * chat.deepseek.com sends `frame-ancestors 'none'`, so an iframe can never
     * work; the desktop shell's leased `<webview>` guest is the only container
     * allowed to show it. The guest is a separate WebContents, so it survives
     * React remounts — as long as its element stays connected to the document.
     * Therefore the page lives in a body-level container for the whole app
     * lifetime, and every entry (sidebar icon, main panel, conversation tab)
     * only repositions that container over its own anchor. Switching entries
     * never reloads the page: a streaming answer keeps streaming.
     * ------------------------------------------------------------------ */

    /** @type {null | ReturnType<typeof createBrowser>} */
    let browser = null

    /**
     * Build the single page instance.
     * @param bridge - `window.dshDesktop.browser`.
     */
    function createBrowser(bridge) {
      const container = document.createElement('div')
      container.setAttribute('data-deepseek-site', 'page')
      container.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;display:none;z-index:30;overflow:hidden;' +
        'border-radius:11px;background:var(--dsw-alias-bg-layer-1);'
      /**
       * Opaque cover shown until the site document is interactive. Without it
       * the first paint after a sign-in replay shows the site's own login page
       * for a frame before the replayed token takes effect.
       */
      const cover = document.createElement('div')
      cover.style.cssText =
        'position:absolute;inset:0;z-index:1;background:var(--dsw-alias-bg-layer-1);' +
        'display:flex;align-items:center;justify-content:center;'
      const dot = document.createElement('span')
      dot.style.cssText =
        'width:18px;height:18px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);' +
        'border-top-color:var(--dsw-alias-label-secondary);animation:dsh-deepseek-site-spin 900ms linear infinite;'
      const spin = document.createElement('style')
      spin.textContent = '@keyframes dsh-deepseek-site-spin{to{transform:rotate(360deg)}}'
      cover.appendChild(dot)
      container.appendChild(spin)
      container.appendChild(cover)
      document.body.appendChild(container)

      const state = {
        status: 'loading',
        detail: '',
        remembered: readSignIn() !== null,
        restoreNote: '',
      }
      const subscribers = new Set()
      const emit = () => {
        const snapshot = { status: state.status, detail: state.detail, remembered: state.remembered, restoreNote: state.restoreNote }
        subscribers.forEach((fn) => {
          try {
            fn(snapshot)
          } catch (error) {
            warn('subscriber failed', error)
          }
        })
      }

      let alive = true
      let guest = null
      let lease = null
      let loaded = false
      let replayed = false
      let restoreAttempts = 0
      let lastUrl = ''
      let lastWrittenJson = null
      let lastDiagKey = ''
      let lastExternal = null
      let current = null
      let placeTimer = null
      let captureTimer = null
      const signals = new AbortController()
      let stopOpenRequests = null

      try {
        const saved = readSignIn()
        lastWrittenJson = saved === null ? null : JSON.stringify(saved)
      } catch (error) {
        warn('snapshot probe failed', error)
      }

      /** @returns the guest's live document URL, or '' on the placeholder. */
      const currentUrl = () => {
        let fromElement = ''
        if (guest !== null) {
          try {
            fromElement = typeof guest.getURL === 'function' ? guest.getURL() : ''
          } catch (error) {
            warn('getURL failed', error)
          }
        }
        return pickUrl(lastUrl, fromElement)
      }

      /** Hide the cover once the site document itself is up. */
      const updateCover = () => {
        cover.style.display = state.status === 'ready' ? 'none' : 'flex'
      }

      const setStatus = (next, detail) => {
        state.status = next
        if (typeof detail === 'string') state.detail = detail
        updateCover()
        emit()
      }

      const note = (value) => {
        state.restoreNote = value
        emit()
      }

      /**
       * Copy the guest's current sign-in state into the application document.
       * @param force - write even when the host window is not visible (panel hide).
       */
      const capture = (force) => {
        if (!alive || guest === null) return
        if (typeof guest.executeJavaScript !== 'function') return
        try {
          const running = guest.executeJavaScript(CAPTURE_SCRIPT)
          if (running === null || running === undefined || typeof running.then !== 'function') return
          running
            .then((json) => {
              if (!alive) return
              // The placeholder `about:blank#<lease>` document has an opaque
              // origin, so the read fails there and yields ''; that is not an
              // error worth logging.
              if (typeof json !== 'string' || json === '') return
              let snapshot = null
              try {
                snapshot = minimizeSnapshot(JSON.parse(json))
              } catch (error) {
                warn('capture payload unreadable', error)
                return
              }
              if (snapshot === null) return
              const serialized = JSON.stringify(snapshot)
              const visibility = force === true ? 'visible' : document.visibilityState
              if (!shouldCapture(visibility, serialized, lastWrittenJson)) return
              if (writeSignIn(snapshot)) {
                lastWrittenJson = serialized
                state.remembered = true
                emit()
              }
            })
            .catch((error) => warn('capture failed', error))
        } catch (error) {
          /* A shell without executeJavaScript simply never remembers a sign-in. */
          warn('capture unavailable', error)
        }
      }

      /**
       * Replay the snapshot into the site document, then reload once so the site
       * boots with the token already in place. The snapshot can only be written
       * into the real site document — the `about:blank#<lease>` placeholder has
       * an opaque origin — so this runs on the site's own load. The attempt
       * budget keeps a server-rejected token from reloading forever, and
       * `replayed` keeps the reload itself from replaying a second time.
       */
      const restoreSignIn = () => {
        if (replayed) {
          note('live')
          capture()
          return
        }
        const saved = readSignIn()
        if (saved === null || restoreAttempts >= RESTORE_ATTEMPT_LIMIT) {
          note('miss')
          capture()
          return
        }
        if (guest === null || typeof guest.executeJavaScript !== 'function') {
          note('miss')
          capture()
          return
        }
        restoreAttempts += 1
        guest
          .executeJavaScript(TOKEN_EXPR)
          .then((live) => {
            if (!alive || guest === null) return undefined
            if (typeof live === 'string' && live !== '') {
              note('live')
              capture()
              return undefined
            }
            return guest.executeJavaScript(restoreScript(saved)).then((wrote) => {
              if (!alive || guest === null) return
              if (wrote !== true) {
                note('miss')
                capture()
                return
              }
              replayed = true
              note('saved')
              setStatus('loading')
              try {
                guest.reload()
              } catch (error) {
                warn('reload after replay failed', error)
                capture()
              }
            })
          })
          .catch((error) => {
            warn('replay failed', error)
            note('miss')
            capture()
          })
      }

      /** `dom-ready` fires for the placeholder first; the site load starts here. */
      const load = () => {
        if (guest === null || !alive || loaded) return
        loaded = true
        try {
          guest.loadURL(SITE_URL).catch((error) => {
            if (!alive) return
            setStatus('failed', String((error && error.message) || error))
          })
        } catch (error) {
          setStatus('failed', String((error && error.message) || error))
        }
      }

      /** Keep the main-frame URL current, so the placeholder can be told apart. */
      const trackUrl = (event) => {
        if (event && event.isMainFrame === false) return
        const url = event && event.url
        lastUrl = typeof url === 'string' && url !== '' && url.indexOf('about:') !== 0 ? url : ''
      }

      /** Leave the app for a link that does not belong to the site. */
      const leaveApp = (url) => {
        const now = Date.now()
        const target = planExternalOpen(url, lastExternal, now)
        if (target === null) return
        lastExternal = { url: target, at: now }
        try {
          window.open(target, '_blank')
        } catch (error) {
          warn('external open failed', error)
        }
      }

      bridge
        .acquire(WORKSPACE_KEY)
        .then((reservation) => {
          if (!alive) {
            if (typeof bridge.release === 'function') {
              bridge.release(reservation.lease).catch((error) => warn('lease release failed', error))
            }
            return
          }
          lease = reservation.lease
          const element = document.createElement('webview')
          element.setAttribute('name', lease)
          element.setAttribute('partition', reservation.partition)
          element.setAttribute('allowpopups', '')
          element.setAttribute('src', 'about:blank#' + lease)
          element.setAttribute('data-sidebar-browser-frame', 'webview')
          element.style.cssText =
            'display:flex;flex:1 1 auto;width:100%;height:100%;min-height:0;border:0;background:transparent;'
          const agent = stripElectronToken(typeof navigator === 'undefined' ? '' : navigator.userAgent)
          if (agent !== '' && typeof element.setUserAgent === 'function') {
            try {
              element.setUserAgent(agent)
            } catch (error) {
              warn('user agent override failed', error)
            }
          }
          element.addEventListener('dom-ready', load, { signal: signals.signal })
          element.addEventListener(
            'did-fail-load',
            (event) => {
              // Only a definite main-frame failure counts; -3 is an aborted load.
              if (!alive || !event || event.isMainFrame !== true || event.errorCode === -3) return
              setStatus('failed', String(event.errorDescription || ''))
            },
            { signal: signals.signal }
          )
          element.addEventListener('did-start-navigation', trackUrl, { signal: signals.signal })
          element.addEventListener('did-navigate', trackUrl, { signal: signals.signal })
          element.addEventListener(
            'did-finish-load',
            () => {
              if (!alive || !isSiteUrl(currentUrl())) return
              setStatus('ready')
              restoreSignIn()
              // Local-only trail, written only when something actually changed.
              let tokenLen = 0
              try {
                const saved = readSignIn()
                tokenLen = saved === null ? 0 : tokenValue(saved.userToken).length
              } catch (error) {
                warn('snapshot probe failed', error)
              }
              const key = state.restoreNote + '|' + restoreAttempts + '|' + tokenLen
              if (key !== lastDiagKey) {
                lastDiagKey = key
                writeDiag({
                  at: new Date().toISOString(),
                  note: state.restoreNote,
                  attempts: restoreAttempts,
                  tokenLen,
                })
              }
            },
            { signal: signals.signal }
          )
          element.addEventListener('did-navigate-in-page', () => capture(), { signal: signals.signal })
          container.appendChild(element)
          guest = element
          updateCover()
          if (typeof bridge.onOpenRequested === 'function') {
            stopOpenRequests = bridge.onOpenRequested(lease, (url) => {
              if (!alive || guest === null) return
              // The shell only forwards http(s), but the decision stays local:
              // anything outside the site leaves the app instead of loading here.
              if (!isSiteUrl(url)) {
                leaveApp(url)
                return
              }
              try {
                guest.loadURL(url).catch((error) => warn('guest navigation failed', error))
              } catch (error) {
                warn('guest navigation failed', error)
              }
            })
          }
        })
        .catch((error) => {
          if (!alive) return
          setStatus('failed', String((error && error.message) || error))
        })

      /** Position the page over the anchor of the entry that currently owns it. */
      const place = () => {
        const anchor = current === null ? null : current.anchor
        if (anchor === null || anchor === undefined || !anchor.isConnected) {
          container.style.display = 'none'
          return
        }
        const rect = anchor.getBoundingClientRect()
        if (rect.width < 8 || rect.height < 8) {
          container.style.display = 'none'
          return
        }
        container.style.display = 'flex'
        container.style.left = rect.left + 'px'
        container.style.top = rect.top + 'px'
        container.style.width = rect.width + 'px'
        container.style.height = rect.height + 'px'
      }

      const stopTimers = () => {
        if (placeTimer !== null) {
          window.clearInterval(placeTimer)
          placeTimer = null
        }
        if (captureTimer !== null) {
          window.clearInterval(captureTimer)
          captureTimer = null
        }
      }

      window.addEventListener('resize', place, { signal: signals.signal })
      window.addEventListener('scroll', place, { capture: true, signal: signals.signal })

      return {
        getState: () => ({
          status: state.status,
          detail: state.detail,
          remembered: state.remembered,
          restoreNote: state.restoreNote,
        }),
        subscribe(fn) {
          subscribers.add(fn)
          try {
            fn(this.getState())
          } catch (error) {
            warn('subscriber failed', error)
          }
          return () => subscribers.delete(fn)
        },
        /**
         * Show the page over this anchor.
         * @returns a handle that only hides the page while it is still the owner,
         *          so a remount of one entry cannot hide the other entry's page.
         */
        attach(anchor) {
          const handle = { anchor }
          current = handle
          place()
          if (placeTimer === null) placeTimer = window.setInterval(place, PLACE_INTERVAL_MS)
          if (captureTimer === null) captureTimer = window.setInterval(() => capture(), CAPTURE_INTERVAL_MS)
          return handle
        },
        detach(handle) {
          if (handle === undefined || current !== handle) return
          // Store the freshest token before the page goes out of sight.
          capture(true)
          current = null
          container.style.display = 'none'
          stopTimers()
        },
        reload() {
          if (guest === null) return
          setStatus('loading')
          try {
            guest.reload()
          } catch (error) {
            warn('reload failed', error)
          }
        },
        retry() {
          if (guest === null) return
          loaded = true
          setStatus('loading')
          try {
            guest.loadURL(SITE_URL).catch((error) => warn('retry failed', error))
          } catch (error) {
            warn('retry failed', error)
          }
        },
        openExternal() {
          // The toolbar action opens the site itself, so it bypasses the
          // site-vs-offsite test and only respects the dedupe window.
          const now = Date.now()
          if (lastExternal !== null && lastExternal.url === SITE_URL && now - lastExternal.at < EXTERNAL_DEDUPE_MS) return
          lastExternal = { url: SITE_URL, at: now }
          try {
            window.open(SITE_URL, '_blank')
          } catch (error) {
            warn('external open failed', error)
          }
        },
        /**
         * Drop the local snapshot AND the guest's copy, so "forget" cannot be
         * undone by the next capture from a still-signed-in guest.
         */
        forget() {
          forgetSignIn()
          lastWrittenJson = null
          state.remembered = false
          state.restoreNote = ''
          emit()
          if (guest === null || typeof guest.executeJavaScript !== 'function') return
          try {
            const running = guest.executeJavaScript(CLEAR_SCRIPT)
            if (running === null || running === undefined || typeof running.then !== 'function') return
            running
              .then(() => {
                try {
                  guest.reload()
                } catch (error) {
                  warn('reload after forget failed', error)
                }
              })
              .catch((error) => warn('forget failed', error))
          } catch (error) {
            warn('forget failed', error)
          }
        },
        destroy() {
          alive = false
          stopTimers()
          signals.abort()
          if (typeof stopOpenRequests === 'function') stopOpenRequests()
          stopOpenRequests = null
          if (guest !== null) {
            guest.remove()
            guest = null
          }
          container.remove()
          if (lease !== null && typeof bridge.release === 'function') {
            bridge.release(lease).catch((error) => warn('lease release failed', error))
          }
          lease = null
          // The module keeps one instance; dropping it here means a later mount
          // (plugin reload) builds a fresh page instead of reusing a dead one.
          browser = null
        },
      }
    }

    /**
     * @returns the single page instance, or null when this window has no
     *          desktop browser bridge (the web build, or a stripped shell).
     */
    function ensureBrowser() {
      if (browser !== null) return browser
      const bridge = typeof window === 'undefined' ? null : window.dshDesktop && window.dshDesktop.browser
      if (bridge === null || bridge === undefined || typeof bridge.acquire !== 'function') return null
      browser = createBrowser(bridge)
      return browser
    }

    /**
     * One entry into the shared page: the main panel (`mode: 'panel'`) and the
     * conversation tab (`mode: 'conversation'`) differ only in chrome and in how
     * much of the area the anchor claims.
     */
    function BrowserView(props) {
      const t = props.t
      const compact = props.mode === 'conversation'
      const anchorRef = React.useRef(null)
      const page = React.useMemo(() => ensureBrowser(), [])
      const [state, setState] = React.useState(() =>
        page === null
          ? { status: 'unsupported', detail: '', remembered: false, restoreNote: '' }
          : page.getState()
      )
      const [generation, setGeneration] = React.useState(0)

      React.useEffect(() => {
        if (page === null) return undefined
        const unsubscribe = page.subscribe(setState)
        return () => {
          unsubscribe()
        }
      }, [page])

      const failed = state.status === 'failed'
      React.useEffect(() => {
        if (page === null || failed) return undefined
        const handle = page.attach(anchorRef.current)
        return () => page.detach(handle)
      }, [page, failed, generation])

      // A retry rebuilds the page only after a hard failure; normal reloads keep
      // the guest, because the point of this plugin is that it never reloads.
      const onRetry = React.useCallback(() => {
        if (page === null) return
        page.retry()
        setGeneration((value) => value + 1)
      }, [page])

      const showGuest = page !== null && !failed

      return h(
        'div',
        {
          style: {
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            padding: compact ? '0' : 'calc(18px + var(--dsh-frame-top-clearance, 0px)) 0 0',
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        h(Toolbar, {
          t,
          compact,
          loading: state.status === 'loading',
          remembered: state.remembered,
          restoreNote: state.restoreNote,
          showGuest,
          onReload: () => page && page.reload(),
          onForget: () => page && page.forget(),
          onExternal: () => page && page.openExternal(),
        }),
        h(
          'div',
          {
            style: {
              boxSizing: 'border-box',
              display: showGuest ? 'flex' : 'none',
              flex: '1 1 auto',
              minHeight: 0,
              margin: compact ? '0 12px 12px' : '0 12px 12px',
              borderRadius: 12,
              overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
          // The page itself is body-level; this element only reports where it goes.
          h('div', {
            ref: anchorRef,
            'data-deepseek-site-anchor': compact ? 'conversation' : 'panel',
            style: { display: 'flex', flex: '1 1 auto', minHeight: 0, minWidth: 0 },
          })
        ),
        showGuest
          ? null
          : h(FallbackCard, {
              t,
              status: page === null ? 'unsupported' : state.status,
              detail: state.detail,
              onRetry,
              onExternal: () => page && page.openExternal(),
            })
      )
    }

    return {
      name: 'deepseek-site',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-site: dictionaries')
        const t = ctx.locale.bind(NS)

        const markDisposer = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 3,
              label: () => t('nav'),
              locale: NS,
            },
            (owner) => h(Mark, { size: owner && owner.size, active: !!(owner && owner.active) })
          )
        )

        const pageDisposer = ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, () =>
            h(BrowserView, { t, mode: 'panel' })
          )
        )

        const tabDisposer = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: PANEL_ID, order: 25, label: () => t('tab') },
            () => h(BrowserView, { t, mode: 'conversation' })
          )
        )

        ctx.effect(() => () => {
          if (typeof markDisposer === 'function') markDisposer()
          if (typeof pageDisposer === 'function') pageDisposer()
          if (typeof tabDisposer === 'function') tabDisposer()
        }, 'deepseek-site: slot registrations')

        ctx.effect(() => () => {
          if (browser !== null) {
            browser.destroy()
            browser = null
          }
        }, 'deepseek-site: page teardown')

        ctx.inject(['layout'], (scoped) => {
          const layout = scoped.layout
          scoped.effect(() => () => {
            const info = layout && layout.panelInfo
            const active = info && typeof info.getSnapshot === 'function' ? info.getSnapshot().activePanelId : undefined
            if (active === PANEL_ID && typeof layout.selectPanel === 'function') layout.selectPanel(null)
          }, 'deepseek-site: panel cleanup')
        })
      },
    }
  },
})
