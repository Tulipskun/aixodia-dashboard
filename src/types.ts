// Types for the DroidIME Device Console (no GitHub dashboard concepts remain).

export interface ConsoleInfo {
  name: string
  subtitle: string
  tagline: string
  owner: string
}

export interface DeviceStatus {
  online: boolean
  latencyMs: number | null
  checkedAt: string
  reason: string | null
  detail?: string | null
  device?: string
  platform?: string
}

export interface Device {
  id: string
  name: string
  subtitle: string
  tag: string
  accent: string
  host: string
  status?: DeviceStatus
}

export interface Preset {
  id: string
  label: string
  tool: string
  arguments: Record<string, unknown>
  hint?: string
}

export type ToolFieldKind = 'percent' | 'int' | 'text' | 'points' | 'pointers' | 'keycodes'

export interface ToolField {
  key: string
  label: string
  kind: ToolFieldKind
  required: boolean
  default?: string | number
  placeholder?: string
  hint?: string
  min?: number
  max?: number
  maxLength?: number
}

export interface ToolDescriptor {
  name: string
  label: string
  description: string
  group: string
  fields: ToolField[]
}

export interface Screenshot {
  mimeType: string
  data: string
}

export interface ActionResult {
  ok: boolean
  device: string
  tool: string
  arguments: Record<string, unknown>
  text: string
  screenshot: Screenshot | null
  durationMs: number
  at: string
  requestId: string
  platform?: string
}

export interface Session {
  authenticated: boolean
  username: string | null
  expiresAt: string | null
  platform: string
}

export interface Health {
  ok: boolean
  platform: string
  authConfigured: boolean
  mcpConfigured: boolean
  mcpBaseUrl: string
  protocolVersion: string
  deviceCount: number
  consoleName: string
  time: string
}

export interface ConsoleConfig {
  console: ConsoleInfo
  devices: Device[]
  presets: Preset[]
  protocolVersion?: string
  platform?: string
}

export interface CommandLogEntry {
  id: string
  at: string
  tool: string
  device: string
  ok: boolean
  durationMs: number | null
  hasScreenshot: boolean
  arguments?: Record<string, unknown>
  error?: { code: string; message: string } | null
}

export interface ApiErrorBody {
  error: string
  code: string
  requestId?: string
  reason?: string | null
  detail?: string | null
  checkedAt?: string
  retryAfter?: number
}

export interface ToolsResponse {
  tools: ToolDescriptor[]
  source: 'catalog' | 'device'
  deviceTools: Array<{ name: string; description: string; inputSchema: unknown }> | null
  protocolVersion: string
  note: string
}

export interface DevicesResponse {
  items: Device[]
  checkedAt: string
  ephemeral: boolean
}

export interface CommandsResponse {
  items: CommandLogEntry[]
  cap: number
  ephemeral: boolean
}

export interface LoginResult {
  ok: boolean
  username: string
  expiresAt: string
  platform: string
}
