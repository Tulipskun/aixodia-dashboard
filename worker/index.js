// Cloudflare Workers entry point for the DroidIME Device Console.
// Static files are served by the Workers Assets binding; /api goes to the shared handler.
import { handleApi } from '../cloudflare/api.js'

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",          // screenshots arrive as data: URLs
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self'",
    "connect-src 'self'",            // browser only talks to our own /api
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx)
    }

    // Falls back to index.html for unknown paths (not_found_handling = SPA).
    const upstream = env.ASSETS
      ? await env.ASSETS.fetch(request)
      : new Response('Static assets binding (ASSETS) is not configured', { status: 500 })

    // Headers of a Response from ASSETS are immutable -> clone first.
    const response = new Response(upstream.body, upstream)
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(key, value)
    }
    return response
  },
}
