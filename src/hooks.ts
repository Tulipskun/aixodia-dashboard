import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommandLogEntry } from './types'

const STORAGE_KEY = 'axd.commandlog.v1'
const CAP = 100

function loadLog(): CommandLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CommandLogEntry[]).slice(0, CAP) : []
  } catch {
    return []
  }
}

function saveLog(entries: CommandLogEntry[]) {
  try {
    // Metadata only — NEVER persist screenshot base64.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, CAP)))
  } catch {
    /* storage full / disabled: log is best-effort */
  }
}

export function useCommandLog() {
  const [entries, setEntries] = useState<CommandLogEntry[]>(loadLog)

  const push = useCallback((entry: CommandLogEntry) => {
    setEntries((prev) => {
      const next = [entry, ...prev].slice(0, CAP)
      saveLog(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setEntries([])
    saveLog([])
  }, [])

  return { entries, push, clear }
}

/** Poll on an interval, pausing while the tab is hidden. */
export function usePolling(callback: () => void | Promise<void>, intervalMs: number, enabled = true) {
  const ref = useRef(callback)
  ref.current = callback

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return
    let cancelled = false

    const tick = async () => {
      if (cancelled || document.hidden) return
      try { await ref.current() } catch { /* keep polling */ }
    }

    void tick()
    const timer = window.setInterval(() => { void tick() }, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [intervalMs, enabled])
}
