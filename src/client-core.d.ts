// Type declarations for client-core.js. TypeScript resolves the
// `./client-core.js` import from api.ts to this file; the runtime
// implementation lives in client-core.js (bundled by Vite, imported by Node
// tests), so no allowJs / type-stripping is required in the toolchain.

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

export interface McpErrorPayload {
  status: number
  code: string
  error: string
}

export const DEFAULT_ENGINE_URL: string
export function resolveEngineUrl(value: unknown): string
export function bearerValue(token: string): string
export function isExpired(expiresAtSeconds: unknown, nowMs?: number): boolean
export function enginePath(legacyPath: string): string
export function mcpGatewayError(feature: string): McpErrorPayload
export function sessionFromStored(stored: StoredSession | null, nowMs?: number): ClientSession
