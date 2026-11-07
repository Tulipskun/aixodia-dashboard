// Cloudflare Workers entry point.
// Static files are served by the Workers Assets binding; /api/* goes to the shared handler.
import { handleApi } from '../cloudflare/github.js'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx)
    }

    // Falls back to index.html for unknown paths (not_found_handling = SPA).
    if (env.ASSETS) return env.ASSETS.fetch(request)

    return new Response('Static assets binding (ASSETS) is not configured', { status: 500 })
  },
}
