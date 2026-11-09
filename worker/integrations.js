const DEVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ENGINE_HOST = /(^|\.)aixodia\.dpdns\.org$/;
const DEVICE_TOOLS = new Set([
  "tap", "long_press", "swipe", "gesture", "multi_touch", "key_event",
  "input_text", "click_sequence", "screen_size", "ui_hierarchy",
  "screenshot", "act_and_observe",
]);

const deviceStatusCache = new Map();
const DEVICE_REGISTRY_TTL_MS = 5 * 60_000;
const DEVICE_STATUS_TTL_MS = 15_000;
const deviceRegistryCache = new WeakMap();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function error(status, message, code = "INTEGRATION_ERROR") {
  return json({ error: message, code }, status);
}
function validDevice(name) {
  return typeof name === "string" && DEVICE_NAME.test(name);
}
function validEngineUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ENGINE_HOST.test(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function engineBase(env) {
  const value = typeof env.ENGINE_URL === "string" ? env.ENGINE_URL.trim() : "";
  if (!value) throw new Error("Engine URL is not configured");
  if (!validEngineUrl(value)) throw new Error("The configured engine URL is invalid");
  return value.replace(/\/$/, "");
}

export async function getEngineStatus(env) {
  try {
    const base = engineBase(env);
    if (!base) return { configured: true, online: false, checkedAt: new Date().toISOString(), reason: "Engine URL is not registered", metrics: null };
    const response = await fetch(`${base}/healthz`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Engine health returned HTTP ${response.status}`);
    const data = await response.json();
    if (data?.ok !== true) throw new Error("Engine health check failed");
    return {
      configured: true,
      online: true,
      checkedAt: new Date().toISOString(),
      version: data.version ?? null,
      startedAt: Number(data.started) || null,
      uptimeSeconds: finite(data.uptime_seconds),
      metrics: {
        cpuPercent: finite(data.cpu_percent),
        memoryUsedBytes: finite(data.memory_used_bytes),
        memoryTotalBytes: finite(data.memory_total_bytes),
        memoryPercent: finite(data.memory_percent),
      },
    };
  } catch (cause) {
    return {
      configured: Boolean(env.ENGINE_URL && env.CF_TOKEN),
      online: false,
      checkedAt: new Date().toISOString(),
      reason: cause instanceof Error ? cause.message : "Engine is unreachable",
      metrics: null,
    };
  }
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const ENGINE_ROUTE_RULES = [
  [/^\/v1\/sessions$/, new Set(["GET", "POST"])],
  [/^\/v1\/sessions\/[A-Za-z0-9._-]{1,128}$/, new Set(["GET", "PATCH", "DELETE"])],
  [/^\/v1\/sessions\/[A-Za-z0-9._-]{1,128}\/turns$/, new Set(["GET"])],
  [/^\/v1\/runs$/, new Set(["POST"])],
  [/^\/v1\/runs\/run_[a-f0-9]{16}$/, new Set(["GET"])],
  [/^\/v1\/runs\/run_[a-f0-9]{16}\/events$/, new Set(["GET"])],
  [/^\/v1\/runs\/run_[a-f0-9]{16}\/cancel$/, new Set(["POST"])],
];

export async function proxyEngine(request, env, enginePath) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!ENGINE_ROUTE_RULES.some(([pattern, methods]) => pattern.test(enginePath) && methods.has(method))) {
    return error(404, "Engine route not available", "NOT_FOUND");
  }
  try {
    const base = engineBase(env);
    if (!base) return error(503, "AIxodia Engine is not online", "ENGINE_OFFLINE");
    const upstreamHeaders = new Headers();
    upstreamHeaders.set("authorization", `Bearer ${env.CF_TOKEN}`);
    upstreamHeaders.set("accept", request.headers.get("accept") || "application/json");
    const type = request.headers.get("content-type");
    if (type) upstreamHeaders.set("content-type", type);
    const init = { method, headers: upstreamHeaders, signal: AbortSignal.timeout(120_000), redirect: "manual" };
    if (method !== "GET" && method !== "HEAD") init.body = await request.arrayBuffer();
    return await fetch(`${base}${enginePath}${url.search}`, init);
  } catch (cause) {
    return error(502, cause instanceof Error ? cause.message : "Engine request failed", "ENGINE_UNAVAILABLE");
  }
}

async function mcpRequest(env, device, payload, { protocol = false, timeoutMs = 5000 } = {}) {
  if (!validDevice(device)) throw new Error("Invalid device name");
  if (!env.MCP_GATEWAY || typeof env.MCP_GATEWAY.fetch !== "function") throw new Error("DroidIME gateway service is not configured");
  const headers = { "content-type": "application/json", origin: "null" };
  if (protocol) headers["MCP-Protocol-Version"] = "2025-11-25";
  const response = await env.MCP_GATEWAY.fetch(new Request(
    `https://mcp.aixodia.dpdns.org/${device}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    },
  ));
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message || `Device returned HTTP ${response.status}`);
  if (value?.error) throw new Error(value.error.message || "MCP request failed");
  return value?.result ?? null;
}
async function probeDevice(env, name) {
  const cached = deviceStatusCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const checkedAt = new Date().toISOString();
  try {
    const result = await mcpRequest(env, name, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "AIxodia Dashboard", version: "1.0" } },
    }, { timeoutMs: 4000 });
    const value = {
      online: result?.serverInfo?.name === "Droid-MCP",
      checkedAt,
      reason: result?.serverInfo?.name === "Droid-MCP" ? null : "Unexpected MCP endpoint",
      version: result?.serverInfo?.version ?? null,
      latencyMs: null,
    };
    deviceStatusCache.set(name, { value, expiresAt: Date.now() + DEVICE_STATUS_TTL_MS });
    return value;
  } catch (cause) {
    const value = {
      online: false,
      checkedAt,
      reason: cause instanceof Error ? cause.message : "Device is unreachable",
      version: null,
      latencyMs: null,
    };
    deviceStatusCache.set(name, { value, expiresAt: Date.now() + DEVICE_STATUS_TTL_MS });
    return value;
  }
}
async function listDeviceNames(env) {
  if (!env.DEVICE_TUNNELS) throw new Error("DroidIME device registry is not configured");
  const cached = deviceRegistryCache.get(env.DEVICE_TUNNELS);
  if (cached && cached.expiresAt > Date.now()) return cached.names;
  const names = [];
  let cursor;
  do {
    const page = await env.DEVICE_TUNNELS.list({ limit: 1000, cursor });
    for (const item of page.keys || []) if (validDevice(item.name)) names.push(item.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const uniqueNames = [...new Set(names)].sort();
  deviceRegistryCache.set(env.DEVICE_TUNNELS, { names: uniqueNames, expiresAt: Date.now() + DEVICE_REGISTRY_TTL_MS });
  return uniqueNames;
}
export async function listDevices(env, { refresh = false } = {}) {
  try {
    const names = await listDeviceNames(env);
    // Refresh means re-probe live device state; the registered-device list remains cached.
    if (refresh) for (const name of names) deviceStatusCache.delete(name);
    const items = [];
    for (let index = 0; index < names.length; index += 8) {
      const chunk = names.slice(index, index + 8);
      const statuses = await Promise.all(chunk.map(name => probeDevice(env, name)));
      for (let i = 0; i < chunk.length; i++) {
        items.push({ id: chunk[i], name: chunk[i], host: `https://mcp.aixodia.dpdns.org/${chunk[i]}`, status: statuses[i] });
      }
    }
    return json({ items, checkedAt: new Date().toISOString(), ephemeral: true });
  } catch (cause) {
    return error(503, cause instanceof Error ? cause.message : "Unable to list devices", "DEVICE_REGISTRY_UNAVAILABLE");
  }
}
export async function getDeviceTools(env, name) {
  try {
    const result = await mcpRequest(env, name, {
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    }, { protocol: true });
    return json({ tools: Array.isArray(result?.tools) ? result.tools : [] });
  } catch (cause) {
    return error(502, cause instanceof Error ? cause.message : "Unable to read device tools", "DEVICE_UNAVAILABLE");
  }
}
export async function callDeviceTool(env, name, tool, args = {}) {
  if (!DEVICE_TOOLS.has(tool)) return error(400, "Tool is not allowed", "INVALID_TOOL");
  if (!args || typeof args !== "object" || Array.isArray(args)) return error(400, "Arguments must be an object", "INVALID_ARGUMENTS");
  let mcpTool = tool;
  let mcpArgs = args;
  if (tool !== "screenshot" && tool !== "screen_size" && tool !== "ui_hierarchy" && tool !== "act_and_observe") {
    mcpTool = "act_and_observe";
    mcpArgs = { action: { name: tool, ...args }, settle_ms: 500, include_image: true };
  }
  try {
    const result = await mcpRequest(env, name, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: mcpTool, arguments: mcpArgs },
    }, { protocol: true, timeoutMs: 20_000 });
    const content = Array.isArray(result?.content) ? result.content : [];
    const image = content.find(item => item.type === "image" && typeof item.data === "string");
    const text = content.filter(item => item.type === "text").map(item => item.text || "").join("\n");
    return json({
      ok: !result?.isError,
      device: name,
      tool,
      text,
      screenshot: image ? { mimeType: image.mimeType || "image/png", data: image.data } : null,
      at: new Date().toISOString(),
    }, result?.isError ? 502 : 200);
  } catch (cause) {
    return error(502, cause instanceof Error ? cause.message : "Device action failed", "DEVICE_ACTION_FAILED");
  }
}
