/**
 * Small helpers shared by the auth Worker's modules.
 *
 * These live apart from index.js so the device-flow module can import them
 * without pulling in (and being pulled into) the Access verification logic.
 */

export const encoder = new TextEncoder()

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export function base64url(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function now() {
  return Math.floor(Date.now() / 1000)
}

/**
 * Indirection for the Access identity check.
 *
 * device.js needs to know who the browser is but must not import the whole
 * Access-verification stack (cycle), so index.js publishes its resolver here at
 * import time and tests can substitute a stub without faking RSA signatures.
 */
export const hooks = { accessIdentity: null }

/**
 * The email allowlist, KV first with the env var as a fresh-deployment
 * fallback. Lives here (not in index.js) so the device flow can enforce it
 * without pulling in the whole Access stack.
 */
export async function allowlist(env) {
  let raw = ''
  try {
    raw = (await env.CONFIG.get('auth/allowed_emails')) || ''
  } catch {
    // A KV read failure must not open the door; fall through to the var.
  }
  if (!raw.trim()) raw = env.AUTH_ALLOWED_EMAILS || ''
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@'))
}


/**
 * The engine/Worker shared secret lives in AIXODIA_CONFIG, never in a checked-in
 * vars block. Let KV read failures propagate so they cannot masquerade as a bad
 * client credential or silently disable token synchronization.
 */
export async function syncSecret(env) {
  const value = await env.CONFIG.get('auth/sync_secret')
  return String(value || '').trim()
}

/** Case-insensitive membership test; an empty needle never matches. */
export function permits(list, email) {
  const needle = String(email || '').trim().toLowerCase()
  return needle.length > 0 && list.includes(needle)
}
