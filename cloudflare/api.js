// Shared API handler for the DroidIME Device Console.
// Runtime-agnostic: imported by worker/index.js, functions/api/[[path]].js and
// server.mjs. Uses only Web-standard Request/Response/URL/Headers/crypto.
//
// Auth model: signed HttpOnly cookie (see auth.js). Every route except
// /health, /session and /login requires a valid session. All POSTs additionally
// require JSON content-type + a same-origin Origin header (CSRF).
//
// IMPORTANT: the CSRF Origin check here is unrelated to the MCP proxy, which
// must STRIP Origin before calling the device (see mcp.js).

import CONFIG from '../apps.config.json' with { type: 'json' }

import { publicTools, ToolValidationError } from './mcp-tools.js'
import {
  authConfig,
  authConfigured,
  sessionFrom,
  issueSessionCookie,
  clearSessionCookie,
  csrfCheck,
  checkRateLimit,
  noteFailedLogin,
  clearLoginAttempts,
  verifyPassword,
  timingSafeEqual,
  resetRateLimitState,
} from './auth.js'
import {
  mcpConfig,
  mcpConfigured,
  probeDevice,
  listTools,
  callTool,
  McpError,
  PROTOCOL_VERSION,
  DEFAULT_MCP_BASE_URL,
} from './mcp.js'

export { CONFIG }

const DEVICES = Array.isArray(CONFIG.devices) ? CONFIG.devices : []
const DEVICE_BY_ID = new Map(DEVICES.map((d) => [d.id, d]))
const DEVICE_IDS = new Set(DEVICE_BY_ID.keys())
const PRESETS = Array.isArray(CONFIG.presets) ? CONFIG.presets : []

const BODY_LIMIT = 64 * 1024
const STATUS_TTL_MS = 15_000
const COMMAND_CAP = 50

const statusCache = new Map()
const commandLog = []

// Test helpers: clear per-isolate state between cases.
export function resetApiState() {
  statusCache.clear()
  commandLog.length = 0
  resetRateLimitState()
}

function randomId() {
  try {
    return crypto.randomUUID().slice(0, 8)
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

function baseHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: baseHeaders(extra),
  })
}

function jsonError(status, code, message, fields = {}, headers = {}) {
  return json({ error: message, code, ...fields }, status, headers)
}

class BodyError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function readJsonBody(request, limit = BODY_LIMIT) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > limit) throw new BodyError(413, 'BODY_TOO_LARGE', 'Request body ใหญ่เกินกำหนด')
  const text = await request.text()
  if (text.length > limit) throw new BodyError(413, 'BODY_TOO_LARGE', 'Request body ใหญ่เกินกำหนด')
  if (!text.trim()) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new BodyError(400, 'INVALID_JSON', 'JSON ไม่ถูกต้อง')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BodyError(400, 'INVALID_JSON', 'JSON ต้องเป็น object')
  }
  return value
}

function clientKey(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  )
}

function platformOf(env) {
  return env?.__PLATFORM || 'cloudflare'
}

function sessionPayload(session, env) {
  return {
    authenticated: Boolean(session),
    username: session?.u || null,
    expiresAt: session ? new Date(session.exp * 1000).toISOString() : null,
    platform: platformOf(env),
  }
}

// ---------- status cache ----------

async function cachedStatus(deviceId, env, force = false) {
  const hit = statusCache.get(deviceId)
  if (!force && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status
  const status = await probeDevice(deviceId, env, DEVICE_IDS)
  statusCache.set(deviceId, { at: Date.now(), status })
  return status
}

// ---------- command log (best-effort, in-memory, metadata only) ----------

function pushCommand(entry) {
  commandLog.unshift(entry)
  if (commandLog.length > COMMAND_CAP) commandLog.length = COMMAND_CAP
}

function logAction(result, requestId, ok, error) {
  pushCommand({
    id: requestId,
    at: result?.at || new Date().toISOString(),
    device: result?.device || null,
    tool: result?.tool || null,
    ok,
    durationMs: result?.durationMs ?? null,
    hasScreenshot: Boolean(result?.screenshot),
    error: error ? { code: error.code, message: error.message } : null,
  })
}

// ---------- login ----------

async function handleLogin(request, env, url) {
  const cfg = authConfig(env)
  if (!authConfigured(cfg)) {
    return jsonError(503, 'AUTH_NOT_CONFIGURED', 'ระบบ login ยังไม่ได้ตั้งค่า (ขาด SESSION_SECRET / AUTH_USERNAME / AUTH_PASSWORD_HASH)')
  }

  const csrf = csrfCheck(request, url)
  if (!csrf.ok) return jsonError(403, csrf.code, csrf.message)

  const key = clientKey(request)
  const limit = checkRateLimit(key)
  if (!limit.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'ลองเข้าสู่ระบบมากเกินไป กรุณารอสักครู่', {
      retryAfter: limit.retryAfter,
    }, { 'Retry-After': String(limit.retryAfter) })
  }

  let body
  try {
    body = await readJsonBody(request)
  } catch (err) {
    return jsonError(err.status, err.code, err.message)
  }

  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  // Always run the (expensive) hash verification even when username is wrong,
  // so the two failure paths are not distinguishable by timing.
  const userOk = timingSafeEqual(username, cfg.username)
  const passOk = await verifyPassword(password, cfg.passwordHash)

  if (!userOk || !passOk) {
    noteFailedLogin(key)
    // Identical message for both wrong username and wrong password.
    return jsonError(401, 'INVALID_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
  }

  clearLoginAttempts(key)
  const { cookie, expiresAt } = await issueSessionCookie(username, env, url)
  return json(
    { ok: true, username, expiresAt, platform: platformOf(env) },
    200,
    { 'Set-Cookie': cookie },
  )
}

// ---------- actions ----------

async function handleAction(deviceId, body, env, url) {
  const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 64) : randomId()
  const device = DEVICE_BY_ID.get(deviceId)
  if (!device) {
    return jsonError(404, 'UNKNOWN_DEVICE', `ไม่พบอุปกรณ์: ${deviceId}`, { requestId })
  }

  let result
  try {
    result = await callTool(deviceId, body.tool, body.arguments, env, DEVICE_IDS)
  } catch (err) {
    if (err instanceof ToolValidationError) {
      const status = err.code === 'UNKNOWN_TOOL' ? 404 : 400
      return jsonError(status, err.code, err.message, { requestId })
    }
    if (err instanceof McpError) {
      const status = err.status || 502
      return jsonError(status, err.code, err.message, {
        requestId,
        reason: err.code === 'DEVICE_OFFLINE' ? 'offline' : err.code === 'DEVICE_TIMEOUT' ? 'timeout' : null,
        detail: err.detail || null,
        checkedAt: new Date().toISOString(),
      })
    }
    return jsonError(502, 'MCP_RPC_ERROR', String(err?.message || err), { requestId })
  }

  logAction(result, requestId, true, null)
  return json({ ...result, requestId, platform: platformOf(env) })
}

// ---------- main router ----------

export async function handleApi(request, env = {}, _ctx = {}) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = request.method.toUpperCase()

  // CORS/preflight: same-origin only, never allow arbitrary origins.
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      },
    })
  }

  // ---- public routes (no upstream calls, no secrets in payload) ----

  if (method === 'GET' && path === '/health') {
    return json({
      ok: true,
      platform: platformOf(env),
      authConfigured: authConfigured(authConfig(env)),
      mcpConfigured: mcpConfigured(mcpConfig(env)),
      mcpBaseUrl: String(env?.MCP_BASE_URL || DEFAULT_MCP_BASE_URL).replace(/\/+$/, ''),
      protocolVersion: PROTOCOL_VERSION,
      deviceCount: DEVICES.length,
      consoleName: CONFIG.console?.name || 'AIxodia Device Console',
      time: new Date().toISOString(),
    })
  }

  if (method === 'GET' && path === '/session') {
    const session = await sessionFrom(request, env)
    return json(sessionPayload(session, env))
  }

  if (method === 'POST' && path === '/login') {
    return handleLogin(request, env, url)
  }

  // ---- auth gate ----

  const session = await sessionFrom(request, env)
  if (!session) {
    return jsonError(401, 'AUTH_REQUIRED', 'ต้องเข้าสู่ระบบก่อนใช้งาน', {
      platform: platformOf(env),
      loginUrl: '/api/login',
    })
  }

  // ---- CSRF gate for every mutation ----
  if (method === 'POST') {
    const csrf = csrfCheck(request, url)
    if (!csrf.ok) return jsonError(403, csrf.code, csrf.message)
  }

  if (method === 'POST' && path === '/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(url) })
  }

  if (method === 'GET' && path === '/config') {
    return json({
      console: CONFIG.console,
      devices: DEVICES,
      presets: PRESETS,
      protocolVersion: PROTOCOL_VERSION,
      platform: platformOf(env),
    })
  }

  if (method === 'GET' && path === '/devices') {
    const items = await Promise.all(
      DEVICES.map(async (d) => ({ ...d, status: await cachedStatus(d.id, env) })),
    )
    return json({ items, checkedAt: new Date().toISOString(), ephemeral: true })
  }

  const statusMatch = /^\/devices\/([^/]+)\/status$/.exec(path)
  if (method === 'GET' && statusMatch) {
    const id = decodeURIComponent(statusMatch[1])
    if (!DEVICE_BY_ID.has(id)) return jsonError(404, 'UNKNOWN_DEVICE', `ไม่พบอุปกรณ์: ${id}`)
    const force = url.searchParams.get('refresh') === '1'
    // Always 200, even when offline (UI renders OfflineState instead of an error).
    return json({ device: id, ...(await cachedStatus(id, env, force)), platform: platformOf(env) })
  }

  if (method === 'GET' && path === '/tools') {
    let source = 'catalog'
    let deviceTools = null
    const first = DEVICES[0]
    if (first) {
      const status = await cachedStatus(first.id, env)
      if (status.online) {
        try {
          deviceTools = await listTools(first.id, env, DEVICE_IDS)
          source = 'device'
        } catch {
          source = 'catalog'
        }
      }
    }
    return json({
      tools: publicTools(),
      source,
      deviceTools,
      protocolVersion: PROTOCOL_VERSION,
      note: 'ฟอร์ม UI ใช้ catalog ที่ validate แล้ว; deviceTools เป็นข้อมูลอ้างอิงจาก tools/list',
    })
  }

  if (method === 'GET' && path === '/commands') {
    return json({ items: commandLog, cap: COMMAND_CAP, ephemeral: true })
  }

  const actionMatch = /^\/devices\/([^/]+)\/action$/.exec(path)
  if (method === 'POST' && actionMatch) {
    let body
    try {
      body = await readJsonBody(request)
    } catch (err) {
      return jsonError(err.status, err.code, err.message)
    }
    return handleAction(decodeURIComponent(actionMatch[1]), body, env, url)
  }

  if (method === 'POST' && path === '/actions') {
    let body
    try {
      body = await readJsonBody(request)
    } catch (err) {
      return jsonError(err.status, err.code, err.message)
    }
    const id = typeof body.device === 'string' ? body.device : ''
    if (!id) return jsonError(400, 'INVALID_DEVICE', 'ต้องระบุ device ใน body')
    return handleAction(id, body, env, url)
  }

  return jsonError(404, 'UNKNOWN_ROUTE', `ไม่พบ API route: ${path}`)
}
