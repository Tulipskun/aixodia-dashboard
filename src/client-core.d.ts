// Type declarations for the plain-JS client core. These mirror client-core.js
// exactly; keep them in sync when the implementation changes.

/** Default engine origin: the Cloudflare Access-protected hostname. */
export const DEFAULT_ENGINE_URL: string

/** Resolve a configured engine URL, falling back to the default. */
export function resolveEngineUrl(value: unknown): string

/** True when a unix-seconds expiry is at/before now, or is not a finite number. */
export function isExpired(expiresAtSeconds: unknown, nowMs?: number): boolean

/** Map the historical client-facing /api/* paths to the engine's direct paths. */
export function enginePath(legacyPath: string): string

export const DEVICE_PATHS: {
  list: string
  tools: (id: string) => string
  action: (id: string) => string
}

export interface EngineCallResult {
  ok: boolean
  status: number
  data: unknown
  error?: string
  code?: string
}

/**
 * One engine call. Requests carry the browser's Cloudflare Access cookie, so
 * no Authorization header is built here.
 */
export function engineCall(
  fetchFn: typeof fetch,
  baseUrl: string,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<EngineCallResult>

export interface ClientDevice {
  id: string
  name: string
  host: string
  subtitle?: string
  tag?: string
  accent?: string
  status: {
    online: boolean
    latencyMs: number | null
    checkedAt: string
    reason: string | null
    version: string | null
  }
}

export interface DevicesResult {
  items: ClientDevice[]
  checkedAt: string
  ephemeral: boolean
  note: string | null
}

export function normalizeDevice(raw: unknown): ClientDevice
export function normalizeDevices(data: unknown): DevicesResult
export function normalizeDeviceTools(data: unknown): {
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]
}
export function normalizeDeviceAction(
  data: unknown,
  id: string,
  tool: string,
): {
  ok: boolean
  device: string
  tool: string
  text: string
  screenshot: { mimeType: string; data: string } | null
  at: string
}
