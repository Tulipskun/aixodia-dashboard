import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import {
  Activity, ArrowLeft, Bot, ChevronRight, Cpu,
  Keyboard, LoaderCircle, MessageSquare, MonitorSmartphone, Plus, Send,
  Smartphone, Square, Wifi, WifiOff, X,
} from 'lucide-react'
import * as api from './api'
import type {
  Device, DeviceActionResult, DeviceTool, EngineEvent, EngineSession,
  EngineStatus, EngineTurn,
} from './types'

type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; error?: boolean; tool?: string }
type ScreenPoint = { x: number; y: number; at: number }

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(0)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}
function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}
function parseEvents(raw: string): EngineEvent[] {
  const result: EngineEvent[] = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find(line => line.startsWith('data:'))
    if (!dataLine) continue
    try {
      const value = JSON.parse(dataLine.slice(5).trim()) as EngineEvent
      if (value && typeof value.seq === 'number' && typeof value.kind === 'string') result.push(value)
    } catch { /* Ignore incomplete event frames. */ }
  }
  return result
}
function sessionTitle(session: EngineSession): string {
  return session.title?.trim() || 'New chat'
}

export function DashboardHome({ onOpenChat, onOpenDevice }: {
  onOpenChat: () => void
  onOpenDevice: (device: Device) => void
}) {
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceError, setDeviceError] = useState('')
  const [loadingDevices, setLoadingDevices] = useState(true)

  const refreshEngine = useCallback(async () => {
    try { setEngine(await api.getEngineStatus()) }
    catch { setEngine({ configured: false, online: false, checkedAt: new Date().toISOString(), metrics: null, reason: 'Unable to reach the dashboard service' }) }
  }, [])
  const refreshDevices = useCallback(async (refresh = false) => {
    try {
      const result = await api.getDevices(refresh)
      setDevices(result.items)
      setDeviceError('')
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : 'Unable to load devices')
    } finally {
      setLoadingDevices(false)
    }
  }, [])

  useEffect(() => {
    void refreshEngine()
    void refreshDevices()
    const engineTimer = window.setInterval(() => void refreshEngine(), 5000)
    const deviceTimer = window.setInterval(() => void refreshDevices(), 10000)
    return () => { window.clearInterval(engineTimer); window.clearInterval(deviceTimer) }
  }, [refreshEngine, refreshDevices])

  const metrics = engine?.metrics
  return (
    <main className="dashboard-home" aria-label="Dashboard">
      <section className="service-card engine-card" aria-labelledby="engine-card-title">
        <div className="service-card-head">
          <div className="service-card-identity">
            <div className="service-icon engine-icon"><Bot size={22} /></div>
            <div className="service-heading">
              <p className="eyebrow">AI RUNTIME</p>
              <h1 id="engine-card-title">AIxodia Engine</h1>
              <p className="service-description">Your AI workspace, running on your connected engine.</p>
            </div>
          </div>
          <span className={`connection-state ${engine?.online ? 'is-online' : 'is-offline'}`}>
            <span className="state-dot" />{engine?.online ? 'Online' : engine ? 'Offline' : 'Checking'}
          </span>
        </div>
        <div className="engine-metrics">
          <Metric icon={<Cpu size={16} />} label="CPU" value={metrics?.cpuPercent == null ? '—' : `${metrics.cpuPercent.toFixed(1)}%`} percent={metrics?.cpuPercent ?? null} />
          <Metric icon={<Activity size={16} />} label="Memory" value={metrics?.memoryUsedBytes == null || metrics.memoryTotalBytes == null ? '—' : `${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`} percent={metrics?.memoryPercent ?? null} />
          <div className="metric-stat">
            <div className="metric-label"><Wifi size={16} /> Uptime</div>
            <strong>{engine?.online ? formatUptime(engine.uptimeSeconds) : '—'}</strong>
            <span className="metric-foot">{engine?.version || 'Engine version unavailable'}</span>
          </div>
        </div>
        {engine && !engine.online && <p className="service-warning">{engine.reason || 'Engine is not reachable.'}</p>}
        <div className="service-card-foot">
          <span className="updated-at">{engine?.online ? 'Live engine metrics' : 'Waiting for engine connection'}</span>
          <button className="action-button primary" type="button" onClick={onOpenChat} disabled={!engine?.online}>
            Open AIxodia <ChevronRight size={17} />
          </button>
        </div>
      </section>

      <section className="service-card devices-card" aria-labelledby="devices-card-title">
        <div className="service-card-head devices-card-head">
          <div className="service-card-identity">
            <div className="service-icon devices-icon"><MonitorSmartphone size={21} /></div>
            <div className="service-heading">
              <p className="eyebrow">REMOTE DEVICES</p>
              <h2 id="devices-card-title">DroidIME Devices</h2>
              <p className="service-description">Android devices registered with the DroidIME gateway.</p>
            </div>
          </div>
          <button className="icon-action" type="button" aria-label="Refresh device list" onClick={() => void refreshDevices(true)}>
            <Activity size={17} />
          </button>
        </div>
        <div className="device-list" aria-live="polite">
          {loadingDevices && devices.length === 0 ? (
            <div className="empty-service"><LoaderCircle className="spin" size={19} /><span>Discovering devices…</span></div>
          ) : deviceError ? (
            <div className="empty-service error-text"><WifiOff size={18} /><span>{deviceError}</span></div>
          ) : devices.length === 0 ? (
            <div className="empty-service"><Smartphone size={21} /><span>No DroidIME devices registered.</span></div>
          ) : devices.map(device => (
            <div className="device-row" key={device.id}>
              <div className="device-row-icon"><Smartphone size={18} /></div>
              <div className="device-row-copy">
                <strong>{device.name}</strong>
                <span className={device.status.online ? 'online-text' : 'offline-text'}>
                  <span className="state-dot" />{device.status.online ? 'Online' : 'Offline'}
                  {!device.status.online && device.status.reason ? <small> · {device.status.reason}</small> : null}
                </span>
              </div>
              <button className="action-button secondary" type="button" disabled={!device.status.online} onClick={() => onOpenDevice(device)}>
                Control <ChevronRight size={15} />
              </button>
            </div>
          ))}
        </div>
        <div className="service-card-foot">
          <span className="updated-at">{devices.length} registered {devices.length === 1 ? 'device' : 'devices'}</span>
          <span className="device-summary"><span className="state-dot is-online-dot" /> {devices.filter(device => device.status.online).length} online</span>
        </div>
      </section>
    </main>
  )
}

function Metric({ icon, label, value, percent }: {
  icon: ReactNode; label: string; value: string; percent: number | null
}) {
  return (
    <div className="metric-stat">
      <div className="metric-label">{icon}{label}</div>
      <strong>{value}</strong>
      <div className="metric-bar"><span style={{ width: percent == null ? '0%' : `${Math.max(0, Math.min(100, percent))}%` }} /></div>
    </div>
  )
}

export function EngineChat({ onBack }: { onBack: () => void }) {
  const [sessions, setSessions] = useState<EngineSession[]>([])
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [activity, setActivity] = useState('')
  const [error, setError] = useState('')
  const [railOpen, setRailOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRun = useRef('')
  const stopPolling = useRef(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const loadTurns = useCallback(async (id: string) => {
    const result = await api.getEngineTurns(id)
    setMessages(result.turns.map((turn: EngineTurn) => ({
      id: String(turn.id || turn.seq),
      role: (turn.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      text: turn.text || (turn.role === 'assistant' ? ' ' : ''),
    })).filter(message => message.text.trim()))
  }, [])

  const loadSessions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.getEngineSessions()
      const ordered = [...result.sessions].sort((a, b) => b.updated_at - a.updated_at)
      setSessions(ordered)
      if (ordered.length) {
        const next = ordered[0].id
        setSelected(next)
        await loadTurns(next)
      } else {
        const created = await api.createEngineSession()
        setSessions([created])
        setSelected(created.id)
        setMessages([])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load chat history')
    } finally {
      setLoading(false)
    }
  }, [loadTurns])

  useEffect(() => {
    void loadSessions()
    return () => { stopPolling.current = true }
  }, [loadSessions])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages, activity])

  const chooseSession = async (id: string) => {
    if (sending || id === selected) { setRailOpen(false); return }
    setSelected(id)
    setRailOpen(false)
    setError('')
    setLoading(true)
    try { await loadTurns(id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load conversation') }
    finally { setLoading(false) }
  }

  const newSession = async () => {
    if (sending) return
    setError('')
    try {
      const created = await api.createEngineSession()
      setSessions(current => [created, ...current])
      setSelected(created.id)
      setMessages([])
      setRailOpen(false)
      composerRef.current?.focus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create a new chat')
    }
  }

  const send = async () => {
    const message = draft.trim()
    if (!message || sending || !selected) return
    setDraft('')
    setError('')
    setSending(true)
    stopPolling.current = false
    const userId = `local-user-${Date.now()}`
    const assistantId = `local-assistant-${Date.now()}`
    setMessages(current => [...current, { id: userId, role: 'user', text: message }, { id: assistantId, role: 'assistant', text: '' }])
    try {
      const created = await api.startEngineRun(selected, message)
      activeRun.current = created.run.id
      let cursor = 0
      let terminal = false
      const assistantText = { value: '' }
      const startedAt = Date.now()
      while (!terminal && !stopPolling.current && Date.now() - startedAt < 15 * 60_000) {
        const raw = await api.getEngineEvents(created.run.id, cursor)
        const events = parseEvents(raw)
        for (const event of events) {
          cursor = Math.max(cursor, event.seq)
          const data = event.data || {}
          if (event.kind === 'assistant') {
            const part = typeof data.text === 'string' ? data.text : ''
            if (part) {
              assistantText.value += part
              setMessages(current => current.map(item => item.id === assistantId ? { ...item, text: assistantText.value } : item))
            }
            setActivity('')
          } else if (event.kind === 'tool') {
            const name = typeof data.name === 'string' ? data.name : 'tool'
            const stage = typeof data.stage === 'string' ? data.stage : ''
            setActivity(stage === 'tool_result' ? `Completed ${name}` : `Running ${name}…`)
          } else if (event.kind === 'reasoning') {
            setActivity('Thinking…')
          } else if (event.kind === 'final') {
            const turn = data.turn as Record<string, unknown> | undefined
            const finalText = typeof turn?.text === 'string' ? turn.text : ''
            if (!assistantText.value && finalText) {
              assistantText.value = finalText
              setMessages(current => current.map(item => item.id === assistantId ? { ...item, text: finalText } : item))
            }
          } else if (event.kind === 'error') {
            const detail = typeof data.message === 'string' ? data.message : 'The engine returned an error.'
            setError(detail)
            setMessages(current => current.map(item => item.id === assistantId ? { ...item, error: true, text: item.text || detail } : item))
          } else if (event.kind === 'status') {
            const status = typeof data.status === 'string' ? data.status : ''
            if (['done', 'failed', 'cancelled', 'interrupted'].includes(status)) terminal = true
          }
        }
        if (!events.length && !terminal && !stopPolling.current) await new Promise(resolve => window.setTimeout(resolve, 280))
      }
      if (!terminal && !stopPolling.current) setError('The run timed out while waiting for the engine.')
      try { await loadTurns(selected) } catch { /* Keep the streamed response if history is briefly delayed. */ }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'Unable to send this message'
      setError(detail)
      setMessages(current => current.map(item => item.id === assistantId ? { ...item, text: item.text || detail, error: true } : item))
    } finally {
      activeRun.current = ''
      setActivity('')
      setSending(false)
    }
  }

  const stop = async () => {
    stopPolling.current = true
    const runId = activeRun.current
    if (runId) {
      try { await api.cancelEngineRun(runId) } catch { /* The run may have ended already. */ }
    }
    setSending(false)
    setActivity('')
  }

  return (
    <section className="chat-view">
      {railOpen && <button className="chat-rail-scrim" aria-label="Close chat list" onClick={() => setRailOpen(false)} />}
      <aside className={`chat-rail ${railOpen ? 'is-open' : ''}`}>
        <div className="chat-rail-head">
          <button className="back-button" type="button" onClick={onBack}><ArrowLeft size={17} /> Dashboard</button>
          <button className="icon-action" type="button" aria-label="Close chat list" onClick={() => setRailOpen(false)}><X size={17} /></button>
        </div>
        <button className="new-chat-button" type="button" onClick={() => void newSession()}><Plus size={17} /> New chat</button>
        <div className="chat-session-list">
          {sessions.map(item => (
            <button key={item.id} type="button" className={`chat-session-item ${selected === item.id ? 'is-selected' : ''}`} onClick={() => void chooseSession(item.id)}>
              <MessageSquare size={15} />
              <span>{sessionTitle(item)}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="chat-main">
        <header className="chat-header">
          <button className="icon-action mobile-chat-menu" type="button" aria-label="Open chat list" onClick={() => setRailOpen(true)}><MessageSquare size={18} /></button>
          <div><strong>AIxodia</strong><span><span className="state-dot is-online-dot" /> Engine chat</span></div>
          <button className="back-button chat-back-desktop" type="button" onClick={onBack}>Dashboard</button>
        </header>
        <div className="chat-messages" ref={scrollRef}>
          {loading ? <div className="chat-empty"><LoaderCircle className="spin" size={22} /> Loading conversation…</div> :
            messages.length === 0 ? <div className="chat-empty"><Bot size={31} /><strong>What can I help you with?</strong><span>Messages are processed by your connected AIxodia Engine.</span></div> :
            messages.map(message => (
              <article key={message.id} className={`chat-message ${message.role === 'user' ? 'is-user' : 'is-assistant'} ${message.error ? 'has-error' : ''}`}>
                {message.role === 'assistant' && <div className="message-avatar"><Bot size={16} /></div>}
                <div className="message-content">
                  {message.text.trim() ? <p>{message.text}</p> : <span className="typing-dots"><i /><i /><i /></span>}
                </div>
              </article>
            ))
          }
          {activity && sending && <div className="chat-activity"><LoaderCircle className="spin" size={14} /> {activity}</div>}
          {error && <div className="chat-error">{error}</div>}
        </div>
        <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send() }}>
          <textarea
            ref={composerRef}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
            }}
            placeholder="Message AIxodia…"
            rows={1}
            disabled={loading || !selected}
          />
          {sending ? (
            <button className="send-button stop-button" type="button" aria-label="Stop generating" onClick={() => void stop()}><Square size={15} /></button>
          ) : (
            <button className="send-button" type="submit" aria-label="Send message" disabled={!draft.trim() || loading || !selected}><Send size={16} /></button>
          )}
        </form>
        <p className="chat-disclaimer">AIxodia Engine may make mistakes. Verify important results.</p>
      </div>
    </section>
  )
}

export function DeviceControl({ device, onBack }: { device: Device; onBack: () => void }) {
  const [image, setImage] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [tools, setTools] = useState<DeviceTool[]>([])
  const [status, setStatus] = useState('Connecting to device…')
  const [busy, setBusy] = useState(false)
  const [textInput, setTextInput] = useState('')
  const [lastError, setLastError] = useState('')
  const point = useRef<ScreenPoint | null>(null)
  const longPressFired = useRef(false)
  const longPressTimer = useRef<number | null>(null)

  const applyResult = useCallback((result: DeviceActionResult) => {
    if (result.screenshot) setImage(`data:${result.screenshot.mimeType};base64,${result.screenshot.data}`)
    if (result.text && result.text.startsWith('width=')) {
      const width = Number(result.text.match(/width=(\d+)/)?.[1] || 0)
      const height = Number(result.text.match(/height=(\d+)/)?.[1] || 0)
      if (width > 0 && height > 0) setSize({ width, height })
    }
    if (!result.ok) setLastError(result.text || 'Device action failed')
    else setLastError('')
  }, [])

  const runTool = useCallback(async (tool: string, args: Record<string, unknown> = {}) => {
    setBusy(true)
    try {
      const result = await api.callDeviceTool(device.id, tool, args)
      applyResult(result)
      return result
    } catch (cause) {
      setLastError(cause instanceof Error ? cause.message : 'Device action failed')
      return null
    } finally { setBusy(false) }
  }, [applyResult, device.id])

  useEffect(() => {
    let alive = true
    void (async () => {
      setStatus('Reading available controls…')
      try {
        const [toolPage] = await Promise.all([api.getDeviceTools(device.id)])
        if (alive) setTools(toolPage.tools)
        const screen = await api.callDeviceTool(device.id, 'screen_size')
        if (alive) applyResult(screen)
        const shot = await api.callDeviceTool(device.id, 'screenshot')
        if (alive) { applyResult(shot); setStatus('Connected') }
      } catch (cause) {
        if (alive) { setStatus('Device connection failed'); setLastError(cause instanceof Error ? cause.message : 'Unable to connect') }
      }
    })()
    return () => {
      alive = false
      if (longPressTimer.current != null) window.clearTimeout(longPressTimer.current)
    }
  }, [device.id, applyResult])

  const imagePoint = (event: PointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(size.width - 1, Math.round((event.clientX - rect.left) / rect.width * size.width))),
      y: Math.max(0, Math.min(size.height - 1, Math.round((event.clientY - rect.top) / rect.height * size.height))),
    }
  }
  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (busy || !size.width || !size.height) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const coords = imagePoint(event)
    point.current = { ...coords, at: Date.now() }
    longPressFired.current = false
    longPressTimer.current = window.setTimeout(() => {
      const start = point.current
      if (!start) return
      longPressFired.current = true
      void runTool('long_press', { x: start.x, y: start.y, duration_ms: 800 })
    }, 650)
  }
  const onPointerUp = (event: React.PointerEvent<HTMLImageElement>) => {
    const start = point.current
    if (!start) return
    if (longPressTimer.current != null) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = null
    point.current = null
    if (longPressFired.current) return
    const end = imagePoint(event)
    if (Math.hypot(end.x - start.x, end.y - start.y) < 12) {
      void runTool('tap', { x: end.x, y: end.y })
    } else {
      void runTool('swipe', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration_ms: Math.max(100, Date.now() - start.at) })
    }
  }

  const key = (code: number) => void runTool('key_event', { keycode: code })
  const sendText = async () => {
    if (!textInput.trim() || busy) return
    const text = textInput
    setTextInput('')
    await runTool('input_text', { text })
  }
  return (
    <section className="device-control-view">
      <header className="device-control-header">
        <button className="back-button" type="button" onClick={onBack}><ArrowLeft size={17} /> Devices</button>
        <div className="control-device-title"><Smartphone size={19} /><strong>{device.name}</strong><span className="connection-state is-online"><span className="state-dot" />Online</span></div>
        <span className="control-device-meta">{size.width && size.height ? `${size.width} × ${size.height}` : 'Screen'}</span>
      </header>
      <div className="device-control-body">
        <div className="remote-screen-panel">
          <div className="remote-screen-toolbar"><span><MonitorSmartphone size={15} /> Live device screen</span><span>{status}</span></div>
          <div className="remote-screen-stage">
            {image ? <img
              src={image}
              alt={`Screen of ${device.name}`}
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={() => { if (longPressTimer.current != null) window.clearTimeout(longPressTimer.current); point.current = null }}
              className={busy ? 'is-busy' : ''}
            /> : <div className="screen-loading"><LoaderCircle className="spin" size={25} /><span>Loading device screen…</span></div>}
          </div>
        </div>
        <aside className="remote-controls">
          <section className="remote-control-group">
            <h3>Navigation</h3>
            <div className="navigation-keys">
              <button type="button" onClick={() => key(4)} disabled={busy}>Back</button>
              <button type="button" onClick={() => key(3)} disabled={busy}>Home</button>
              <button type="button" onClick={() => key(187)} disabled={busy}>Recent</button>
            </div>
            <div className="navigation-keys">
              <button type="button" onClick={() => key(66)} disabled={busy}>Enter</button>
              <button type="button" onClick={() => key(67)} disabled={busy}>Delete</button>
            </div>
          </section>
          <section className="remote-control-group">
            <h3>Text input</h3>
            <div className="remote-text-entry">
              <input value={textInput} onChange={event => setTextInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void sendText() }} placeholder="Type on device…" />
              <button type="button" aria-label="Send text" onClick={() => void sendText()} disabled={!textInput.trim() || busy}><Send size={15} /></button>
            </div>
          </section>
          <section className="remote-control-group">
            <h3>Device actions</h3>
            <button className="remote-wide-button" type="button" onClick={() => void runTool('screenshot')} disabled={busy}><Activity size={15} /> Refresh screenshot</button>
            <button className="remote-wide-button" type="button" onClick={() => void runTool('ui_hierarchy')} disabled={busy}><Keyboard size={15} /> Read UI hierarchy</button>
            {lastError && <p className="remote-error">{lastError}</p>}
          </section>
          <section className="remote-control-group remote-tools-info">
            <h3>Available MCP tools</h3>
            <span>{tools.length ? tools.map(tool => tool.name).join(' · ') : 'Loading tool catalogue…'}</span>
          </section>
        </aside>
      </div>
    </section>
  )
}
