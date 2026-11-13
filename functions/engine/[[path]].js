/**
 * Proxy `/engine/*` to the engine, on the console's own origin.
 *
 * The console and the engine are separate hostnames under Cloudflare Access, and
 * Access sets `CF_AppSession` as a host-only cookie on whichever host it
 * authenticated. A browser that signed in at `engine.aixodia.dpdns.org`
 * therefore has no credential at `aixodia.dpdns.org`, so the SPA's
 * `fetch(..., { credentials: 'include' })` arrived unauthenticated and every call
 * came back 302 to the login page. Pointing the SPA at a same-origin path keeps
 * the cookie and the request on one host.
 *
 * The Access login itself still happens at the engine's hostname, which is where
 * the redirect sends the user; once back, the SPA's own calls ride the session
 * cookie Cloudflare set for this host.
 *
 * Only the engine's paths are forwarded. The proxy is not a general egress door:
 * a path is passed through only if it starts with `/v1/`, `/healthz` or
 * `/cdn-cgi/`, so a request cannot be shaped into reaching somewhere else.
 */

const ENGINE = 'https://engine.aixodia.dpdns.org'

const ALLOWED_PREFIXES = ['/v1/', '/healthz', '/cdn-cgi/']

export async function onRequest({ request }) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/engine/, '') || '/'

  if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return new Response('Not found', { status: 404 })
  }

  const target = new URL(path + url.search, ENGINE)

  // Copy the headers that carry identity and content negotiation, and drop the
  // ones that describe the hop rather than the request (Host, Content-Length is
  // recomputed by fetch from the body).
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'authorization', 'content-type', 'cookie', 'origin', 'referer', 'user-agent']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  // The engine checks Host against its allowed origins; send its own.
  headers.set('host', new URL(ENGINE).host)

  const init = {
    method: request.method,
    headers,
    // Let the browser's Access cookie travel with the subrequest, and never
    // follow a redirect here: a 302 to the login page has to reach the browser so
    // the user can actually sign in.
    redirect: 'manual',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  const upstream = await fetch(target.toString(), init)

  // Pass the body and the headers that matter back. Set-Cookie is forwarded so a
  // session refreshed by the engine still lands on this host.
  const responseHeaders = new Headers()
  for (const name of ['content-type', 'cache-control', 'location', 'set-cookie', 'www-authenticate']) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }

  // CORS is not needed any more (same origin), and echoing an Access-Control-
  // Allow-Origin here would only weaken the check the engine performs itself.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}
