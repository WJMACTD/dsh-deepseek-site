/**
 * Offline check for the sign-in snapshot logic embedded in client.js.
 * Extracts the real declarations from the module source (no copies), then runs
 * them against a fake guest localStorage and a fake application localStorage:
 *   node test-signin.cjs
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
const start = source.indexOf('const SITE_URL')
const end = source.indexOf('const zh = {')
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate helper declarations in client.js')
const declarations = source.slice(start, end)
const api = new Function(
  declarations +
    '\nreturn { SITE_URL, SITE_ORIGIN, SNAPSHOT_KEYS, MAX_VALUE_LENGTH, DIAG_LIMIT, EXTERNAL_DEDUPE_MS, isSiteUrl, pickUrl,' +
    ' shouldCapture, minimizeSnapshot, CAPTURE_SCRIPT, CLEAR_SCRIPT, TOKEN_EXPR, restoreScript, tokenValue,' +
    ' writeDiag, readSignIn, writeSignIn, forgetSignIn, stripElectronToken, planExternalOpen }',
)()

/** Minimal localStorage stand-in shared by the guest and the application document. */
function makeStore() {
  const store = new Map()
  return {
    store,
    get length() {
      return store.size
    },
    key(index) {
      return Array.from(store.keys())[index]
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(key, String(value))
    },
    removeItem(key) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
  }
}

const guest = makeStore()
const app = makeStore()
const guestKeys = [
  'userToken',
  '__appKit_userInfo',
  '__appKit_fg_theme',
  '__appKit_@deepseek/chat_bannerSettings',
  '__ds_remote_feature_did',
  'unrelated-key',
]
global.localStorage = guest
global.window = { localStorage: app }

/** Run a guest-side script string against the fake guest storage. */
const run = (script) => new Function('localStorage', 'return ' + script)(guest)

const token = JSON.stringify({ value: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', __version: '0' })
const profile = JSON.stringify({ id: 'user-1' })
guest.setItem('userToken', token)
guest.setItem('__appKit_userInfo', profile)
guest.setItem('__appKit_fg_theme', 'dark')
guest.setItem('__appKit_@deepseek/chat_bannerSettings', '{"shown":true}')
guest.setItem('__ds_remote_feature_did', 'device-1')
guest.setItem('unrelated-key', 'should-not-be-captured')

// ---- capture keeps the credential pair only -------------------------------
const captured = JSON.parse(run(api.CAPTURE_SCRIPT))
assert.deepStrictEqual(Object.keys(captured).sort(), ['__appKit_userInfo', 'userToken'])
assert.strictEqual(captured.userToken, token)
assert.strictEqual(captured.__appKit_userInfo, profile)
for (const key of ['__appKit_fg_theme', '__ds_remote_feature_did', 'unrelated-key']) {
  assert.strictEqual(key in captured, false, 'capture leaked ' + key)
}

// ---- tokenValue: the logged-out marker is not a sign-in -------------------
assert.strictEqual(api.tokenValue(JSON.stringify({ value: null, __version: '0' })), '')
assert.strictEqual(api.tokenValue(token), 'eyJhbGciOiJIUzI1NiJ9.payload.sig')
assert.strictEqual(api.tokenValue(''), '')
assert.strictEqual(api.tokenValue('null'), '')
assert.strictEqual(api.tokenValue('bare-token'), 'bare-token')
assert.strictEqual(api.tokenValue(null), '')

// ---- minimizeSnapshot: allow-list, size cap, token required ---------------
assert.deepStrictEqual(api.minimizeSnapshot(captured), captured)
assert.strictEqual(api.minimizeSnapshot({ userToken: 'x', __appKit_fg_theme: 'dark' }).__appKit_fg_theme, undefined)
assert.strictEqual(api.minimizeSnapshot({ userToken: JSON.stringify({ value: null }) }), null)
assert.strictEqual(api.minimizeSnapshot({}), null)
assert.strictEqual(api.minimizeSnapshot(null), null)
const huge = 'a'.repeat(api.MAX_VALUE_LENGTH + 1)
assert.strictEqual(api.minimizeSnapshot({ userToken: JSON.stringify({ value: huge }) }), null)

// ---- restore: empty guest, live guest, logged-out marker, cleared token ---
guest.clear()
assert.strictEqual(run(api.restoreScript(captured)), true, 'restore wrote nothing into an empty guest')
assert.strictEqual(guest.getItem('userToken'), token, 'restore did not replay the token verbatim')
assert.strictEqual(guest.getItem('__appKit_userInfo'), profile, 'restore lost the profile cache')

const live = JSON.stringify({ value: 'newer', __version: '0' })
guest.setItem('userToken', live)
assert.strictEqual(run(api.restoreScript(captured)), false, 'restore overwrote a live sign-in')
assert.strictEqual(guest.getItem('userToken'), live)

guest.setItem('userToken', JSON.stringify({ value: null, __version: '0' }))
assert.strictEqual(run(api.restoreScript(captured)), true, 'restore did not replace the logged-out marker')
assert.strictEqual(guest.getItem('userToken'), token)

guest.removeItem('userToken')
assert.strictEqual(run(api.restoreScript(captured)), true, 'restore did not refill a cleared token')

// ---- CLEAR_SCRIPT wipes exactly the snapshot keys -------------------------
guest.setItem('__appKit_fg_theme', 'dark')
assert.strictEqual(run(api.CLEAR_SCRIPT), true)
assert.strictEqual(guest.getItem('userToken'), null)
assert.strictEqual(guest.getItem('__appKit_userInfo'), null)
assert.strictEqual(guest.getItem('__appKit_fg_theme'), 'dark', 'forget must not touch unrelated keys')

// ---- TOKEN_EXPR mirrors tokenValue inside the guest -----------------------
guest.setItem('userToken', JSON.stringify({ value: 'live-token' }))
assert.strictEqual(run(api.TOKEN_EXPR), 'live-token')
guest.setItem('userToken', JSON.stringify({ value: null }))
assert.strictEqual(run(api.TOKEN_EXPR), '')
guest.removeItem('userToken')
assert.strictEqual(run(api.TOKEN_EXPR), '')

// ---- application-side snapshot round trip ---------------------------------
assert.strictEqual(api.readSignIn(), null, 'an empty application must not claim a sign-in')
assert.strictEqual(api.writeSignIn(captured), true)
assert.deepStrictEqual(api.readSignIn(), captured)
app.setItem('deepseek-site:sign-in:v1', JSON.stringify({ userToken: JSON.stringify({ value: null }) }))
assert.strictEqual(api.readSignIn(), null, 'a logged-out marker must not be restored')
app.setItem('deepseek-site:sign-in:v1', 'not json')
assert.strictEqual(api.readSignIn(), null)
api.writeSignIn(captured)
api.forgetSignIn()
assert.strictEqual(api.readSignIn(), null, 'forget must drop the snapshot')
assert.strictEqual(app.getItem('deepseek-site:diag:v1'), null, 'forget must drop the trail')

// ---- diagnostic trail is a bounded ring of local-only fields --------------
for (let i = 0; i < api.DIAG_LIMIT + 5; i += 1) {
  api.writeDiag({ at: new Date(2026, 0, 1, 0, 0, i).toISOString(), note: 'miss', attempts: i, tokenLen: 0 })
}
const trail = JSON.parse(app.getItem('deepseek-site:diag:v1'))
assert.strictEqual(trail.length, api.DIAG_LIMIT, 'trail must be capped')
assert.strictEqual(trail[trail.length - 1].attempts, api.DIAG_LIMIT + 4, 'trail must keep the newest entry')
for (const entry of trail) {
  for (const key of Object.keys(entry)) {
    assert.ok(['at', 'note', 'attempts', 'tokenLen'].includes(key), 'trail leaked field ' + key)
  }
}

// ---- URL judging: the about:blank placeholder is never "the site" ---------
assert.strictEqual(api.pickUrl('', 'https://chat.deepseek.com/'), 'https://chat.deepseek.com/')
assert.strictEqual(api.pickUrl('https://chat.deepseek.com/a/chat', 'about:blank#lease'), 'https://chat.deepseek.com/a/chat')
assert.strictEqual(api.pickUrl('about:blank#lease', ''), '')
assert.strictEqual(api.pickUrl('', 'about:blank#lease'), '')
assert.strictEqual(api.isSiteUrl('https://chat.deepseek.com/sign_in'), true)
assert.strictEqual(api.isSiteUrl('about:blank#lease'), false)
assert.strictEqual(api.isSiteUrl(''), false)

// ---- capture gating: visible and changed only -----------------------------
assert.strictEqual(api.shouldCapture('visible', '{"a":1}', null), true)
assert.strictEqual(api.shouldCapture('visible', '{"a":1}', '{"a":1}'), false)
assert.strictEqual(api.shouldCapture('hidden', '{"a":1}', null), false)
assert.strictEqual(api.shouldCapture('visible', '', null), false)
assert.strictEqual(api.shouldCapture('visible', '{}', null), false)

// ---- user agent: only the Electron product token is dropped ---------------
const ua =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'app/0.2.1-rc.3 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36'
const agent = api.stripElectronToken(ua)
assert.strictEqual(agent.indexOf('Electron/'), -1, 'the Electron token must be stripped')
assert.ok(agent.indexOf('Chrome/140.0.0.0') >= 0, 'the Chromium version must stay honest')
assert.ok(agent.indexOf('Safari/537.36') >= 0)
assert.ok(agent.indexOf('Windows NT 10.0') >= 0)
assert.strictEqual(api.stripElectronToken(''), '')
assert.strictEqual(api.stripElectronToken(null), '')

// ---- off-site links: site stays inside, repeats are deduped ---------------
const now = 1000000
assert.strictEqual(
  api.planExternalOpen('https://platform.deepseek.com/usage', null, now),
  'https://platform.deepseek.com/usage',
  'an off-site https link must leave the app'
)
assert.strictEqual(api.planExternalOpen('https://chat.deepseek.com/a/chat', null, now), null, 'the site must stay inside')
assert.strictEqual(api.planExternalOpen('http://example.com/', null, now), null, 'plain http must not be forwarded')
assert.strictEqual(api.planExternalOpen('mailto:someone@example.com', null, now), null)
assert.strictEqual(api.planExternalOpen('', null, now), null)
const previous = { url: 'https://example.com/x', at: now }
assert.strictEqual(
  api.planExternalOpen('https://example.com/x', previous, now + api.EXTERNAL_DEDUPE_MS - 1),
  null,
  'one click must not open twice'
)
assert.strictEqual(
  api.planExternalOpen('https://example.com/x', previous, now + api.EXTERNAL_DEDUPE_MS),
  'https://example.com/x',
  'the dedupe window must expire'
)

console.log(
  'sign-in snapshot logic OK: capture, minimize, restore, clear, gating, trail, url judging, user agent, external links'
)
