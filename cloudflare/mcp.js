// DroidIME MCP client (server-side proxy). Runtime-agnostic Web-standard APIs.
//
// Verified facts from Tulipskun/droidime McpServer.kt:
//  - POST https://<base>/<device-name>, JSON-RPC 2.0, only POST is accepted.
//  - No initialize / Mcp-Session-Id needed; tools/list & tools/call only require
//    the MCP-Protocol-Version header (2025-11-25).
//  - Any Origin header other than literal "null" -> 403. So we ALWAYS build a
//    fresh Headers object and NEVER copy request.headers (no Origin/Cookie/
//    Authorization/Referer may leak upstream).
//  - tools/call params = { name, arguments }; every action returns a text item
//    plus a base64 PNG image item; screenshot returns just the image.
//  - When the device is down the Cloudflare gateway replies 502 with an HTML
//    error page (NOT JSON) -> must be mapped to DEVICE_OFFLINE, not a 500.
//
// Cloudflare Access protects mcp.aixodia.dpdns.org/* with a service token:
//   CF-Access-Client-Id / CF-Access-Client-Secret (secrets, never sent to browser).

import { validateTool } from './mcp-tools.js'

export const DEFAULT_MCP_BASE_URL = 'https://mcp.aixodia.dpdns.org'
export const PROTOCOL_VERSION = '2025-11-25'
export const DEVICE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

const MAX_BASE64 = 8 * 1024 * 1024
const ACTION_TIMEOUT_MS = 8_000
const PROBE_TIMEOUT_MS = 2_500

export class McpError extends Error {
  constructor(code, message, detail = '', status = 502) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.detail = detail
    this.status = status
  }
}

export function mcpConfig(env = {}) {
  const baseUrl = String(env.MCP_BASE_URL || DEFAULT_MCP_BASE_URL).trim().replace(/\/+$/, '')
  return {
    baseUrl,
    clientId: String(env.CF_ACCESS_CLIENT_ID || '').trim(),
    clientSecret: String(env.CF_ACCESS_CLIENT_SECRET || '').trim(),
    actionTimeoutMs: clampMs(env.MCP_ACTION_TIMEOUT_MS, ACTION_TIMEOUT_MS),
    probeTimeoutMs: clampMs(env.MCP_PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
  }
}

function clampMs(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 200 && n <= 60_000 ? Math.round(n) : fallback
}

export function mcpConfigured(cfg) {
  return Boolean(cfg && cfg.clientId && cfg.clientSecret && cfg.baseUrl)
}

/** SSRF guard: strict name syntax + allowlist from apps.config.json. */
export function assertDeviceName(name, allowed) {
  if (typeof name !== 'string' || !DEVICE_RE.test(name)) {
    throw new McpError('INVALID_DEVICE', 'ชื่ออุปกรณ์ไม่ถูกต้อง', 'must match ^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$', 400)
  }
  if (allowed && !allowed.has(name)) {
    throw new McpError('UNKNOWN_DEVICE', `ไม่พบอุปกรณ์: ${name}`, 'not present in apps.config.json allowlist', 404)
  }
  return name
}

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  }
}

let idSeq = 0

/**
 * One JSON-RPC round trip. `headers` is constructed from scratch on purpose.
 * Returns { result, latencyMs, status }.
 */
export async function rpcCall(device, method, params, env = {}, opts = {}) {
  const cfg = mcpConfig(env)
  assertDeviceName(device, opts.allowedDevices)

  const url = `${cfg.baseUrl}/${encodeURIComponent(device)}`
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json')
  headers.set('MCP-Protocol-Version', opts.protocolVersion || PROTOCOL_VERSION)
  if (cfg.clientId) headers.set('CF-Access-Client-Id', cfg.clientId)
  if (cfg.clientSecret) headers.set('CF-Access-Client-Secret', cfg.clientSecret)
  // Intentionally absent: Origin, Cookie, Authorization, Referer, User-Agent custom.

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++idSeq,
    method,
    params: params || {},
  })

  const timeoutMs = opts.timeoutMs || cfg.actionTimeoutMs
  const started = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: timeoutSignal(timeoutMs),
      redirect: 'manual',
    })
  } catch (err) {
    const name = err?.name || ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new McpError('DEVICE_TIMEOUT', 'อุปกรณ์ไม่ตอบสนองภายในเวลาที่กำหนด', `timeout ${timeoutMs}ms`, 504)
    }
    throw new McpError('DEVICE_OFFLINE', 'ไม่สามารถเชื่อมต่ออุปกรณ์ได้', String(err?.message || err), 503)
  }

  const latencyMs = Date.now() - started
  const ctype = res.headers.get('content-type') || ''

  if (!res.ok) {
    let detail = `HTTP ${res.status} ${res.statusText || ''}`.trim()
    if (ctype.toLowerCase().includes('json')) {
      try {
        const j = await res.json()
        if (j?.error?.message) detail = String(j.error.message).slice(0, 300)
      } catch { /* keep status-based detail */ }
    } else {
      detail += ' (upstream returned non-JSON, likely gateway error page)'
    }
    if ([502, 503, 504].includes(res.status)) {
      throw new McpError('DEVICE_OFFLINE', 'อุปกรณ์ออฟไลน์หรือ gateway ไม่พร้อม', detail, 503)
    }
    if (res.status === 401 || res.status === 403) {
      throw new McpError('MCP_RPC_ERROR', 'Upstream ปฏิเสธคำขอ (ตรวจสอบ Access service token / Origin)', detail, 502)
    }
    throw new McpError('MCP_RPC_ERROR', `Upstream ตอบ HTTP ${res.status}`, detail, 502)
  }

  if (!ctype.toLowerCase().includes('json')) {
    throw new McpError('DEVICE_OFFLINE', 'Upstream ไม่ได้ตอบ JSON-RPC', `HTTP ${res.status} ${ctype}`, 503)
  }

  let payload
  try {
    payload = await res.json()
  } catch {
    throw new McpError('MCP_RPC_ERROR', 'JSON-RPC response ไม่ถูกต้อง', 'invalid JSON', 502)
  }
  if (payload?.error) {
    const msg = String(payload.error.message || 'JSON-RPC error').slice(0, 300)
    throw new McpError('MCP_RPC_ERROR', msg, `code ${payload.error.code ?? '?'}`, 502)
  }
  return { result: payload?.result ?? null, latencyMs, status: res.status }
}

/** Pull text + image content out of an MCP tools/call result. */
export function extractScreenshot(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const texts = []
  let screenshot = null
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
    if (item.type === 'image' && typeof item.data === 'string') {
      if (item.data.length > MAX_BASE64) {
        throw new McpError('MCP_RPC_ERROR', 'ภาพหน้าจอมีขนาดเกินกำหนด', `base64 length ${item.data.length}`, 502)
      }
      screenshot = {
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'image/png',
        data: item.data,
      }
    }
  }
  return { text: texts.join('\n').trim(), screenshot }
}

/** Always resolves with a status object (never throws) -> /status returns 200. */
export async function probeDevice(device, env = {}, allowed) {
  const checkedAt = new Date().toISOString()
  try {
    const { latencyMs } = await rpcCall(device, 'server/discover', {}, env, {
      allowedDevices: allowed,
      timeoutMs: mcpConfig(env).probeTimeoutMs,
    })
    return { online: true, latencyMs, checkedAt, reason: null, detail: null }
  } catch (err) {
    const reason =
      err?.code === 'DEVICE_TIMEOUT' ? 'timeout'
      : err?.code === 'DEVICE_OFFLINE' ? 'offline'
      : err?.code === 'INVALID_DEVICE' || err?.code === 'UNKNOWN_DEVICE' ? 'invalid_device'
      : 'error'
    return {
      online: false,
      latencyMs: null,
      checkedAt,
      reason,
      detail: String(err?.detail || err?.message || '').slice(0, 300) || null,
    }
  }
}

/** Ask the device for its own tools/list (only meaningful when online). */
export async function listTools(device, env = {}, allowed) {
  const { result } = await rpcCall(device, 'tools/list', {}, env, { allowedDevices: allowed })
  const tools = Array.isArray(result?.tools) ? result.tools : []
  return tools.map((t) => ({
    name: String(t?.name || ''),
    description: String(t?.description || ''),
    inputSchema: t?.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : null,
  }))
}

/** Validate -> JSON-RPC tools/call -> normalize into an ActionResult. */
export async function callTool(device, name, args, env = {}, allowed) {
  // Runs BEFORE any network call: rejects unknown tools / bad arguments early.
  const validated = validateTool(name, args)

  const { result, latencyMs } = await rpcCall(
    device,
    'tools/call',
    validated,
    env,
    { allowedDevices: allowed },
  )

  if (result?.isError) {
    const { text } = extractScreenshot(result)
    throw new McpError('MCP_TOOL_ERROR', text || 'อุปกรณ์รายงานข้อผิดพลาดขณะรันคำสั่ง', `tool ${validated.name}`, 502)
  }

  const { text, screenshot } = extractScreenshot(result)
  return {
    ok: true,
    device,
    tool: validated.name,
    arguments: validated.arguments,
    text,
    screenshot,
    durationMs: latencyMs,
    at: new Date().toISOString(),
  }
}
