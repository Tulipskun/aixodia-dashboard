import type { ConsoleConfig, Health, Overview, Snapshot } from './types'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) message = body.error
    } catch {
      /* keep status text */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const getConfig = () => json<ConsoleConfig>('/api/apps')
export const getHealth = () => json<Health>('/api/health')
export const getOverview = () => json<Overview>('/api/overview')
export const getSnapshot = (id: string) =>
  json<Snapshot>(`/api/snapshot/${encodeURIComponent(id)}`)
export const refreshCache = () =>
  json<{ ok: boolean; cleared: boolean }>('/api/refresh', { method: 'POST' })
