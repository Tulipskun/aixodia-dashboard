// Type declarations for client-core.js. TypeScript resolves the
// `./client-core.js` import from api.ts to this file; the runtime
// implementation lives in client-core.js (bundled by Vite, imported by Node
// tests), so no allowJs / type-stripping is required in the toolchain.

import type {
  DeviceActionResult,
  DevicesResponse,
  DeviceToolsResponse,
} from './types'

export interface StoredSession {
  token: string
  expiresAt: number
  user: string
  scope: string
}

export interface ClientSession {
  authenticated: boolean
  username: string | null
  expiresAt: string | null
}

export const DEFAULT_ENGINE_URL: string
export function resolveEngineUrl(value: unknown): string
export function bearerValue(token: string): string
export function isExpired(expiresAtSeconds: unknown, nowMs?: number): boolean
export function enginePath(legacyPath: string): string
export function sessionFromStored(stored: StoredSession | null, nowMs?: number): ClientSession

// ---------------------------------------------------------------- devices
export interface DevicePaths {
  list: string
  tools(id: string): string
  action(id: string): string
}
export const DEVICE_PATHS: DevicePaths

export interface EngineCallOptions {
  token?: string
  method?: string
  body?: unknown
}
export type EngineCallResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string; code: string; data: unknown }
export function engineCall(
  fetchFn: typeof fetch,
  baseUrl: string,
  path: string,
  options?: EngineCallOptions,
): Promise<EngineCallResult>

export function normalizeDevice(raw: unknown): DevicesResponse['items'][number]
export function normalizeDevices(data: unknown): DevicesResponse
export function normalizeDeviceTools(data: unknown): DeviceToolsResponse
export function normalizeDeviceAction(data: unknown, id: string, tool: string): DeviceActionResult
