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

// ---------------------------------------------------------------- GitHub Device Flow
export const GITHUB_DEVICE_CODE_URL: string
export const GITHUB_DEVICE_TOKEN_URL: string
export const DEVICE_FLOW_SCOPE: string
export function parseOAuth(text: string): Record<string, unknown>
export function readableGitHubError(error?: string, description?: string): string
export interface DeviceFlowError extends Error { code: string }
export function deviceFlowError(code: string, message: string): DeviceFlowError
export interface DeviceCodeInfo {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}
export function requestDeviceCode(fetchFn: typeof fetch, clientId: string, scope?: string): Promise<DeviceCodeInfo>
export interface PollDeviceFlowOptions {
  interval?: number
  expiresIn?: number
  signal?: AbortSignal
  now?: () => number
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}
export function pollDeviceFlow(
  fetchFn: typeof fetch,
  clientId: string,
  deviceCode: string,
  options?: PollDeviceFlowOptions,
): Promise<string>
