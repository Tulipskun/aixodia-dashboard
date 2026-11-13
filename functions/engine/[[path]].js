/**
 * Proxy `/engine/*` to the service that owns the path, on the console's origin.
 *
 * Two upstreams, picked by path, because those two concerns have different
 * availability requirements:
 *
 * * `/v1/auth/*` belongs to the auth Worker. Sign-in has to work whether or not
 *   the engine is running — the engine is an agent that also exposes
 *   device-control routes, and it used to be the sign-in authority, so stopping it
 *   logged everyone out.
 * * everything else belongs to the engine, which is expected to be down sometimes.
 *
 * Proxying through this origin rather than calling each service's own hostname is
 * not cosmetic: Cloudflare Access sets its session cookie per host, so a browser
 * that signed in at another hostname has no credential here and every fetch came
 * back 302 to the login page.
 *
 * Only the prefixes below are forwarded, so this is not a general egress door.
 */

const AUTH = 'https://aixodia-auth.aixodia.workers.dev'
const ENGINE = 'https://engine.aixodia.dpdns.org'

/**
 * Paths the auth Worker answers.
 *
 * `/auth/*`, not `/v1/auth/*`: the engine already serves `/v1/auth/whoami` and the
 * GitHub exchange, and two services answering under one prefix made it ambiguous
 * which one owned a sign-in path. The Worker keeps its own namespace.
 */
const AUTH_PREFIXES = ['/auth/']
/** Paths the engine answers and that this proxy may reach. */
const ENGINE_PREFIXES = ['/v1/', '/healthz', '/cdn-cgi/']

function upstreamFor(path) {
  if (AUTH_PREFIXES.some((prefix) => path.startsWith(prefix))) return AUTH
  if (ENGINE_PREFIXES.some((prefix) => path.startsWith(prefix))) return ENGINE
  return null
}

export async function onRequest({ request }) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/engine/, '') || '/'

  const upstreamBase = upstreamFor(path)
  if (!upstreamBase) {
    return new Response('Not found', { status: 404 })
  }

  const target = new URL(path + url.search, upstreamBase)

  // Copy the headers that carry identity and content negotiation; drop the ones
  // that describe this hop rather than the request.
  const headers = new Headers()
  for (const name of [
    'accept',
    'accept-language',
    'authorization',
    'content-type',
    'cookie',
    'origin',
    'referer',
    'user-agent',
    // Cloudflare puts the Access assertion on requests it authorised; the auth
    // Worker needs it to know the confirm page was reached by a real login.
    'cf-access-jwt-assertion',
  ]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('host', new URL(upstreamBase).host)

  // A 302 to the Access login has to reach the browser so the user can actually
  // sign in, so redirects are passed through rather than followed.
  const init = { method: request.method, headers, redirect: 'manual' }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  let upstream
  try {
    upstream = await fetch(target.toString(), init)
  } catch (err) {
    // Name the outage rather than letting the SPA report a parse error. The console
    // shows this text, and "engine unreachable" tells the user which half is down.
    return new Response(
      JSON.stringify({
        error: 'upstream_unreachable',
        code: upstreamBase === ENGINE ? 'ENGINE_DOWN' : 'AUTH_DOWN',
        detail: String(err?.message || err),
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  const responseHeaders = new Headers()
  for (const name of [
    'content-type',
    'cache-control',
    'location',
    'set-cookie',
    'www-authenticate',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
  ]) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }

  // A Cloudflare outage answers HTML. Say so instead of letting the SPA try to
  // parse it as JSON and report a type error.
  const contentType = responseHeaders.get('content-type') || ''
  if (upstream.status >= 500 && !contentType.includes('json')) {
    return new Response(
      JSON.stringify({
        error: 'upstream_error',
        code: upstreamBase === ENGINE ? 'ENGINE_DOWN' : 'AUTH_DOWN',
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}
