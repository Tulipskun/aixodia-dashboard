// Cloudflare Pages Functions: catch-all for /api/*.
// Static assets from dist/ are served by Pages before Functions are considered.
import { handleApi } from '../../cloudflare/github.js'

export const onRequestGet = (context) => handleApi(context.request, context.env, context)
export const onRequestPost = (context) => handleApi(context.request, context.env, context)
