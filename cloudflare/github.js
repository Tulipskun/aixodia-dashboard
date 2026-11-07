// Shared, runtime-agnostic API layer.
// Uses only Web-standard APIs (fetch / Request / Response / URL / caches),
// so the exact same code runs on Workers, Pages Functions and local Node/Express.
import CONFIG from '../apps.config.json' with { type: 'json' }

export { CONFIG }

const APPS = CONFIG.apps
const BY_ID = new Map(APPS.map((a) => [a.id, a]))
const TTL_MS = 60_000
const TTL_SEC = 60
const CACHE_ORIGIN = 'https://aixodia-console.cache'
const memory = new Map()

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function tokenFrom(env) {
  const raw = env?.GH_TOKEN || env?.GITHUB_TOKEN || ''
  return String(raw).trim() || null
}

async function gh(endpoint, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'aixodia-console/1.0',
  }
  if (token) headers.Authorization = `Bearer ${token}`

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

function defaultCache() {
  try {
    return caches.default
  } catch {
    return null // Node local dev / unit tests have no Cache API
  }
}

async function cached(key, produce) {
  const hit = memory.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data

  const cache = defaultCache()
  if (cache) {
    try {
      const res = await cache.match(`${CACHE_ORIGIN}/${key}`)
      if (res) {
        const data = await res.json()
        memory.set(key, { at: Date.now(), data })
        return data
      }
    } catch {
      /* cache miss / unavailable */
    }
  }

  const data = await produce()
  memory.set(key, { at: Date.now(), data })

  if (cache) {
    try {
      await cache.put(
        `${CACHE_ORIGIN}/${key}`,
        new Response(JSON.stringify(data), {
          headers: { 'Cache-Control': `public, max-age=${TTL_SEC}` },
        }),
      )
    } catch {
      /* best effort */
    }
  }
  return data
}

async function clearCache() {
  memory.clear()
  const cache = defaultCache()
  if (!cache) return
  const keys = ['overview', ...APPS.map((a) => `snap:${a.id}`)]
  await Promise.all(
    keys.map((k) => cache.delete(`${CACHE_ORIGIN}/${k}`).catch(() => false)),
  )
}

function settled(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback
}

function parseVersionCode(body) {
  const m = /versionCode=(\d+)/.exec(body || '')
  return m ? Number(m[1]) : null
}

export async function buildSnapshot(app, token) {
  const base = `/repos/${app.repo}`
  const [repoR, relR, runsR, commitsR, langsR, pullsR] = await Promise.allSettled([
    gh(base, token),
    gh(`${base}/releases/latest`, token),
    gh(`${base}/actions/runs?per_page=12`, token),
    gh(`${base}/commits?per_page=8`, token),
    gh(`${base}/languages`, token),
    gh(`${base}/pulls?state=open&per_page=100`, token),
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

export function summarize(s) {
  const latest = s.runs[0] || null
  const successes = s.runs.filter((r) => r.conclusion === 'success').length
  return {
    id: s.app.id,
    name: s.app.name,
    accent: s.app.accent,
    tag: s.app.tag,
    ok: true,
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

// Workers / Pages Functions entry point for every /api/* request.
export async function handleApi(request, env = {}, _ctx = {}) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = request.method.toUpperCase()
  const token = tokenFrom(env)

  try {
    if (method === 'GET' && path === '/health') {
      let rate = null
      let login = null
      try {
        const r = await gh('/rate_limit', token)
        rate = r.rate || r.resources?.core || null
      } catch { /* ignore */ }
      try {
        const u = await gh('/user', token)
        login = u.login || null
      } catch { /* fine-grained token / unauthenticated */ }
      return json({
        ok: true,
        authenticated: Boolean(token),
        tokenSource: env?.__TOKEN_SOURCE_LABEL || (token ? 'GH_TOKEN secret' : 'unauthenticated'),
        login,
        rate,
        cacheTtlMs: TTL_MS,
        appCount: APPS.length,
        consoleName: CONFIG.console.name,
        owner: CONFIG.console.owner,
        tagline: CONFIG.console.tagline,
        platform: env?.__PLATFORM || 'cloudflare',
      })
    }

    if (method === 'GET' && path === '/apps') return json(CONFIG)

    if (method === 'POST' && path === '/refresh') {
      await clearCache()
      return json({ ok: true, cleared: true })
    }

    if (method === 'GET' && path === '/overview') {
      const data = await cached('overview', async () => {
        const results = await Promise.allSettled(APPS.map((a) => buildSnapshot(a, token)))
        return results.map((r, i) =>
          r.status === 'fulfilled'
            ? summarize(r.value)
            : {
                id: APPS[i].id,
                name: APPS[i].name,
                accent: APPS[i].accent,
                ok: false,
                error: r.reason?.message,
              },
        )
      })
      return json({ items: data, fetchedAt: new Date().toISOString() })
    }

    if (method === 'GET' && path.startsWith('/snapshot/')) {
      const id = decodeURIComponent(path.slice('/snapshot/'.length))
      const app = BY_ID.get(id)
      if (!app) return json({ error: `Unknown app: ${id}` }, 404)
      const data = await cached(`snap:${app.id}`, () => buildSnapshot(app, token))
      return json(data)
    }

    return json({ error: `Unknown API route: ${path}` }, 404)
  } catch (err) {
    return json({ error: err?.message || String(err) }, 502)
  }
}
