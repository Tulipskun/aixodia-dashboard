import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { getConfig, getHealth, getOverview, getSnapshot, refreshCache } from './api'
import type { ConsoleConfig, Health, Snapshot, Summary } from './types'
import {
  Boot,
  CommitsPanel,
  ErrorBanner,
  Footer,
  Hero,
  HighlightsPanel,
  MetaPanel,
  ReleasePanel,
  RunsPanel,
  Sidebar,
  Skeleton,
  StatGrid,
  Topbar,
} from './components'

export default function App() {
  const [config, setConfig] = useState<ConsoleConfig | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [overview, setOverview] = useState<Summary[]>([])
  const [activeId, setActiveId] = useState('droidime')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [cfg, h, ov] = await Promise.allSettled([
        getConfig(),
        getHealth(),
        getOverview(),
      ])
      if (!alive) return
      if (cfg.status === 'fulfilled') setConfig(cfg.value)
      else setError(cfg.reason?.message || 'Cannot load app config')
      if (h.status === 'fulfilled') setHealth(h.value)
      if (ov.status === 'fulfilled') setOverview(ov.value.items)
    })()
    return () => { alive = false }
  }, [])

  const load = useCallback(async (id: string, silent = false) => {
    if (!silent) {
      setLoading(true)
      setSnapshot(null)
    }
    try {
      const s = await getSnapshot(id)
      setSnapshot(s)
      setLastUpdated(new Date().toISOString())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      if (!silent) setSnapshot(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (config) load(activeId)
  }, [activeId, config, load])

  useEffect(() => {
    if (!config) return
    const timer = window.setInterval(() => {
      getSnapshot(activeId)
        .then((s) => { setSnapshot(s); setLastUpdated(new Date().toISOString()); setError(null) })
        .catch((e) => setError((e as Error).message))
      getOverview().then((o) => setOverview(o.items)).catch(() => {})
      getHealth().then(setHealth).catch(() => {})
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [config, activeId])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try { await refreshCache() } catch { /* cache endpoint optional */ }
    const [snap, ov, h] = await Promise.allSettled([
      getSnapshot(activeId),
      getOverview(),
      getHealth(),
    ])
    if (snap.status === 'fulfilled') {
      setSnapshot(snap.value)
      setLastUpdated(new Date().toISOString())
      setError(null)
    } else {
      setError(snap.reason?.message || 'Refresh failed')
    }
    if (ov.status === 'fulfilled') setOverview(ov.value.items)
    if (h.status === 'fulfilled') setHealth(h.value)
    setRefreshing(false)
  }, [activeId])

  if (!config) return <Boot error={error} />

  const app = config.apps.find((a) => a.id === activeId) || config.apps[0]

  return (
    <div className="shell">
      <Sidebar
        config={config}
        activeId={activeId}
        onSelect={setActiveId}
        overview={overview}
        health={health}
        onRefresh={handleRefresh}
        refreshing={refreshing}
      />
      <main className="main" style={{ '--accent': app.accent } as CSSProperties}>
        <Topbar app={app} lastUpdated={lastUpdated} onRefresh={handleRefresh} refreshing={refreshing} />
        {error && <ErrorBanner message={error} />}
        {loading && !snapshot ? (
          <Skeleton />
        ) : snapshot ? (
          <>
            <Hero app={app} snapshot={snapshot} />
            <StatGrid snapshot={snapshot} />
            <div className="content-grid">
              <RunsPanel runs={snapshot.runs} />
              <div className="right-stack">
                <ReleasePanel release={snapshot.release} app={app} />
                <MetaPanel snapshot={snapshot} />
              </div>
            </div>
            <div className="content-grid bottom-grid">
              <CommitsPanel commits={snapshot.commits} />
              <HighlightsPanel app={app} />
            </div>
          </>
        ) : (
          <div className="fatal">Unable to load data. Try refreshing.</div>
        )}
        <Footer health={health} />
      </main>
    </div>
  )
}
