import test from 'node:test'
import assert from 'node:assert/strict'

import {
  signSession,
  verifySession,
  timingSafeEqual,
  derivePasswordHash,
  verifyPassword,
  parseCookies,
  sessionCookieValue,
  clearSessionCookie,
  authConfig,
  authConfigured,
  sessionFrom,
  issueSessionCookie,
  csrfCheck,
  checkRateLimit,
  noteFailedLogin,
  clearLoginAttempts,
  resetRateLimitState,
  COOKIE_NAME,
} from '../cloudflare/auth.js'

const SECRET = 'unit-secret-abcdefghijklmnopqrstuvwxyz'

test('password: derive + verify (PBKDF2 format, wrong password rejected)', async () => {
  const hash = await derivePasswordHash('correct horse battery staple')
  assert.match(hash, /^pbkdf2\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
  assert.equal(await verifyPassword('correct horse battery staple', hash), true)
  assert.equal(await verifyPassword('wrong', hash), false)
  assert.equal(await verifyPassword('x', 'not-a-hash'), false)
  assert.equal(await verifyPassword('x', 'pbkdf2$10$bad'), false)
})

test('session: sign -> verify round trip', async () => {
  const now = Math.floor(Date.now() / 1000)
  const payload = { u: 'admin', iat: now, exp: now + 3600, v: 1, nonce: 'abc' }
  const token = await signSession(payload, SECRET)
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(await verifySession(token, SECRET, { username: 'admin', version: 1 }), payload)
})

test('session: tampered signature / expired / wrong user / wrong version => null', async () => {
  const now = Math.floor(Date.now() / 1000)
  const base = { u: 'admin', iat: now, exp: now + 3600, v: 1, nonce: 'n' }
  const token = await signSession(base, SECRET)
  const [body, sig] = token.split('.')

  assert.equal(await verifySession(`${body}.AAAA${sig.slice(4)}`, SECRET, {}), null)
  assert.equal(await verifySession(`${body}.${sig.slice(0, -2)}XX`, SECRET, {}), null)
  assert.equal(await verifySession('garbage', SECRET, {}), null)
  assert.equal(await verifySession(token, '', {}), null)
  assert.equal(
    await verifySession(await signSession({ ...base, exp: now - 10 }, SECRET), SECRET, {}),
    null,
  )
  assert.equal(await verifySession(token, SECRET, { username: 'someone-else' }), null)
  assert.equal(await verifySession(token, SECRET, { username: 'admin', version: 2 }), null)
})

test('timingSafeEqual: equal / different / different length', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true)
  assert.equal(timingSafeEqual('abc', 'abd'), false)
  assert.equal(timingSafeEqual('abc', 'abcd'), false)
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true)
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false)
})

test('cookies: parse, flags (Secure only on https), clear', () => {
  assert.deepEqual(parseCookies('a=1; axd_session=abc.def; b=2'), { a: '1', axd_session: 'abc.def', b: '2' })
  assert.deepEqual(parseCookies(null), {})

  const https = sessionCookieValue('tok', new URL('https://console.example/'))
  assert.match(https, new RegExp(`^${COOKIE_NAME}=tok;`))
  assert.match(https, /HttpOnly/)
  assert.match(https, /SameSite=Lax/)
  assert.match(https, /Secure/)
  assert.match(https, /Max-Age=28800/)

  const http = sessionCookieValue('tok', new URL('http://localhost:3000/'))
  assert.doesNotMatch(http, /Secure/)

  assert.match(clearSessionCookie(new URL('https://console.example/')), /Max-Age=0/)
})

test('authConfig / authConfigured / sessionFrom / issueSessionCookie', async () => {
  assert.equal(authConfigured(authConfig({})), false)
  assert.equal(
    authConfigured(authConfig({ SESSION_SECRET: 's', AUTH_USERNAME: 'u', AUTH_PASSWORD_HASH: 'h' })),
    true,
  )

  const hash = await derivePasswordHash('pw-12345678')
  const env = { SESSION_SECRET: SECRET, AUTH_USERNAME: 'admin', AUTH_PASSWORD_HASH: hash, SESSION_VERSION: 1 }
  const { cookie, expiresAt } = await issueSessionCookie('admin', env, new URL('https://console.example/'))
  const value = cookie.split(';')[0]
  const request = new Request('https://console.example/api/session', { headers: { cookie: value } })
  const session = await sessionFrom(request, env)
  assert.equal(session.u, 'admin')
  assert.ok(new Date(expiresAt).getTime() > Date.now())
  assert.equal(await sessionFrom(new Request('https://console.example/'), env), null)
})

test('csrfCheck: same-origin JSON allowed; cross-origin / wrong content-type rejected', () => {
  const url = new URL('https://console.example/api/login')
  const ok = new Request(url, {
    method: 'POST',
    headers: { origin: 'https://console.example', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(csrfCheck(ok, url).ok, true)

  const badOrigin = new Request(url, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(csrfCheck(badOrigin, url).ok, false)

  const noOrigin = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(csrfCheck(noOrigin, url).ok, false)

  const form = new Request(url, {
    method: 'POST',
    headers: { origin: 'https://console.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1',
  })
  assert.equal(csrfCheck(form, url).code, 'CSRF_REJECTED')
})

test('rate limit: 5 attempts then blocked with retryAfter, clear resets', () => {
  resetRateLimitState()
  const key = '1.2.3.4'
  const now = Date.now()
  for (let i = 0; i < 5; i++) {
    assert.equal(checkRateLimit(key, now).allowed, true)
    noteFailedLogin(key, now)
  }
  const blocked = checkRateLimit(key, now)
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfter > 0)
  clearLoginAttempts(key)
  assert.equal(checkRateLimit(key, now).allowed, true)
  resetRateLimitState()
})
