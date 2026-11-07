import express from 'express'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = JSON.parse(readFileSync(path.join(__dirname, 'apps.config.json'), 'utf8'))
const APPS = CONFIG.apps
const BY_ID = new Map(APPS.map((a) => [a.id, a]))
const PORT = Number(process.env.PORT || 3000)
const TTL = Number(process.env.CACHE_TTL_MS || 60_000)

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

async function gh(endpoint) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'aixodia-console/1.0',
  }
  if (AUTH.token) headers.Authorization = `Bearer ${AUTH.token}`

  const res = await fetch(`https://api.github.com${endpoint}`, { headers })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 180)
    } catch {
      /* ignore */
    }
    throw new Error(`GitHub ${res.status} ${endpoint} ${detail}`)
  }
  return res.json()
}

const cache = new Map()
async function cached(key, producer) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.data
  const data = await producer()
  cache.set(key, { at: Date.now(), data })
  return data
}

function settled(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback
}

function parseVersionCode(body) {
  const m = /versionCode=(\d+)/.exec(body || '')
  return m ? Number(m[1]) : null
}

async function buildSnapshot(app) {
  const base = `/repos/${app.repo}`
  const [repoR, relR, runsR, commitsR, langsR, pullsR] = await Promise.allSettled([
    gh(base),
    gh(`${base}/releases/latest`),
    gh(`${base}/actions/runs?per_page=12`),
    gh(`${base}/commits?per_page=8`),
    gh(`${base}/languages`),
    gh(`${base}/pulls?state=open&per_page=100`),
  ])

  const repo = settled(repoR, {})
  const rel = settled(relR, null)
  const runsRaw = settled(runsR, { workflow_runs: [] })
  const commitsRaw = settled(commitsR, [])
  const langs = settled(langsR, {})
  const pulls = settled(pullsR, [])

  const runs = (runsRaw.workflow_runs || []).slice(0, 12).map((r) => ({
    id: r.id,
    name: r.name || 'Workflow',
    title: r.display_title || r.head_commit?.message || '(no title)',
    event: r.event,
    branch: r.head_branch,
    status: r.status,
    conclusion: r.conclusion,
    url: r.html_url,
    createdAt: r.created_at,
    startedAt: r.run_started_at,
    updatedAt: r.updated_at,
    durationSec: r.run_started_at
      ? Math.max(0, Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000))
      : null,
    actor: r.actor?.login || null,
  }))

  const commits = (Array.isArray(commitsRaw) ? commitsRaw : []).map((c) => ({
    sha: c.sha,
    short: (c.sha || '').slice(0, 7),
    message: (c.commit?.message || '').split('\n')[0],
    author: c.commit?.author?.name || c.author?.login || 'unknown',
    date: c.commit?.author?.date || null,
    url: c.html_url,
  }))

  const release = rel
    ? {
        name: rel.name || rel.tag_name,
        tag: rel.tag_name,
        url: rel.html_url,
        publishedAt: rel.published_at,
        body: rel.body || '',
        versionCode: parseVersionCode(rel.body),
        assets: (rel.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          downloads: a.download_count,
          url: a.browser_download_url,
          contentType: a.content_type,
        })),
      }
    : null

  return {
    app,
    repo: {
      name: repo.name || app.name,
      fullName: repo.full_name || app.repo,
      url: repo.html_url || `https://github.com/${app.repo}`,
      description: repo.description || app.subtitle,
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
      watchers: repo.subscribers_count || 0,
      openIssues: repo.open_issues_count || 0,
      language: repo.language || null,
      pushedAt: repo.pushed_at || null,
      createdAt: repo.created_at || null,
      defaultBranch: repo.default_branch || 'main',
      private: Boolean(repo.private),
      archived: Boolean(repo.archived),
      sizeKb: repo.size || 0,
      license: repo.license?.spdx_id || null,
      topics: repo.topics || [],
    },
    release,
    runs,
    commits,
    languages: langs || {},
    openPulls: Array.isArray(pulls) ? pulls.length : 0,
    fetchedAt: new Date().toISOString(),
  }
}

function summarize(s) {
  const latest = s.runs[0] || null
  const successes = s.runs.filter((r) => r.conclusion === 'success').length
  return {
    id: s.app.id,
    name: s.app.name,
    accent: s.app.accent,
    tag: s.app.tag,
    openIssues: s.repo.openIssues,
    openPulls: s.openPulls,
    stars: s.repo.stars,
    pushedAt: s.repo.pushedAt,
    releaseName: s.release?.name || null,
    versionCode: s.release?.versionCode || null,
    latestRun: latest
      ? { conclusion: latest.conclusion, status: latest.status, title: latest.title }
      : null,
    ciRate: s.runs.length ? Math.round((successes / s.runs.length) * 100) : null,
  }
}

const server = express()
server.disable('x-powered-by')
server.use(express.json())

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[api error]', err.message)
    res.status(502).json({ error: err.message })
  })

server.get('/api/health', wrap(async (_req, res) => {
  let rate = null
  let login = null
  try {
    const r = await gh('/rate_limit')
    rate = r.rate || r.resources?.core || null
  } catch { /* ignore */ }
  try {
    const u = await gh('/user')
    login = u.login || null
  } catch { /* fine-grained token / unauthenticated */ }
  res.json({
    ok: true,
    authenticated: Boolean(AUTH.token),
    tokenSource: AUTH.source,
    login,
    rate,
    cacheTtlMs: TTL,
    appCount: APPS.length,
    consoleName: CONFIG.console.name,
    owner: CONFIG.console.owner,
    tagline: CONFIG.console.tagline,
  })
}))

server.get('/api/apps', (_req, res) => res.json(CONFIG))

server.get('/api/overview', wrap(async (_req, res) => {
  const data = await cached('overview', async () => {
    const results = await Promise.allSettled(APPS.map((a) => buildSnapshot(a)))
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? { ...summarize(r.value), ok: true }
        : { id: APPS[i].id, name: APPS[i].name, accent: APPS[i].accent, ok: false, error: r.reason?.message },
    )
  })
  res.json({ items: data, fetchedAt: new Date().toISOString() })
}))

server.get('/api/snapshot/:id', wrap(async (req, res) => {
  const app = BY_ID.get(req.params.id)
  if (!app) return res.status(404).json({ error: `Unknown app: ${req.params.id}` })
  const data = await cached(`snap:${app.id}`, () => buildSnapshot(app))
  res.json(data)
}))

server.post('/api/refresh', (_req, res) => {
  cache.clear()
  res.json({ ok: true, cleared: true })
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
})
