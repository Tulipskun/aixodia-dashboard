// Cloudflare Pages Functions: single catch-all for /api/*.
// A single onRequest handler covers GET, POST and OPTIONS (a Get/Post pair
// would silently swallow preflight and logout-style requests).
// Static assets from dist/ are served by Pages before Functions are considered.
import { handleApi } from '../../cloudflare/api.js'

export const onRequest = (context) => handleApi(context.request, context.env, context)
