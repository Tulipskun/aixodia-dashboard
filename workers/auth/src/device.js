/**
 * Device Authorization Flow (the `auth_system.md` draft, implemented).
 *
 * The app never types an email and never holds an Access cookie. It asks for a
 * device code, shows a short user code, and the person approves it from a browser
 * that already has a Cloudflare Access session. The Worker — not the engine —
 * mints the token, because it is the sign-in authority.
 *
 * Storage (D1, same database as gate_sessions):
 *
 *   device_codes  one row per sign-in attempt. `device_code` is the secret the
 *                 app polls with and is stored hashed; `user_code` is what the
 *                 human sees and is stored plaintext because the approve page
 *                 looks codes up by it.
 *   auth_tokens   one row per live token, hashed. No expiry column on purpose:
 *                 a token dies only when revoked (the draft's rule).
 *   rate_limits   fixed-window counters for the public poll endpoint.
 *
 * The plaintext token exists in exactly two places: the mint response and the
 * app's memory. D1 holds only the hash, and the engine is pushed hashes too, so
 * no database or engine dump yields a working credential.
 *
 * Minting happens on the first poll rather than at approve time for that
 * reason: the approve page runs in a browser that must never see the token, and
 * storing the plaintext for the app to collect later would defeat the hashing.
 * The draft's "ได้ access_token ครั้งเดียว" is literal — a lost response means
 * starting the sign-in over.
 */

import { json, base64url, sha256Hex, now, hooks, allowlist, permits } from './shared.js'

const DEVICE_CODE_TTL = 600          // seconds, the draft's 10 minutes
const POLL_INTERVAL = 5              // seconds the app should wait between polls
const USER_CODE_TRIES = 5            // retries when the random code collides
const POLL_IP_LIMIT = 60             // per IP per window
const POLL_CODE_LIMIT = 300          // per device code per window
const RATE_WINDOW = 60               // seconds
const HASH_PREFIX_LEN = 8            // shown in the session list so rows are tellable

const USER_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O — they read as 1/0
const USER_DIGITS = '0123456789'

function randomInts(count) {
  const bytes = new Uint8Array(count)
  crypto.getRandomValues(bytes)
  return bytes
}

function randomFrom(alphabet, count) {
  let out = ''
  for (const byte of randomInts(count)) out += alphabet[byte % alphabet.length]
  return out
}

/** `WXYZ-2041` — the draft's shape. ~28M combinations, safe behind the rate limit. */
function randomUserCode() {
  return `${randomFrom(USER_LETTERS, 4)}-${randomFrom(USER_DIGITS, 4)}`
}

function randomSecret() {
  return base64url(randomInts(32))
}

/** A CSRF value the approve page can carry but an attacker cannot mint. */
async function csrfFor(deviceCodeHash, env) {
  const data = new TextEncoder().encode(`approve:${deviceCodeHash}`)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.AUTH_SYNC_SECRET || ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, data)
  return base64url(new Uint8Array(mac))
}

/**
 * Fixed-window counter. A D1 write per public poll is the price of limiting
 * them; the window keeps rows bounded and stale rows are deleted lazily.
 */
async function rateLimit(env, key, limit) {
  if (Math.random() < 0.01) {
    await env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?1`)
      .bind(Math.floor(now() / RATE_WINDOW) - 2).run()
  }
  const window = Math.floor(now() / RATE_WINDOW)
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2`,
  ).bind(key, window).run()
  const row = await env.DB.prepare(
    `SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2`,
  ).bind(key, window).first()
  if ((row?.count || 0) > limit) {
    return json({ error: 'slow_down', code: 'RATE_LIMITED' }, 429)
  }
  return null
}

// ---------------------------------------------------------------- endpoints

/** `POST /auth/device/code` — the app starts a sign-in. Public. */
export async function deviceCode(env, req) {
  const deviceCode = randomSecret()
  const deviceCodeHash = await sha256Hex(deviceCode)
  // The app sends the phone model; the user agent is only a fallback, because
  // "curl/8.14.1" on an approval page tells the approver nothing about which
  // device is asking.
  const named = await req
    .clone()
    .json()
    .then((payload) => String(payload?.device_name || '').trim())
    .catch(() => '')

  // The user code must be unique among live codes: a collision would let one
  // person approve someone else's pending sign-in.
  for (let attempt = 0; attempt < USER_CODE_TRIES; attempt++) {
    const userCode = randomUserCode()
    try {
      await env.DB.prepare(
        `INSERT INTO device_codes
           (device_code_hash, user_code, device_name, state, created_at, expires_at, approved_by, token_hash)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?5, NULL, NULL)`,
      ).bind(deviceCodeHash, userCode, named.slice(0, 80) || deviceName(req), now(), now() + DEVICE_CODE_TTL).run()
      return json({
        device_code: deviceCode,
        user_code: userCode,
        verification_url: verificationUrl(env),
        interval: POLL_INTERVAL,
        expires_in: DEVICE_CODE_TTL,
      })
    } catch (err) {
      if (!String(err?.message || '').includes('UNIQUE')) throw err
    }
  }
  return json({ error: 'server_error', code: 'USER_CODE_EXHAUSTED' }, 500)
}

function deviceName(req) {
  const raw = req.headers.get('user-agent') || ''
  return raw.slice(0, 80) || 'unknown device'
}

/** The page the user approves from, reached through the Access-protected proxy. */
function verificationUrl(env) {
  return env.PUBLIC_URL ? `${env.PUBLIC_URL}/engine/auth/device` : '/engine/auth/device'
}

/**
 * `GET /auth/device?code=...` — the approve page.
 *
 * Access protects this at the edge when reached through the console origin, but
 * the Worker also sits on a bare workers.dev hostname where nothing protects it,
 * so the handler re-checks the assertion itself.
 */
export async function devicePage(env, req, url) {
  const who = await accessWho(env, req)
  if (!who.email) {
    return json({ error: 'unauthorized', code: who.error?.toUpperCase() || 'NO_ACCESS_SESSION' }, 401)
  }

  const code = url.searchParams.get('code') || ''
  if (!code) return page('ใส่รหัสไม่ครบ', '<p>ลิงก์นี้ต้องมีรหัสอุปกรณ์</p>', 400)
  const hash = await sha256Hex(code)
  const row = await env.DB.prepare(
    `SELECT user_code, device_name, state, expires_at FROM device_codes WHERE device_code_hash = ?1`,
  ).bind(hash).first()

  if (!row || row.state !== 'pending' || row.expires_at <= now()) {
    return page('รหัสหมดอายุ', '<p>รหัสนี้ถูกใช้แล้วหรือหมดเวลา ขอรหัสใหม่จากแอป</p>', 410)
  }

  const csrf = await csrfFor(hash, env)
  const body = `
    <p>อุปกรณ์: <strong>${escapeHtml(row.device_name)}</strong></p>
    <p>รหัส: <strong>${escapeHtml(row.user_code)}</strong></p>
    <p>ผู้อนุมัติ: ${escapeHtml(who.email)}</p>
    <form method="post" action="/engine/auth/device/approve">
      <input type="hidden" name="code" value="${escapeHtml(code)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit">Approve</button>
    </form>`
  return page('อนุมัติการเข้าใช้', body, 200)
}

/** `POST /auth/device/approve` — the person says yes. */
export async function deviceApprove(env, req) {
  const who = await accessWho(env, req)
  if (!who.email) {
    return json({ error: 'unauthorized', code: who.error?.toUpperCase() || 'NO_ACCESS_SESSION' }, 401)
  }
  const allowed = await allowlist(env)
  if (allowed.length > 0 && !permits(allowed, who.email)) {
    return json({ error: 'forbidden', code: 'EMAIL_NOT_ALLOWED' }, 403)
  }

  const form = await req.formData().catch(() => null)
  const code = String(form?.get('code') || '')
  const csrf = String(form?.get('csrf') || '')
  if (!code || !csrf) return json({ error: 'bad_request', code: 'MISSING_FIELDS' }, 400)

  const hash = await sha256Hex(code)
  if (csrf !== await csrfFor(hash, env)) {
    return json({ error: 'forbidden', code: 'CSRF_MISMATCH' }, 403)
  }

  const row = await env.DB.prepare(
    `SELECT state, expires_at, device_name FROM device_codes WHERE device_code_hash = ?1`,
  ).bind(hash).first()
  if (!row || row.state !== 'pending' || row.expires_at <= now()) {
    return json({ error: 'gone', code: 'CODE_NOT_PENDING' }, 410)
  }

  await env.DB.prepare(
    `UPDATE device_codes SET state = 'approved', approved_by = ?2
     WHERE device_code_hash = ?1 AND state = 'pending'`,
  ).bind(hash, who.email).run()

  return page(
    'อนุมัติแล้ว',
    `<p>อุปกรณ์ <strong>${escapeHtml(row.device_name)}</strong> ได้รับอนุมัติแล้ว กลับไปที่แอปได้เลย</p>`,
    200,
  )
}

/** `POST /auth/device/token` — the app polls. Public, rate limited. */
export async function deviceToken(env, req) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown'
  const limited = await rateLimit(env, `poll:${ip}`, POLL_IP_LIMIT)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  const code = String(body?.device_code || '')
  if (!code) return json({ error: 'bad_request', code: 'MISSING_DEVICE_CODE' }, 400)

  const hash = await sha256Hex(code)
  const codeLimit = await rateLimit(env, `code:${hash}`, POLL_CODE_LIMIT)
  if (codeLimit) return codeLimit

  const row = await env.DB.prepare(
    `SELECT state, expires_at, token_hash FROM device_codes WHERE device_code_hash = ?1`,
  ).bind(hash).first()

  if (!row) return json({ status: 'not_found' }, 404)
  if (row.state === 'denied') return json({ status: 'denied' }, 403)
  if (row.state === 'pending' && row.expires_at <= now()) return json({ status: 'expired' }, 410)
  if (row.state === 'pending') return json({ status: 'pending', interval: POLL_INTERVAL })
  if (row.state !== 'approved') return json({ status: 'expired' }, 410)

  // Already minted on an earlier poll: the draft's single delivery. A lost
  // response means the sign-in starts over; re-sending would require storing
  // the plaintext, which is exactly what the hashing rule forbids.
  if (row.token_hash) {
    const tokenRow = await env.DB.prepare(
      `SELECT state FROM auth_tokens WHERE token_hash = ?1`,
    ).bind(row.token_hash).first()
    return json({ status: tokenRow?.state === 'active' ? 'delivered' : 'revoked' }, tokenRow?.state === 'active' ? 200 : 401)
  }

  // First poll after approve: mint, register, push, deliver — once.
  const token = randomSecret()
  const tokenHash = await sha256Hex(token)
  await env.DB.prepare(
    `INSERT INTO auth_tokens (token_hash, email, device_name, state, created_at, sync_state, revoked_at)
     VALUES (?1, (SELECT approved_by FROM device_codes WHERE device_code_hash = ?2), ?3, 'active', ?4, 'pending', NULL)`,
  ).bind(tokenHash, hash, row.device_name || deviceName(req), now()).run()

  // The conditional update is the single-delivery lock: a concurrent poll loses
  // this race and falls into the `delivered` branch above.
  const claimed = await env.DB.prepare(
    `UPDATE device_codes SET token_hash = ?2 WHERE device_code_hash = ?1 AND token_hash IS NULL`,
  ).bind(hash, tokenHash).run()
  if (!claimed.meta?.changes) {
    return json({ status: 'delivered' })
  }

  // Best-effort push. If the engine is down the row stays `pending` and the
  // engine's periodic re-sync picks it up — the person is not blocked.
  await pushSync(env, { activate: [tokenHash] })
  return json({ status: 'ok', access_token: token, token_type: 'Bearer' })
}

/**
 * `GET /auth/sessions` — the live tokens, for the revoke page. Access only.
 */
export async function sessionsList(env, req) {
  const who = await accessWho(env, req)
  if (!who.email) {
    return json({ error: 'unauthorized', code: who.error?.toUpperCase() || 'NO_ACCESS_SESSION' }, 401)
  }
  const rows = await env.DB.prepare(
    `SELECT token_hash, email, device_name, state, created_at, sync_state
     FROM auth_tokens WHERE state != 'revoked' ORDER BY created_at DESC LIMIT 100`,
  ).all()
  return json({
    sessions: (rows.results || []).map((r) => ({
      token_hash_prefix: r.token_hash.slice(0, HASH_PREFIX_LEN),
      email: r.email,
      device: r.device_name,
      state: r.state,
      sync_state: r.sync_state,
      created_at: r.created_at,
    })),
  })
}

/**
 * `POST /auth/revoke` — the web passes `{token_hash}`; the app may revoke its
 * own token by calling with its bearer and no body.
 */
export async function revoke(env, req) {
  let tokenHash = ''
  const presented = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (presented) {
    const own = await env.DB.prepare(
      `SELECT state FROM auth_tokens WHERE token_hash = ?1`,
    ).bind(await sha256Hex(presented)).first()
    if (own?.state === 'active') tokenHash = await sha256Hex(presented)
  }
  if (!tokenHash) {
    const who = await accessWho(env, req)
    if (!who.email) {
      return json({ error: 'unauthorized', code: who.error?.toUpperCase() || 'NO_ACCESS_SESSION' }, 401)
    }
    const body = await req.json().catch(() => null)
    tokenHash = String(body?.token_hash || '')
    if (tokenHash.length !== 64) return json({ error: 'bad_request', code: 'BAD_TOKEN_HASH' }, 400)
  }

  const result = await env.DB.prepare(
    `UPDATE auth_tokens SET state = 'revoked', revoked_at = ?2, sync_state = 'pending'
     WHERE token_hash = ?1 AND state != 'revoked'`,
  ).bind(tokenHash, now()).run()
  if (!result.meta?.changes) return json({ error: 'not_found', code: 'UNKNOWN_TOKEN' }, 404)

  await pushSync(env, { revoke: [tokenHash] })
  return json({ revoked: true })
}

/**
 * `GET /auth/sessions/active` — the engine's startup and periodic pull.
 * Shared-secret guarded; answers hashes only.
 */
export async function activeSessions(env, req) {
  if (!syncSecretOk(env, req)) return json({ error: 'forbidden', code: 'BAD_SYNC_SECRET' }, 403)
  const rows = await env.DB.prepare(
    `SELECT token_hash FROM auth_tokens WHERE state = 'active'`,
  ).all()
  return json({ hashes: (rows.results || []).map((r) => r.token_hash) })
}

// ---------------------------------------------------------------- engine push

async function pushSync(env, body) {
  const target = env.ENGINE_URL
  if (!target || !env.AUTH_SYNC_SECRET) return
  try {
    const res = await fetch(`${target.replace(/\/$/, '')}/auth/sessions/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-sync': env.AUTH_SYNC_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok && body.activate) {
      await env.DB.prepare(
        `UPDATE auth_tokens SET sync_state = 'synced' WHERE token_hash IN (${body.activate.map(() => '?').join(',')})`,
      ).bind(...body.activate).run()
    }
  } catch {
    // Staying `pending` is the contract: the engine's re-sync will collect it.
  }
}

function syncSecretOk(env, req) {
  const secret = env.AUTH_SYNC_SECRET || ''
  return secret.length > 0 && req.headers.get('x-auth-sync') === secret
}

// ---------------------------------------------------------------- helpers

async function accessWho(env, req) {
  // The hook is published by index.js at import time; the lazy import is the
  // fallback for a direct import of this module (tests, tooling).
  const resolve = hooks.accessIdentity || (await import('./index.js')).accessIdentity
  const found = await resolve(env, req)
  return { email: found.email ? found.email.toLowerCase() : '', error: found.error }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function page(title, body, status) {
  return new Response(
    `<!doctype html><html lang="th"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     <title>${escapeHtml(title)} — AIxodia</title>
     <style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}
     button{font-size:1.05rem;padding:.6rem 1.4rem}</style></head>
     <body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}
