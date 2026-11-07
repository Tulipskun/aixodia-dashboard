// Local Node/Express adapter.
// The API logic itself lives in cloudflare/github.js and is shared verbatim
// with Cloudflare Workers and Pages Functions — this file only translates
// Express req/res into standard Request/Response objects.
import express from 'express'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { handleApi } from './cloudflare/github.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)

// Token อยู่ฝั่ง server เท่านั้น ไม่มีทางลงไปถึง browser bundle
function resolveToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (fromEnv) return { token: fromEnv.trim(), source: 'GH_TOKEN (env)' }
  try {
    const t = execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (t) return { token: t, source: 'gh auth token' }
  } catch {
    // ไม่มี gh CLI หรือยังไม่ได้ล็อกอิน → ใช้แบบไม่ยืนยันตัว (public repos)
  }
  return { token: null, source: 'unauthenticated' }
}

const AUTH = resolveToken()
const ENV = {
  GH_TOKEN: AUTH.token || undefined,
  __TOKEN_SOURCE_LABEL: AUTH.source,
  __PLATFORM: 'node-express',
}

const server = express()
server.disable('x-powered-by')

server.all('/api/*', async (req, res) => {
  try {
    const url = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) headers.set(key, value.join(', '))
    }
    const request = new Request(url, { method: req.method, headers })
    const response = await handleApi(request, ENV, {})
    const body = await response.text()
    res.status(response.status)
    response.headers.forEach((value, key) => res.setHeader(key, value))
    res.send(body)
  } catch (err) {
    console.error('[api error]', err.message)
    res.status(502).json({ error: err.message })
  }
})

const distDir = path.join(__dirname, 'dist')
const production = process.env.NODE_ENV === 'production' && existsSync(path.join(distDir, 'index.html'))

if (production) {
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
  console.log(`AIxodia Console  →  http://localhost:${PORT}`)
  console.log(`mode            :  ${production ? 'production (dist)' : 'dev (vite middleware)'}`)
  console.log(`GitHub auth     :  ${AUTH.source}${AUTH.token ? ' [token hidden]' : ''}`)
  console.log(`platform        :  node-express (shared Workers API layer)`)
})
