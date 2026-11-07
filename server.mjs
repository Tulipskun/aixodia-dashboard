// Local Node/Express adapter for local development.
// The API logic lives in cloudflare/api.js and is shared verbatim with
// Cloudflare Workers and Pages Functions. This file only translates Express
// req/res into standard Request/Response objects.
//
// Secrets are loaded from .dev.vars (or real environment variables), NEVER
// from the browser and NEVER from a GitHub token.
import express from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { handleApi } from './cloudflare/api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)

function loadDevVars() {
  const file = path.join(__dirname, '.dev.vars')
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i < 0) continue
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
  }
  return out
}

// Real env vars win over .dev.vars (production / CI).
const ENV = {
  ...loadDevVars(),
  ...process.env,
  __PLATFORM: 'node-express',
}

async function readRawBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const server = express()
server.disable('x-powered-by')

// Matches both /api and /api/* (Express 4 accepts a RegExp route).
server.all(/^\/api(?:\/.*)?$/, async (req, res) => {
  try {
    const url = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) headers.set(key, value.join(', '))
    }

    const method = req.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const raw = hasBody ? await readRawBody(req) : Buffer.alloc(0)

    const request = new Request(url, {
      method,
      headers,
      body: raw.length ? raw : undefined,
      duplex: 'half',
    })

    const response = await handleApi(request, ENV, {})
    const body = await response.text()

    res.status(response.status)
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value)
    })
    // getSetCookie() keeps multiple Set-Cookie headers intact; forEach()
    // would join them into one broken cookie string.
    const cookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    for (const cookie of cookies) res.append('Set-Cookie', cookie)

    res.send(body)
  } catch (err) {
    console.error('[api error]', err?.message || err)
    res.status(502).json({ error: err?.message || 'Internal error', code: 'ADAPTER_ERROR' })
  }
})

const distDir = path.join(__dirname, 'dist')
const production = process.env.NODE_ENV === 'production' && existsSync(path.join(distDir, 'index.html'))

// Mirror the production CSP/security headers used by Workers + Pages so local
// production mode catches the same issues (screenshots need img-src data:).
if (production) {
  server.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '))
    next()
  })
  server.use(express.static(distDir))
  server.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'spa',
  })
  server.use(vite.middlewares)
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AIxodia Device Console  →  http://localhost:${PORT}`)
  console.log(`mode       : ${production ? 'production (dist)' : 'dev (vite middleware)'}`)
  console.log(`auth       : ${ENV.SESSION_SECRET && ENV.AUTH_PASSWORD_HASH ? 'configured [values hidden]' : 'NOT configured — run: npm run hash:password'}`)
  console.log(`mcp access : ${ENV.CF_ACCESS_CLIENT_ID && ENV.CF_ACCESS_CLIENT_SECRET ? 'credentials present [values hidden]' : 'NOT configured'}`)
  console.log(`platform   : node-express (shared Workers API layer)`)
})
