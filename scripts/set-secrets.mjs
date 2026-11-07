#!/usr/bin/env node
// Sync the 5 console secrets into ONE Cloudflare secret store, from the remote
// machine only (so credentials never have to leave that machine).
//
//   sudo -n AXD_SECRETS_DIR=/opt/aixodia-dashboard/.secrets \
//     CLOUDFLARE_API_TOKEN="$(sudo -n cat /root/cf_token.txt)" \
//     CLOUDFLARE_ACCOUNT_ID="..." \
//     node scripts/set-secrets.mjs worker
//   ... node scripts/set-secrets.mjs pages
//
// Values are piped into `wrangler secret put` via stdin. Nothing is echoed,
// logged, written to disk, or added to argv.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const PROJECT = 'aixodia-dashboard'

const target = String(process.argv[2] || '').toLowerCase()
if (!['worker', 'pages'].includes(target)) {
  console.error('usage: node scripts/set-secrets.mjs <worker|pages>')
  process.exit(2)
}
if (!existsSync(WRANGLER)) {
  console.error('ไม่พบ wrangler — รัน npm ci ก่อน')
  process.exit(2)
}

const SECRETS = [
  'SESSION_SECRET',
  'AUTH_USERNAME',
  'AUTH_PASSWORD_HASH',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
]

const dir = process.env.AXD_SECRETS_DIR || path.join(ROOT, '.secrets')
const FALLBACK_FILE = {
  CF_ACCESS_CLIENT_ID: '/root/aixodia-mcp-access-client-id',
  CF_ACCESS_CLIENT_SECRET: '/root/aixodia-mcp-access-client-secret',
}

function readSecret(name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim()
  for (const candidate of [path.join(dir, name), FALLBACK_FILE[name]]) {
    if (candidate && existsSync(candidate)) {
      const v = readFileSync(candidate, 'utf8').trim()
      if (v) return v
    }
  }
  return null
}

function wranglerArgs(action, name) {
  return target === 'worker'
    ? ['secret', action, name, '--config', 'wrangler.worker.toml']
    : ['pages', 'secret', action, name, '--project-name', PROJECT]
}

function run(args, input, label) {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    timeout: 90_000,
  })
  if (r.status !== 0) {
    // stderr may contain wrangler diagnostics; never contains the secret value.
    console.error(`[${target}] ${label}: FAILED (${r.status}) ${String(r.stderr || '').slice(0, 300)}`)
    return false
  }
  return true
}

let failed = 0
for (const name of SECRETS) {
  const value = readSecret(name)
  if (!value) {
    console.error(`[${target}] ${name}: ไม่พบค่า (env, ${dir}/${name}, หรือ fallback file)`)
    failed += 1
    continue
  }
  if (run(wranglerArgs('put', name), `${value}\n`, name)) {
    console.log(`[${target}] ${name}: OK`)
  } else {
    failed += 1
  }
}

// Best-effort cleanup of the old GitHub-dashboard secret (two separate stores).
run(wranglerArgs('delete', 'GH_TOKEN'), 'y\n', 'GH_TOKEN cleanup')

if (failed > 0) {
  console.error(`[${target}] ${failed} secret(s) ไม่สำเร็จ`)
  process.exit(1)
}
console.log(`[${target}] secrets synced (ค่าไม่ถูกพิมพ์หรือบันทึก)`)
