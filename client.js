window.__ModuleLoader__.load({
  id: 'dsh-deepseek-site',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'deepseek-site'
    /** The `sidebar.panellist` id and the `main` key: one id, one destination. */
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
      title: 'DeepSeek 官网',
      loading: '正在加载 chat.deepseek.com…',
      reload: '重新加载',
      external: '在系统浏览器打开',
      forget: '忘记本机登录',
      forgetHint: '清除本机保存的登录快照（站点会回到登录页）',
      remembered: '已记住登录',
      rememberedHint: '登录快照以明文保存在本机应用数据目录，等同于账号凭据',
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
      title: 'DeepSeek',
      loading: 'Loading chat.deepseek.com…',
      reload: 'Reload',
      external: 'Open in system browser',
      forget: 'Forget saved sign-in',
      forgetHint: 'Delete the sign-in snapshot stored on this machine (the site returns to its sign-in page)',
      remembered: 'Sign-in saved',
      rememberedHint: 'The snapshot is stored in plain text in this app’s data directory; treat it as an account credential',
      unsupportedTitle: 'This window cannot embed pages',
      unsupportedHint:
        'Embedding needs the restricted browser container the Harness desktop shell exposes as window.dshDesktop.browser. Open this panel inside the desktop app; a plain browser tab can only use an external window.',
      failedTitle: 'The page failed to load',
      failedHint: 'The network may be unavailable, or the embed container refused the page. Retry, or use the system browser.',
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

    /** Small action used in the panel toolbar. */
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

    /** Panel header: identity, load state, sign-in state and the actions. */
    function Toolbar(props) {
      const t = props.t
      const pill = (text, title) =>
        h(
          'span',
          {
            title,
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
          text
        )
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 16px 10px',
            flex: '0 0 auto',
          },
        },
        h(
          'div',
          {
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
        props.remembered ? pill(t('remembered'), t('rememberedHint')) : null,
        props.restoreNote === ''
          ? null
          : h(
              'span',
              {
                title: t(
                  props.restoreNote === 'saved'
                    ? 'restoreSaved'
                    : props.restoreNote === 'live'
                      ? 'restoreLive'
                      : 'restoreMiss'
                ),
                style: {
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                  opacity: 0.8,
                },
              },
              t(
                props.restoreNote === 'saved' ? 'restoreSaved' : props.restoreNote === 'live' ? 'restoreLive' : 'restoreMiss'
              )
            ),
        props.remembered ? h(ToolbarButton, { onClick: props.onForget, title: t('forgetHint') }, t('forget')) : null,
        props.showGuest ? h(ToolbarButton, { onClick: props.onReload, title: t('reload') }, t('reload')) : null,
        h(ToolbarButton, { onClick: props.onExternal, title: t('external') }, t('external'))
      )
    }

    /** Shown instead of the guest when embedding is unavailable or the load failed. */
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

    /**
     * Central panel. Inside the desktop shell it hosts a leased `<webview>`
     * guest, which is the only container the shell allows to show a third-party
     * page: chat.deepseek.com sends `frame-ancestors 'none'`, so an iframe can
     * never work, while a webview guest is a separate WebContents, not a frame.
     */
    function SitePage(props) {
      const t = props.t
      const hostRef = React.useRef(null)
      const guestRef = React.useRef(null)
      /** Snapshot this panel last wrote, so an unchanged capture is not rewritten. */
      const lastWrittenRef = React.useRef(null)
      const [status, setStatus] = React.useState('loading')
      const [detail, setDetail] = React.useState('')
      const [generation, setGeneration] = React.useState(0)
      const [remembered, setRemembered] = React.useState(false)
      /** Which replay path the last site load took: '' | 'saved' | 'live' | 'miss'. */
      const [restoreNote, setRestoreNote] = React.useState('')

      React.useEffect(() => {
        const saved = readSignIn()
        lastWrittenRef.current = saved === null ? null : JSON.stringify(saved)
        setRemembered(saved !== null)
      }, [])

      React.useEffect(() => {
        const host = hostRef.current
        const bridge = typeof window === 'undefined' ? null : window.dshDesktop && window.dshDesktop.browser
        if (host === null || bridge === null || bridge === undefined || typeof bridge.acquire !== 'function') {
          setStatus('unsupported')
          return undefined
        }

        let disposed = false
        let lease = null
        let element = null
        let stopOpenRequests = null
        let loaded = false
        let captureTimer = null
        let lastNote = ''
        let lastDiagKey = ''
        const note = (value) => {
          lastNote = value
          setRestoreNote(value)
        }
        /** Replay budget for the snapshot replay, so a rejected token cannot loop. */
        let restoreAttempts = 0
        /** A successful replay already reloaded once; later site loads must not replay again. */
        let replayed = false
        /** Assigned once the guest element exists; see the listeners further down. */
        let capture = null
        /** Unbinds every guest listener at once. */
        const listeners = new AbortController()
        const signal = listeners.signal

        setStatus('loading')
        setDetail('')

        const release = () => {
          if (lease !== null && typeof bridge.release === 'function') {
            bridge.release(lease).catch((error) => warn('lease release failed', error))
          }
          lease = null
        }

        /** Last main-frame URL reported by a navigation event; reset for about: URLs. */
        let lastUrl = ''

        /** The guest's current document URL, or '' when the element is gone. */
        const currentUrl = () => {
          let fromElement = ''
          if (element !== null) {
            try {
              fromElement = typeof element.getURL === 'function' ? element.getURL() : ''
            } catch (error) {
              warn('getURL failed', error)
            }
          }
          return pickUrl(lastUrl, fromElement)
        }

        /**
         * `dom-ready` fires for the placeholder `about:blank#<lease>` document first;
         * that document only starts the navigation, because the site is the only
         * document that can receive the sign-in replay.
         */
        const load = () => {
          if (element === null || disposed || loaded) return
          loaded = true
          try {
            element.loadURL(SITE_URL).catch((error) => {
              if (disposed) return
              setStatus('failed')
              setDetail(String((error && error.message) || error))
            })
          } catch (error) {
            setStatus('failed')
            setDetail(String((error && error.message) || error))
          }
        }

        /** Keep the main-frame URL current, so the placeholder can be told apart. */
        const trackUrl = (event) => {
          if (event && event.isMainFrame === false) return
          const url = event && event.url
          lastUrl = typeof url === 'string' && url !== '' && url.indexOf('about:') !== 0 ? url : ''
        }

        bridge
          .acquire(WORKSPACE_KEY)
          .then((reservation) => {
            if (disposed) {
              if (typeof bridge.release === 'function') {
                bridge.release(reservation.lease).catch((error) => warn('lease release failed', error))
              }
              return
            }
            lease = reservation.lease
            const guest = document.createElement('webview')
            guest.setAttribute('name', lease)
            guest.setAttribute('partition', reservation.partition)
            guest.setAttribute('allowpopups', '')
            guest.setAttribute('src', 'about:blank#' + lease)
            guest.setAttribute('data-sidebar-browser-frame', 'webview')
            guest.style.cssText =
              'display:flex;flex:1 1 auto;width:100%;height:100%;min-height:0;border:0;background:transparent;'
            guest.addEventListener('dom-ready', load, { signal })
            guest.addEventListener(
              'did-fail-load',
              (event) => {
                // Only a definite main-frame failure counts; -3 is an aborted load.
                if (disposed || !event || event.isMainFrame !== true || event.errorCode === -3) return
                setStatus('failed')
                setDetail(String(event.errorDescription || ''))
              },
              { signal }
            )
            guest.addEventListener('did-start-navigation', trackUrl, { signal })
            guest.addEventListener('did-navigate', trackUrl, { signal })
            host.appendChild(guest)
            element = guest
            guestRef.current = guest

            /** Copy the guest's current sign-in state into the application document. */
            capture = () => {
              if (disposed || element === null) return
              if (typeof element.executeJavaScript !== 'function') return
              try {
                const running = element.executeJavaScript(CAPTURE_SCRIPT)
                if (running === null || running === undefined || typeof running.then !== 'function') return
                running
                  .then((json) => {
                    if (disposed) return
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
                    if (!shouldCapture(document.visibilityState, serialized, lastWrittenRef.current)) return
                    if (writeSignIn(snapshot)) {
                      lastWrittenRef.current = serialized
                      setRemembered(true)
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
             * into the real site document — the `about:blank#<lease>` placeholder has an
             * opaque origin — so this runs on the site's own load. The attempt budget
             * keeps a server-rejected token from reloading forever, and `replayed`
             * keeps the reload itself from replaying a second time.
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
              if (typeof element.executeJavaScript !== 'function') {
                note('miss')
                capture()
                return
              }
              restoreAttempts += 1
              element
                .executeJavaScript(TOKEN_EXPR)
                .then((current) => {
                  if (disposed || element === null) return undefined
                  if (typeof current === 'string' && current !== '') {
                    note('live')
                    capture()
                    return undefined
                  }
                  return element.executeJavaScript(restoreScript(saved)).then((wrote) => {
                    if (disposed || element === null) return
                    if (wrote !== true) {
                      note('miss')
                      capture()
                      return
                    }
                    replayed = true
                    note('saved')
                    setStatus('loading')
                    try {
                      element.reload()
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
            guest.addEventListener(
              'did-finish-load',
              () => {
                if (disposed || !isSiteUrl(currentUrl())) return
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
                const key = lastNote + '|' + restoreAttempts + '|' + tokenLen
                if (key !== lastDiagKey) {
                  lastDiagKey = key
                  writeDiag({
                    at: new Date().toISOString(),
                    note: lastNote,
                    attempts: restoreAttempts,
                    tokenLen,
                  })
                }
              },
              { signal }
            )
            guest.addEventListener('did-navigate-in-page', () => capture(), { signal })
            captureTimer = window.setInterval(capture, CAPTURE_INTERVAL_MS)
            if (typeof bridge.onOpenRequested === 'function') {
              stopOpenRequests = bridge.onOpenRequested(lease, (url) => {
                if (disposed || element === null) return
                // The shell only forwards http(s), but the decision stays local:
                // anything outside the site leaves the app instead of loading here.
                if (!isSiteUrl(url)) {
                  try {
                    window.open(url, '_blank')
                  } catch (error) {
                    warn('external open failed', error)
                  }
                  return
                }
                try {
                  element.loadURL(url).catch((error) => warn('guest navigation failed', error))
                } catch (error) {
                  warn('guest navigation failed', error)
                }
              })
            }
          })
          .catch((error) => {
            if (disposed) return
            setStatus('failed')
            setDetail(String((error && error.message) || error))
          })

        return () => {
          disposed = true
          if (captureTimer !== null) {
            window.clearInterval(captureTimer)
            captureTimer = null
          }
          listeners.abort()
          if (typeof stopOpenRequests === 'function') stopOpenRequests()
          stopOpenRequests = null
          if (element !== null) {
            element.remove()
            element = null
          }
          guestRef.current = null
          release()
        }
      }, [generation])

      const reload = React.useCallback(() => {
        const guest = guestRef.current
        if (guest !== null && typeof guest.reload === 'function') {
          setStatus('loading')
          try {
            guest.reload()
            return
          } catch (error) {
            warn('reload failed', error)
          }
        }
        setGeneration((value) => value + 1)
      }, [])

      const openExternal = React.useCallback(() => {
        window.open(SITE_URL, '_blank')
      }, [])

      /**
       * Drop the local snapshot AND the guest's copy, so "forget" cannot be
       * undone by the next capture from a still-signed-in guest.
       */
      const forget = React.useCallback(() => {
        forgetSignIn()
        lastWrittenRef.current = null
        setRemembered(false)
        setRestoreNote('')
        const guest = guestRef.current
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
      }, [])

      const showGuest = status !== 'unsupported' && status !== 'failed'

      return h(
        'div',
        {
          style: {
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            padding: 'calc(18px + var(--dsh-frame-top-clearance, 0px)) 0 0',
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        h(Toolbar, {
          t,
          loading: status === 'loading',
          remembered,
          restoreNote,
          showGuest,
          onReload: reload,
          onForget: forget,
          onExternal: openExternal,
        }),
        h(
          'div',
          {
            style: {
              boxSizing: 'border-box',
              display: showGuest ? 'flex' : 'none',
              flex: '1 1 auto',
              minHeight: 0,
              margin: '0 12px 12px',
              borderRadius: 12,
              overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
          h('div', {
            ref: hostRef,
            style: { display: 'flex', flex: '1 1 auto', minHeight: 0, minWidth: 0 },
          })
        ),
        showGuest
          ? null
          : h(FallbackCard, {
              t,
              status,
              detail,
              onRetry: reload,
              onExternal: openExternal,
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
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, () => h(SitePage, { t }))
        )

        ctx.effect(() => () => {
          if (typeof markDisposer === 'function') markDisposer()
          if (typeof pageDisposer === 'function') pageDisposer()
        }, 'deepseek-site: slot registrations')

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
