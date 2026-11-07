import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Activity, Camera, Terminal, Zap } from 'lucide-react'

import * as api from './api'
import { ApiError } from './api'
import { useCommandLog, usePolling } from './hooks'
import type {
  ActionResult,
  CommandLogEntry,
  ConsoleConfig,
  DeviceStatus,
  Health,
  Screenshot,
  Session,
  ToolDescriptor,
} from './types'
import {
  Boot,
  CommandLog,
  ErrorBanner,
  Footer,
  LoginPage,
  OfflineState,
  Panel,
  PresetBar,
  ScreenView,
  Sidebar,
  Skeleton,
  StatusBadge,
  ToolForm,
  Topbar,
} from './components'

type Phase = 'boot' | 'login' | 'console'

function newRequestId(): string {
  try {
    return crypto.randomUUID().slice(0, 8)
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot')
  const [session, setSession] = useState<Session | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [config, setConfig] = useState<ConsoleConfig | null>(null)
  const [tools, setTools] = useState<ToolDescriptor[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  const { entries, push, clear } = useCommandLog()
  const device = config?.devices.find((d) => d.id === activeId) || null
  const online = Boolean(status?.online)
  const controlsDisabled = !online || busy

  // Any 401 from a protected route drops us back to the login screen.
  useEffect(() => {
    api.setUnauthorizedHandler(() => {
      setPhase('login')
      setSession(null)
      setScreenshot(null)
      setStatus(null)
      setConfig(null)
    })
    return () => api.setUnauthorizedHandler(null)
  }, [])

  const refreshStatus = useCallback(
    async (force = false) => {
      if (!activeId) return
      setChecking(true)
      try {
        setStatus(await api.getDeviceStatus(activeId, force))
      } catch {
        /* 401 handled globally; transient errors keep the last known status */
      } finally {
        setChecking(false)
      }
    },
    [activeId],
  )

  usePolling(() => refreshStatus(false), 20_000, phase === 'console' && Boolean(activeId))

  const loadConsole = useCallback(async () => {
    try {
      const [cfg, toolsRes] = await Promise.all([api.getConfig(), api.getTools()])
      setConfig(cfg)
      setTools(toolsRes.tools)
      const id = cfg.devices[0]?.id || null
      setActiveId(id)
      if (id) setStatus(await api.getDeviceStatus(id))
      setPhase('console')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('console')
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authError = params.get('auth_error')
    if (authError) {
      const messages: Record<string, string> = {
        access_denied: 'คุณยกเลิกการอนุญาตจาก GitHub',
        not_allowed: 'บัญชี GitHub นี้ไม่ได้รับอนุญาตให้เข้าใช้งาน',
        oauth_failed: 'GitHub authentication ไม่สำเร็จ กรุณาลองใหม่',
      }
      setLoginError(messages[authError] || 'ไม่สามารถเข้าสู่ระบบด้วย GitHub ได้')
      window.history.replaceState({}, '', window.location.pathname)
    }
    let alive = true
    void (async () => {
      try {
        const [s, h] = await Promise.all([api.getSession(), api.getHealth()])
        if (!alive) return
        setSession(s)
        setHealth(h)
        if (s.authenticated) await loadConsole()
        else setPhase('login')
      } catch {
        if (alive) setPhase('login')
      }
    })()
    return () => { alive = false }
  }, [loadConsole])

  const handleGithubLogin = () => {
    setLoginBusy(true)
    setLoginError(null)
    window.location.assign('/api/auth/github')
  }

  const handleLogout = async () => {
    try { await api.logout() } catch { /* still clear local state */ }
    setSession(null)
    setConfig(null)
    setStatus(null)
    setScreenshot(null)
    setTools([])
    setError(null)
    setPhase('login')
  }

  const runAction = useCallback(
    async (tool: string, args: Record<string, unknown>) => {
      if (!activeId || busy) return
      const requestId = newRequestId()
      setBusy(true)
      setError(null)

      let result: ActionResult
      try {
        result = await api.postAction(activeId, tool, args, requestId)
      } catch (raw) {
        const err = raw instanceof ApiError
          ? raw
          : new ApiError(0, { error: String(raw), code: 'UNKNOWN' })
        const isOffline = ['DEVICE_OFFLINE', 'DEVICE_TIMEOUT', 'MCP_RPC_ERROR', 'MCP_TOOL_ERROR'].includes(err.code)

        push({
          id: requestId,
          at: new Date().toISOString(),
          tool,
          device: activeId,
          ok: false,
          durationMs: null,
          hasScreenshot: false,
          arguments: args,
          error: { code: err.code, message: err.message },
        })

        if (isOffline) {
          // NOT an error banner: the OfflineState card explains the situation.
          setStatus({
            online: false,
            latencyMs: null,
            checkedAt: new Date().toISOString(),
            reason: err.code === 'DEVICE_TIMEOUT' ? 'timeout' : 'offline',
            detail: err.body?.detail || null,
          })
        } else {
          setError(err.message)
        }
        setBusy(false)
        return
      }

      if (result.screenshot) setScreenshot(result.screenshot)
      setStatus((prev) => ({
        online: true,
        latencyMs: result.durationMs,
        checkedAt: result.at,
        reason: null,
        detail: prev?.detail || null,
      }))
      push({
        id: requestId,
        at: result.at,
        tool: result.tool,
        device: activeId,
        ok: true,
        durationMs: result.durationMs,
        hasScreenshot: Boolean(result.screenshot),
        arguments: args,
        error: null,
      })
      setBusy(false)
    },
    [activeId, busy, push],
  )

  const handleScreenTap = (x: string, y: string) => void runAction('tap', { x, y })
  const handleRefreshScreen = () => void runAction('screenshot', {})
  const handleReplay = (entry: CommandLogEntry) =>
    void runAction(entry.tool, entry.arguments || {})

  if (phase === 'boot') return <Boot />
  if (phase === 'login') {
    return (
      <LoginPage
        info={config?.console || null}
        onGithubLogin={handleGithubLogin}
        busy={loginBusy}
        error={loginError}
        health={health}
      />
    )
  }

  return (
    <div className="shell" style={{ '--accent': device?.accent || '#8b7cff' } as CSSProperties}>
      <Sidebar
        info={config?.console || null}
        devices={config?.devices || []}
        activeId={activeId}
        onSelect={(id) => { setActiveId(id); setScreenshot(null) }}
        status={status}
        commandCount={entries.length}
        username={session?.username || null}
        onLogout={handleLogout}
        health={health}
      />

      <main className="main">
        <Topbar
          device={device}
          status={status}
          checking={checking}
          busy={busy}
          onRefresh={handleRefreshScreen}
          onRetry={() => void refreshStatus(true)}
          username={session?.username || null}
          onLogout={handleLogout}
        />

        <div className="content">
          {error && <ErrorBanner message={error} onClose={() => setError(null)} />}

          {status === null ? (
            <div className="status-loading"><Skeleton rows={1} /></div>
          ) : !status.online ? (
            <OfflineState status={status} onRetry={() => void refreshStatus(true)} checking={checking} />
          ) : null}

          <div className="console-grid">
            <Panel
              className="screen-panel"
              title="ภาพหน้าจอ"
              subtitle="คลิกบนภาพเพื่อแตะตามตำแหน่งเปอร์เซ็นต์"
              icon={<Camera size={16} />}
              actions={<StatusBadge status={status} checking={checking} />}
            >
              <ScreenView
                screenshot={screenshot}
                busy={busy}
                disabled={!online}
                onTap={handleScreenTap}
                onCapture={handleRefreshScreen}
              />
            </Panel>

            <div className="right-col">
              <Panel title="คำสั่งด่วน" subtitle="ปุ่มมาตรฐานของ Android" icon={<Zap size={16} />}>
                <PresetBar
                  presets={config?.presets || []}
                  onRun={(tool, args) => void runAction(tool, args)}
                  busy={busy}
                  disabled={controlsDisabled}
                />
              </Panel>

              <Panel
                title="ส่งคำสั่ง"
                subtitle={`${tools.length} tools · ตรวจสอบ argument ก่อนส่ง`}
                icon={<Terminal size={16} />}
              >
                {tools.length ? (
                  <ToolForm
                    tools={tools}
                    onSubmit={(tool, args) => void runAction(tool, args)}
                    busy={busy}
                    disabled={controlsDisabled}
                  />
                ) : (
                  <Skeleton rows={4} />
                )}
              </Panel>
            </div>
          </div>

          <Panel
            title="ประวัติคำสั่ง"
            subtitle="เก็บในเบราว์เซอร์ · ไม่บันทึกภาพหน้าจอ"
            icon={<Activity size={16} />}
          >
            <CommandLog
              entries={entries}
              onClear={clear}
              onReplay={handleReplay}
              disabled={controlsDisabled}
            />
          </Panel>
        </div>

        <Footer health={health} />
      </main>
    </div>
  )
}
