import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  Github,
  Hand,
  Keyboard,
  LayoutGrid,
  Loader2,
  LogOut,
  MousePointer2,
  Move,
  Play,
  RefreshCw,
  ScanLine,
  Send,
  ShieldCheck,
  Smartphone,
  Terminal,
  Trash2,
  Type,
  Wifi,
  WifiOff,
  XCircle,
  Zap,
} from 'lucide-react'
import type {
  CommandLogEntry,
  ConsoleInfo,
  Device,
  DeviceStatus,
  Health,
  Preset,
  Screenshot,
  ToolDescriptor,
  ToolField,
} from './types'

// ---------------------------------------------------------------- helpers

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function relTime(iso?: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return '—'
  if (diff < 5_000) return 'เมื่อกี้'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} วิที่แล้ว`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} นาทีที่แล้ว`
  return fmtTime(iso)
}

const TOOL_ICONS: Record<string, ReactNode> = {
  tap: <MousePointer2 size={15} />,
  long_press: <Hand size={15} />,
  swipe: <Move size={15} />,
  gesture: <ScanLine size={15} />,
  multi_touch: <CircleDot size={15} />,
  key_event: <Keyboard size={15} />,
  input_text: <Type size={15} />,
  screenshot: <Camera size={15} />,
}

const PRESET_ICONS: Record<string, ReactNode> = {
  home: <LayoutGrid size={15} />,
  back: <ArrowLeft size={15} />,
  recents: <LayoutGrid size={15} />,
  enter: <Send size={15} />,
  screen: <Camera size={15} />,
}

export function toolIcon(name: string): ReactNode {
  return TOOL_ICONS[name] || <Zap size={15} />
}

// ---------------------------------------------------------------- primitives

export function Panel({
  title,
  subtitle,
  icon,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: string
  subtitle?: string
  icon?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="panel-head-left">
            {icon && <span className="panel-icon">{icon}</span>}
            <div>
              {title && <h2 className="panel-title">{title}</h2>}
              {subtitle && <p className="panel-sub">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={`panel-body ${bodyClassName}`}>{children}</div>
    </section>
  )
}

export function Chip({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'bad' | 'warn' | 'info' }) {
  return <span className={`chip chip--${tone}`}>{children}</span>
}

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  )
}

export function ErrorBanner({ message, onClose }: { message: string; onClose?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <AlertTriangle size={16} />
      <span>{message}</span>
      {onClose && (
        <button className="icon-btn" onClick={onClose} aria-label="ปิด">×</button>
      )}
    </div>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-wrap">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skeleton" key={i} style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  )
}

export function Boot({ label = 'กำลังเชื่อมต่อ console…' }: { label?: string }) {
  return (
    <div className="boot">
      <div className="boot-mark"><Smartphone size={26} /></div>
      <div className="boot-spinner" />
      <p className="boot-label">{label}</p>
    </div>
  )
}

// ---------------------------------------------------------------- status

export function StatusBadge({ status, checking }: { status: DeviceStatus | null; checking?: boolean }) {
  if (checking || !status) {
    return (
      <span className="status-badge status-badge--pending">
        <Loader2 size={13} className="spin" /> กำลังตรวจสอบ
      </span>
    )
  }
  if (status.online) {
    return (
      <span className="status-badge status-badge--online">
        <span className="status-dot" /> ONLINE{status.latencyMs !== null ? ` · ${status.latencyMs}ms` : ''}
      </span>
    )
  }
  return (
    <span className="status-badge status-badge--offline">
      <WifiOff size={13} /> OFFLINE
    </span>
  )
}

export function OfflineState({
  status,
  onRetry,
  checking,
}: {
  status: DeviceStatus | null
  onRetry: () => void
  checking?: boolean
}) {
  const reason =
    status?.reason === 'timeout' ? 'อุปกรณ์ไม่ตอบสนองภายในเวลาที่กำหนด (timeout)'
    : status?.reason === 'offline' ? 'ไม่พบ MCP server กำลังทำงานบนอุปกรณ์'
    : status?.reason ? `เหตุผล: ${status.reason}`
    : 'ยังไม่ได้ตรวจสอบสถานะ'

  return (
    <div className="offline-card">
      <div className="offline-icon"><WifiOff size={22} /></div>
      <div className="offline-copy">
        <h3>อุปกรณ์ออฟไลน์</h3>
        <p>{reason}</p>
        <p className="offline-meta">
          ตรวจล่าสุด {fmtTime(status?.checkedAt)} · console และ API พร้อมใช้งานแล้ว รอให้เปิด MCP server บนเครื่อง
        </p>
      </div>
      <button className="btn btn--ghost" onClick={onRetry} disabled={checking}>
        <RefreshCw size={14} className={checking ? 'spin' : ''} /> ลองใหม่
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- login

export function LoginPage({
  onGithubLogin,
  busy,
  error,
  health,
}: {
  onGithubLogin: () => void
  busy: boolean
  error: string | null
  health: Health | null
}) {
  return (
    <main className="ax-login-page">
      <div className="ax-login-ambient" aria-hidden="true" />
      <header className="ax-login-header">
        <a className="ax-login-wordmark" href="/" aria-label="AIxodia">
          <svg className="ax-login-logo" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <circle cx="20" cy="20" r="14.5" stroke="currentColor" strokeOpacity=".42" />
            <circle cx="20" cy="20" r="8.5" stroke="currentColor" strokeOpacity=".7" />
            <path d="M20 2.5v8M20 29.5v8M2.5 20h8M29.5 20h8M7.6 7.6l5.7 5.7m13.4 13.4 5.7 5.7m0-24.8-5.7 5.7m-13.4 13.4-5.7 5.7" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="20" cy="20" r="3.5" fill="currentColor" />
            <circle cx="20" cy="5.5" r="2" fill="#28c9f5" />
            <circle cx="34.5" cy="20" r="2" fill="#8b65ff" />
            <circle cx="8" cy="10" r="1.7" fill="#8b65ff" />
          </svg>
          <span>AI<span className="ax-login-wordmark-light">XODIA</span></span>
        </a>
      </header>

      <div className="ax-login-layout">
        <section className="ax-login-story" aria-labelledby="ax-login-headline">
          <div className="ax-orbit-scene" aria-hidden="true">
            <div className="ax-orbit-grid" />
            <div className="ax-orbit-halo" />
            <div className="ax-orbit-ring ax-orbit-ring-one" />
            <div className="ax-orbit-ring ax-orbit-ring-two" />
            <div className="ax-orbit-ring ax-orbit-ring-three" />
            <svg className="ax-orbit-lines" viewBox="0 0 420 320" fill="none">
              <path d="M210 160 132 106 92 174 210 160 292 93 330 177 210 160 276 242 132 106" />
              <path d="M132 106 180 48 210 160 276 242 330 177" />
              <path d="M92 174 180 48 292 93 276 242" />
              <circle cx="132" cy="106" r="4" /><circle cx="92" cy="174" r="3" />
              <circle cx="292" cy="93" r="4" /><circle cx="330" cy="177" r="3" />
              <circle cx="276" cy="242" r="4" /><circle cx="180" cy="48" r="3" />
            </svg>
            <div className="ax-orbit-core"><span /><i /><b /></div>
          </div>
        </section>

        <section className="ax-login-panel" aria-labelledby="ax-login-title">
          <h2 id="ax-login-title">เข้าสู่ระบบ</h2>

          {error && <div className="ax-login-error"><ErrorBanner message={error} /></div>}

          <button
            className="ax-github-button"
            type="button"
            onClick={onGithubLogin}
            disabled={busy || !health?.authConfigured}
          >
            {busy ? <Loader2 size={19} className="spin" /> : <Github size={19} />}
            <span>{busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบด้วย GitHub'}</span>
          </button>
        </section>
      </div>
    </main>
  )
}

// ---------------------------------------------------------------- shell

export function Sidebar({
  info,
  devices,
  activeId,
  onSelect,
  status,
  commandCount,
  username,
  onLogout,
  health,
}: {
  info: ConsoleInfo | null
  devices: Device[]
  activeId: string | null
  onSelect: (id: string) => void
  status: DeviceStatus | null
  commandCount: number
  username: string | null
  onLogout: () => void
  health: Health | null
}) {
  const online = status?.online ? 1 : 0
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Smartphone size={20} /></div>
        <div className="brand-copy">
          <strong>{info?.name || 'AIxodia Console'}</strong>
          <span>{info?.tagline || 'Device control · DroidIME MCP'}</span>
        </div>
      </div>

      <div className="side-section">
        <p className="side-label">DEVICES</p>
        <div className="device-list">
          {devices.map((d) => (
            <button
              key={d.id}
              className={`device-item ${d.id === activeId ? 'is-active' : ''}`}
              onClick={() => onSelect(d.id)}
              style={{ '--device-accent': d.accent } as CSSProperties}
            >
              <span className="device-item-icon"><Smartphone size={16} /></span>
              <span className="device-item-copy">
                <strong>{d.name}</strong>
                <em>{d.subtitle}</em>
              </span>
              <span className={`device-item-led ${d.id === activeId && status?.online ? 'is-online' : ''}`} />
            </button>
          ))}
        </div>
      </div>

      <div className="side-section side-stats">
        <p className="side-label">SESSION</p>
        <div className="mini-stats">
          <div className="mini-stat">
            <span className="mini-stat-label">ONLINE</span>
            <strong className={online ? 'is-ok' : 'is-bad'}>{online}<small>/{devices.length}</small></strong>
          </div>
          <div className="mini-stat">
            <span className="mini-stat-label">DEVICES</span>
            <strong>{devices.length}</strong>
          </div>
          <div className="mini-stat">
            <span className="mini-stat-label">COMMANDS</span>
            <strong>{commandCount}</strong>
          </div>
        </div>
      </div>

      <div className="side-bottom">
        <div className="side-meta">
          <span><Activity size={12} /> {health?.protocolVersion || '2025-11-25'}</span>
          <span>{health?.platform || 'cloudflare'}</span>
        </div>
        <div className="side-user">
          <div className="avatar">{(username || '?').slice(0, 1).toUpperCase()}</div>
          <div className="side-user-copy">
            <strong>{username || 'guest'}</strong>
            <em>signed in</em>
          </div>
          <button className="icon-btn" onClick={onLogout} title="ออกจากระบบ" aria-label="ออกจากระบบ">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}

export function UserMenu({ username, onLogout }: { username: string | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="user-menu">
      <button className="user-menu-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="avatar avatar--sm">{(username || '?').slice(0, 1).toUpperCase()}</span>
        <span>{username || 'guest'}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="user-menu-pop">
          <p>เซสชันของ {username}</p>
          <button onClick={onLogout}><LogOut size={14} /> ออกจากระบบ</button>
        </div>
      )}
    </div>
  )
}

export function Topbar({
  device,
  status,
  checking,
  busy,
  onRefresh,
  onRetry,
  username,
  onLogout,
}: {
  device: Device | null
  status: DeviceStatus | null
  checking: boolean
  busy: boolean
  onRefresh: () => void
  onRetry: () => void
  username: string | null
  onLogout: () => void
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="crumb"><span>CONSOLE</span><b>/</b><strong>{device?.name || '—'}</strong></div>
        <StatusBadge status={status} checking={checking} />
      </div>
      <div className="topbar-right">
        <button className="btn btn--ghost" onClick={onRetry} disabled={checking} title="ตรวจสอบสถานะใหม่">
          <RefreshCw size={14} className={checking ? 'spin' : ''} />
        </button>
        <button className="btn btn--primary" onClick={onRefresh} disabled={busy || !status?.online}>
          <Camera size={15} /> ถ่ายภาพหน้าจอ
        </button>
        <UserMenu username={username} onLogout={onLogout} />
      </div>
    </header>
  )
}

export function Footer({ health }: { health: Health | null }) {
  return (
    <footer className="footer">
      <span><ShieldCheck size={13} /> ทุกคำสั่งผ่าน signed session · ไม่มี token อยู่ในเบราว์เซอร์</span>
      <span>{health?.protocolVersion || 'MCP 2025-11-25'} · {health?.platform || 'cloudflare'}</span>
    </footer>
  )
}

// ---------------------------------------------------------------- tools

function buildArgs(tool: ToolDescriptor, values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const f of tool.fields) {
    const raw = values[f.key]
    if (raw === undefined || raw === '') continue
    if (f.kind === 'int') args[f.key] = Number(raw)
    else args[f.key] = raw
  }
  return args
}

function fieldInput(
  f: ToolField,
  value: string,
  onChange: (v: string) => void,
  disabled: boolean,
) {
  const common = {
    id: `f-${f.key}`,
    className: 'input',
    value,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    disabled,
    placeholder: f.placeholder || '',
    required: f.required,
  }
  if (f.kind === 'points' || f.kind === 'pointers') {
    return <textarea {...common} className="input textarea" rows={4} spellCheck={false} />
  }
  if (f.kind === 'text' && (f.maxLength || 0) > 200) {
    return <textarea {...common} className="input textarea" rows={2} maxLength={f.maxLength} />
  }
  return (
    <input
      {...common}
      type={f.kind === 'int' ? 'number' : 'text'}
      min={f.kind === 'int' ? f.min : undefined}
      max={f.kind === 'int' ? f.max : undefined}
      maxLength={f.maxLength}
    />
  )
}

export function ToolForm({
  tools,
  onSubmit,
  busy,
  disabled,
}: {
  tools: ToolDescriptor[]
  onSubmit: (tool: string, args: Record<string, unknown>) => void
  busy: boolean
  disabled: boolean
}) {
  const [activeName, setActiveName] = useState(tools[0]?.name || 'tap')
  const [values, setValues] = useState<Record<string, string>>({})
  const tool = useMemo(
    () => tools.find((t) => t.name === activeName) || tools[0],
    [tools, activeName],
  )

  useEffect(() => {
    if (!tool) return
    const next: Record<string, string> = {}
    for (const f of tool.fields) next[f.key] = f.default === undefined ? '' : String(f.default)
    setValues(next)
  }, [tool])

  if (!tool) return <Empty title="ไม่พบคำสั่ง" hint="ตรวจสอบ /api/tools" />

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!busy && !disabled) onSubmit(tool.name, buildArgs(tool, values))
  }

  const groups = ['touch', 'keys', 'advanced']
  const grouped = groups
    .map((g) => ({ g, items: tools.filter((t) => t.group === g) }))
    .filter((x) => x.items.length)

  return (
    <form className="tool-form" onSubmit={submit}>
      {grouped.map(({ g, items }) => (
        <div className="tool-group" key={g}>
          <p className="tool-group-label">
            {g === 'touch' ? 'TOUCH' : g === 'keys' ? 'KEYS & TEXT' : 'ADVANCED'}
          </p>
          <div className="tool-tabs">
            {items.map((t) => (
              <button
                type="button"
                key={t.name}
                className={`tool-tab ${t.name === tool.name ? 'is-active' : ''}`}
                onClick={() => setActiveName(t.name)}
                title={t.description}
              >
                {toolIcon(t.name)}<span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="tool-desc">{tool.description}</div>

      <div className="tool-fields">
        {tool.fields.map((f) => (
          <div className={`tool-field tool-field--${f.kind}`} key={f.key}>
            <label className="field-label" htmlFor={`f-${f.key}`}>
              {f.label}{f.required && <em className="req">*</em>}
            </label>
            {fieldInput(f, values[f.key] ?? '', (v) => setValues((p) => ({ ...p, [f.key]: v })), disabled || busy)}
            {f.hint && <p className="field-hint">{f.hint}</p>}
          </div>
        ))}
        {tool.fields.length === 0 && (
          <p className="tool-noargs">คำสั่งนี้ไม่ต้องระบุพารามิเตอร์</p>
        )}
      </div>

      <button className="btn btn--primary btn--block" type="submit" disabled={busy || disabled}>
        {busy ? <><Loader2 size={16} className="spin" /> กำลังส่งคำสั่ง…</> : <><Play size={15} /> ส่งคำสั่ง {tool.name}</>}
      </button>
      {disabled && <p className="tool-disabled-note">ปิดการส่งคำสั่งขณะอุปกรณ์ออฟไลน์</p>}
    </form>
  )
}

export function PresetBar({
  presets,
  onRun,
  busy,
  disabled,
}: {
  presets: Preset[]
  onRun: (tool: string, args: Record<string, unknown>) => void
  busy: boolean
  disabled: boolean
}) {
  return (
    <div className="preset-bar">
      {presets.map((p) => (
        <button
          key={p.id}
          className="preset-btn"
          title={p.hint || p.label}
          onClick={() => onRun(p.tool, p.arguments)}
          disabled={busy || disabled}
        >
          {PRESET_ICONS[p.id] || <Zap size={15} />}
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- screen

export function ScreenView({
  screenshot,
  busy,
  disabled,
  onTap,
  onCapture,
}: {
  screenshot: Screenshot | null
  busy: boolean
  disabled: boolean
  onTap: (x: string, y: string) => void
  onCapture: () => void
}) {
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const handleMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setCursor({
      x: Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)),
    })
  }

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (disabled || busy || !screenshot) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100))
    onTap(`${x.toFixed(1)}%`, `${y.toFixed(1)}%`)
  }

  const src = screenshot ? `data:${screenshot.mimeType};base64,${screenshot.data}` : null

  return (
    <div className="screen-wrap">
      <div
        className={`screen-frame ${disabled ? 'is-disabled' : ''} ${src ? 'has-image' : ''}`}
        onMouseLeave={() => setCursor(null)}
      >
        {/* The stage sizes itself to the <img>, so % coords map to the real
            picture even when the device aspect ratio differs from the frame. */}
        <div
          className="screen-stage"
          onMouseMove={handleMove}
          onClick={handleClick}
          title={src && !disabled ? 'คลิกเพื่อส่งคำสั่ง tap ตามตำแหน่ง' : undefined}
        >
        {src ? (
          <img className="screen-img" src={src} alt="หน้าจออุปกรณ์" draggable={false} />
        ) : (
          <div className="screen-placeholder">
            <ScanLine size={38} />
            <p>ยังไม่มีภาพหน้าจอ</p>
            <span>กด «ถ่ายภาพหน้าจอ» เพื่อดึงภาพจากอุปกรณ์</span>
            <button className="btn btn--ghost" onClick={(e) => { e.stopPropagation(); onCapture() }} disabled={busy || disabled}>
              <Camera size={14} /> ถ่ายภาพเดี๋ยวนี้
            </button>
          </div>
        )}

        {src && cursor && !disabled && !busy && (
          <>
            <div className="screen-crosshair screen-crosshair--x" style={{ left: `${cursor.x}%` }} />
            <div className="screen-crosshair screen-crosshair--y" style={{ top: `${cursor.y}%` }} />
            <div className="screen-readout" style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }}>
              {cursor.x.toFixed(1)}% · {cursor.y.toFixed(1)}%
            </div>
          </>
        )}

        </div>

        {busy && (
          <div className="screen-overlay">
            <Loader2 size={26} className="spin" />
            <span>กำลังรอภาพจากอุปกรณ์…</span>
          </div>
        )}
      </div>
      <p className="screen-caption">
        <MousePointer2 size={13} />
        {src ? 'คลิกบนภาพเพื่อแตะ (tap) ตามเปอร์เซ็นต์ของหน้าจอ' : 'ภาพจะแสดงที่นี่หลังส่งคำสั่งสำเร็จ'}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- log

function argsSummary(args?: Record<string, unknown>): string {
  if (!args) return ''
  const parts = Object.entries(args)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 24 ? `${v.slice(0, 24)}…` : String(v)}`)
  return parts.join('  ')
}

export function CommandLog({
  entries,
  onClear,
  onReplay,
  disabled,
}: {
  entries: CommandLogEntry[]
  onClear: () => void
  onReplay: (entry: CommandLogEntry) => void
  disabled: boolean
}) {
  return (
    <div className="log-wrap">
      <div className="log-head">
        <span><Clock size={13} /> {entries.length} รายการ · เก็บในเบราว์เซอร์</span>
        <button className="icon-btn" onClick={onClear} disabled={!entries.length} title="ล้างประวัติ" aria-label="ล้างประวัติ">
          <Trash2 size={14} />
        </button>
      </div>
      {entries.length === 0 ? (
        <Empty icon={<Terminal size={20} />} title="ยังไม่มีคำสั่ง" hint="ประวัติจะแสดงที่นี่และคงอยู่หลังรีเฟรช" />
      ) : (
        <ul className="log-list">
          {entries.map((e) => (
            <li className={`log-item ${e.ok ? 'is-ok' : 'is-bad'}`} key={`${e.id}-${e.at}`}>
              <span className="log-icon">
                {e.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              </span>
              <div className="log-copy">
                <div className="log-line">
                  <strong>{e.tool}</strong>
                  <span className="log-time">{fmtTime(e.at)}</span>
                  {e.durationMs !== null && <span className="log-dur">{e.durationMs}ms</span>}
                  {e.hasScreenshot && <Chip tone="info">ภาพจอ</Chip>}
                </div>
                <p className="log-args">{argsSummary(e.arguments) || (e.error ? e.error.message : '—')}</p>
                {e.error && <p className="log-err">{e.error.code}: {e.error.message}</p>}
              </div>
              <button
                className="icon-btn"
                onClick={() => onReplay(e)}
                disabled={disabled || !e.arguments}
                title="ส่งคำสั่งซ้ำ"
                aria-label="ส่งคำสั่งซ้ำ"
              >
                <Play size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}


