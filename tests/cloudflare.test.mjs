// Runs the exact shared Workers module under plain Node with a mocked fetch.
// Proves the Cloudflare code path needs no Node-only APIs.
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG, handleApi } from '../cloudflare/github.js'

const originalFetch = globalThis.fetch

const now = new Date().toISOString()
const repo = {
  name: 'droidime',
  full_name: 'Tulipskun/droidime',
  html_url: 'https://github.com/Tulipskun/droidime',
  description: '',
  language: 'Kotlin',
  stargazers_count: 0,
  forks_count: 0,
  subscribers_count: 0,
  open_issues_count: 0,
  pushed_at: now,
  created_at: now,
  default_branch: 'main',
  private: false,
  size: 1852,
  topics: [],
  license: null,
}

const fixed = {
  '/repos/Tulipskun/droidime': repo,
  '/repos/Tulipskun/droidime/releases/latest': {
    name: 'DroidIME 1.0.186',
    tag_name: 'latest',
    html_url: 'https://github.com/Tulipskun/droidime/releases/tag/latest',
    published_at: now,
    body: 'DroidIME 1.0.186 (versionCode=186)',
    assets: [{
      name: 'DroidIME.apk',
      size: 58527361,
      download_count: 2,
      browser_download_url: 'https://example.invalid/DroidIME.apk',
      content_type: 'application/vnd.android.package-archive',
    }],
  },
  '/repos/Tulipskun/droidime/actions/runs?per_page=12': {
    workflow_runs: [{
      id: 1,
      name: 'Android Release',
      display_title: 'Fix keyboard layout',
      event: 'push',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://example.invalid/run/1',
      created_at: now,
      run_started_at: now,
      updated_at: now,
    }],
  },
  '/repos/Tulipskun/droidime/commits?per_page=8': [{
    sha: 'abcdef1234567890',
    html_url: 'https://example.invalid/commit/abcdef1',
    commit: { message: 'Fix keyboard layout\n\nDetails', author: { name: 'dev', date: now } },
  }],
  '/repos/Tulipskun/droidime/languages': { Kotlin: 327498, JavaScript: 4653 },
  '/repos/Tulipskun/droidime/pulls?state=open&per_page=100': [],
  '/rate_limit': { rate: { limit: 5000, remaining: 4999, used: 1, reset: 0 } },
  '/user': { login: 'Tulipskun' },
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installMock() {
  globalThis.fetch = async (input) => {
    const url = String(input)
    const path = url.replace('https://api.github.com', '')
    if (path in fixed) return jsonResponse(fixed[path])

    if (path.startsWith('/repos/')) {
      if (path.endsWith('/releases/latest')) return new Response('Not Found', { status: 404 })
      if (path.includes('/actions/runs')) return jsonResponse({ workflow_runs: [] })
      if (path.includes('/commits')) return jsonResponse([])
      if (path.includes('/languages')) return jsonResponse({})
      if (path.includes('/pulls')) return jsonResponse([])
      const parts = path.split('/')
      return jsonResponse({ name: parts[2], full_name: `${parts[1]}/${parts[2]}` })
    }
    return new Response('Not Found', { status: 404 })
  }
}

const env = { GH_TOKEN: 'test-token-not-real' }
const call = (path, method = 'GET') =>
  handleApi(new Request(`https://console.example${path}`, { method }), env, {})

beforeEach(async () => {
  installMock()
  await call('/api/refresh', 'POST') // clear the module-level cache between tests
})

after(() => {
  globalThis.fetch = originalFetch
})

test('config is loaded from apps.config.json (single source of truth)', () => {
  assert.equal(CONFIG.console.name, 'AIxodia Console')
  assert.equal(CONFIG.apps.length, 6)
  assert.equal(CONFIG.apps[0].repo, 'Tulipskun/droidime')
})

test('GET /api/apps returns the config with 6 apps', async () => {
  const res = await call('/api/apps')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.apps.length, 6)
  assert.equal(body.apps.at(-1).id, 'aixodia-dashboard')
})

test('GET /api/health reports the secret and GitHub identity', async () => {
  const res = await call('/api/health')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.authenticated, true)
  assert.equal(body.login, 'Tulipskun')
  assert.equal(body.tokenSource, 'GH_TOKEN secret')
  assert.equal(body.platform, 'cloudflare')
  assert.equal(body.rate.remaining, 4999)
})

test('GET /api/snapshot/droidime maps release, runs, commits and languages', async () => {
  const res = await call('/api/snapshot/droidime')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.repo.fullName, 'Tulipskun/droidime')
  assert.equal(body.release.name, 'DroidIME 1.0.186')
  assert.equal(body.release.versionCode, 186)
  assert.equal(body.release.assets[0].name, 'DroidIME.apk')
  assert.equal(body.runs.length, 1)
  assert.equal(body.runs[0].conclusion, 'success')
  assert.equal(body.commits[0].short, 'abcdef1')
  assert.equal(body.commits[0].message, 'Fix keyboard layout')
  assert.equal(body.languages.Kotlin, 327498)
})

test('GET /api/overview covers every configured app', async () => {
  const res = await call('/api/overview')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.items.length, 6)
  assert.ok(body.items.every((i) => i.ok === true))
  assert.equal(body.items[0].versionCode, 186)
})

test('unknown app and unknown route return 404', async () => {
  assert.equal((await call('/api/snapshot/does-not-exist')).status, 404)
  assert.equal((await call('/api/nope')).status, 404)
})

test('POST /api/refresh clears cache', async () => {
  const res = await call('/api/refresh', 'POST')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, cleared: true })
})

test('works without a token (public GitHub API fallback)', async () => {
  const res = await handleApi(
    new Request('https://console.example/api/snapshot/droidime'),
    {},
    {},
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.repo.fullName, 'Tulipskun/droidime')
})
