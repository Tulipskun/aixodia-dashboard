import type { CSSProperties, ReactNode } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Ban,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Database,
  Download,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Github,
  Layers,
  LoaderCircle,
  Package,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  Wifi,
  XCircle,
} from 'lucide-react'
import type { AppConfig, ConsoleConfig, Health, Release, Run, Snapshot, Summary } from './types'

/* ---------------- helpers ---------------- */

export function relTime(iso?: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return '—'
  const s = Math.max(0, Math.floor(diff / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtDur(sec?: number | null): string {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

type RunKind = 'success' | 'failure' | 'cancelled' | 'running' | 'neutral'
type RunLike = Pick<Run, 'status' | 'conclusion'>

export function runMeta(r: RunLike): { kind: RunKind; label: string } {
  if (r.status !== 'completed') return { kind: 'running', label: 'running' }
  switch (r.conclusion) {
    case 'success': return { kind: 'success', label: 'passed' }
    case 'failure': return { kind: 'failure', label: 'failed' }
    case 'cancelled': return { kind: 'cancelled', label: 'cancelled' }
    default: return { kind: 'neutral', label: r.conclusion || r.status }
  }
}

function RunIcon({ kind, size = 16 }: { kind: RunKind; size?: number }) {
  const props = { size, strokeWidth: 2 }
  if (kind === 'success') return <CheckCircle2 {...props} />
  if (kind === 'failure') return <XCircle {...props} />
  if (kind === 'cancelled') return <Ban {...props} />
  if (kind === 'running') return <LoaderCircle {...props} className="spin" />
  return <CircleDot {...props} />
}

const accentStyle = (accent: string): CSSProperties => ({ '--accent': accent } as CSSProperties)

function initials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '')
  return (clean.slice(0, 2) || 'AX').toUpperCase()
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="chip">{icon}{children}</span>
}

function Panel({ title, icon, extra, children, className = '' }: {
  title: string; icon: ReactNode; extra?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <div className="panel-title">{icon}<h2>{title}</h2></div>
        {extra}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><AlertCircle size={18} /><span>{text}</span></div>
}

/* ---------------- sidebar ---------------- */

export function Sidebar({ config, activeId, onSelect, overview, health, onRefresh, refreshing }: {
  config: ConsoleConfig
  activeId: string
  onSelect: (id: string) => void
  overview: Summary[]
  health: Health | null
  onRefresh: () => void
  refreshing: boolean
}) {
  const byId = new Map(overview.map((o) => [o.id, o]))
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Boxes size={20} /></div>
        <div className="brand-text">
          <strong>{config.console.name}</strong>
          <span>{config.console.owner} / workspace</span>
        </div>
      </div>

      <div className="nav-label">APPLICATIONS <span>{config.apps.length}</span></div>
      <nav className="app-nav">
        {config.apps.map((app) => {
          const sum = byId.get(app.id)
          const kind = sum?.latestRun
            ? runMeta({ status: sum.latestRun.status, conclusion: sum.latestRun.conclusion }).kind
            : 'neutral'
          return (
            <button
              key={app.id}
              className={`app-nav-item ${app.id === activeId ? 'active' : ''}`}
              style={accentStyle(app.accent)}
              onClick={() => onSelect(app.id)}
              title={app.subtitle}
            >
              <span className="app-glyph">{initials(app.name)}</span>
              <span className="app-nav-text">
                <strong>{app.name}</strong>
                <small>{app.tag}</small>
              </span>
              <span className={`run-dot ${kind}`} title={sum?.latestRun ? `CI: ${kind}` : 'No CI data'} />
            </button>
          )
        })}
      </nav>

      <div className="side-section">
        <div className="nav-label">OVERVIEW</div>
        <div className="mini-stats">
          <div><span>Apps</span><strong>{config.apps.length}</strong></div>
          <div><span>Total stars</span><strong>{overview.reduce((n, o) => n + (o.stars || 0), 0)}</strong></div>
          <div><span>Open PRs</span><strong>{overview.reduce((n, o) => n + (o.openPulls || 0), 0)}</strong></div>
        </div>
      </div>

      <div className="side-footer">
        <div className="auth-line">
          <span className={`auth-dot ${health?.authenticated ? 'ok' : 'warn'}`} />
          <div>
            <strong>{health?.login || (health?.authenticated ? 'GitHub token' : 'Public access')}</strong>
            <small>{health ? `${health.rate?.remaining ?? '—'} / ${health.rate?.limit ?? '—'} API calls left` : 'connecting…'}</small>
          </div>
        </div>
        <button className="btn-refresh" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh data'}
        </button>
        <p className="side-note">Token stays on the server. Add apps in <code>apps.config.json</code>.</p>
      </div>
    </aside>
  )
}

/* ---------------- topbar ---------------- */

export function Topbar({ app, lastUpdated, onRefresh, refreshing }: {
  app: AppConfig
  lastUpdated: string | null
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <header className="topbar">
      <div className="crumbs">
        <span>CONSOLE</span><ChevronRight size={14} /><strong>{app.name}</strong>
        <span className="live-pill"><span className="live-dot" /> LIVE · 60s</span>
      </div>
      <div className="top-actions">
        <span className="updated">Updated {relTime(lastUpdated)}</span>
        <button className="icon-btn" onClick={onRefresh} title="Refresh" disabled={refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
        </button>
        <a className="icon-btn" href={`https://github.com/${app.repo}`} target="_blank" rel="noreferrer" title="Open repository">
          <Github size={15} />
        </a>
      </div>
    </header>
  )
}

/* ---------------- hero ---------------- */

export function Hero({ app, snapshot }: { app: AppConfig; snapshot: Snapshot }) {
  const latest = snapshot.runs[0]
  const meta = latest ? runMeta(latest) : null
  return (
    <section className="hero" style={accentStyle(app.accent)}>
      <div className="hero-main">
        <div className="eyebrow">
          <span className="hero-tag">{app.tag}</span>
          <span className="repo-path">{app.repo}</span>
        </div>
        <h1>{app.name}</h1>
        <p>{snapshot.repo.description}</p>
        <div className="chips">
          <Chip icon={<GitBranch size={13} />}>{snapshot.repo.defaultBranch}</Chip>
          <Chip icon={<Code2 size={13} />}>{snapshot.repo.language || 'mixed'}</Chip>
          <Chip icon={<ShieldCheck size={13} />}>{snapshot.repo.private ? 'Private' : 'Public'}</Chip>
          {snapshot.repo.license && <Chip icon={<ShieldCheck size={13} />}>{snapshot.repo.license}</Chip>}
          <Chip icon={<Clock3 size={13} />}>push {relTime(snapshot.repo.pushedAt)}</Chip>
        </div>
      </div>
      <div className="hero-side">
        {meta && (
          <div className={`build-status ${meta.kind}`}>
            <RunIcon kind={meta.kind} size={18} />
            <div>
              <span>LATEST CI RUN</span>
              <strong>{meta.label}</strong>
            </div>
          </div>
        )}
        <a className="btn-primary" href={snapshot.repo.url} target="_blank" rel="noreferrer">
          Open repository <ArrowUpRight size={15} />
        </a>
      </div>
    </section>
  )
}

/* ---------------- stat cards ---------------- */

export function StatGrid({ snapshot }: { snapshot: Snapshot }) {
  const { runs, release, repo, openPulls } = snapshot
  const passed = runs.filter((r) => r.conclusion === 'success').length
  const rate = runs.length ? Math.round((passed / runs.length) * 100) : null
  const asset = release?.assets?.reduce((a, b) => (b.size > (a?.size || 0) ? b : a), release.assets[0])
  const issuesOnly = Math.max(0, repo.openIssues - openPulls)

  const cards = [
    { label: 'LATEST BUILD', value: release?.versionCode ? `v${release.versionCode}` : (release?.name || 'No release'), sub: release ? `${release.name} · ${release.versionCode ? `code ${release.versionCode}` : `tag ${release.tag}`}` : '—', icon: <Package size={18} /> },
    { label: 'ARTIFACT', value: asset ? fmtBytes(asset.size) : '—', sub: asset ? `${asset.name} · ${asset.downloads} downloads` : 'no assets', icon: <Download size={18} /> },
    { label: `CI HEALTH · ${runs.length} RUNS`, value: rate != null ? `${rate}%` : '—', sub: `${passed} passed / ${runs.length} recent`, icon: <Activity size={18} /> },
    { label: 'OPEN WORK', value: `${issuesOnly + openPulls}`, sub: `${issuesOnly} issues · ${openPulls} PRs`, icon: <GitPullRequest size={18} /> },
    { label: 'LAST PUSH', value: relTime(repo.pushedAt), sub: fmtDate(repo.pushedAt), icon: <Clock3 size={18} /> },
    { label: 'COMMUNITY', value: `${repo.stars} / ${repo.forks}`, sub: 'stars / forks', icon: <Star size={18} /> },
  ]

  return (
    <div className="stat-grid">
      {cards.map((c, i) => (
        <div className="stat-card" key={c.label} style={{ animationDelay: `${i * 45}ms` }}>
          <div className="stat-top"><span>{c.label}</span>{c.icon}</div>
          <strong className="stat-value" title={c.value}>{c.value}</strong>
          <span className="stat-sub" title={c.sub}>{c.sub}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------------- CI runs ---------------- */

export function RunsPanel({ runs }: { runs: Run[] }) {
  const total = runs.length
  const success = runs.filter((r) => r.conclusion === 'success').length
  return (
    <Panel
      title="CI · Workflow runs"
      icon={<Activity size={17} />}
      extra={<span className="panel-extra">{success}/{total} passed</span>}
      className="runs-panel"
    >
      {runs.length === 0 ? <Empty text="No workflow runs found for this repository." /> : (
        <>
          <div className="run-strip" aria-hidden="true">
            {[...runs].reverse().map((r) => {
              const m = runMeta(r)
              return <span key={r.id} className={`strip-seg ${m.kind}`} title={`${m.label} · ${r.title}`} />
            })}
          </div>
          <ul className="run-list">
            {runs.map((r) => {
              const m = runMeta(r)
              return (
                <li key={r.id} className={`run-row ${m.kind}`}>
                  <span className="run-icon"><RunIcon kind={m.kind} /></span>
                  <a className="run-title" href={r.url} target="_blank" rel="noreferrer" title={r.title}>{r.title}</a>
                  <span className="run-meta">
                    <span>{r.event} · {r.branch || '—'}</span>
                    <span>{fmtDur(r.durationSec)}</span>
                    <span>{relTime(r.createdAt)}</span>
                  </span>
                  <span className={`run-badge ${m.kind}`}>{m.label}</span>
                  <ExternalLink size={13} className="run-ext" />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Panel>
  )
}

/* ---------------- release ---------------- */

export function ReleasePanel({ release, app }: { release: Release | null; app: AppConfig }) {
  return (
    <Panel title="Latest release" icon={<Package size={17} />} extra={release && <span className="panel-extra">tag: {release.tag}</span>}>
      {!release ? <Empty text="This repository has no published release yet." /> : (
        <div className="release">
          <div className="release-head">
            <div className="release-mark"><Sparkles size={18} /></div>
            <div>
              <strong>{release.name}</strong>
              <span>{fmtDate(release.publishedAt)}</span>
            </div>
          </div>
          {release.versionCode && <div className="version-line">versionCode <b>{release.versionCode}</b> · auto from workflow run number</div>}
          {release.body && <p className="release-body">{release.body.slice(0, 240)}</p>}
          <div className="asset-list">
            {release.assets.length === 0 && <Empty text="No assets attached." />}
            {release.assets.map((a) => (
              <div className="asset" key={a.name}>
                <div className="asset-info">
                  <strong>{a.name}</strong>
                  <span>{fmtBytes(a.size)} · {a.downloads} downloads</span>
                </div>
                <a className="dl-btn" href={a.url} target="_blank" rel="noreferrer">
                  <Download size={14} /> APK
                </a>
              </div>
            ))}
          </div>
          <a className="text-link" href={release.url} target="_blank" rel="noreferrer">
            View release on GitHub <ArrowUpRight size={13} />
          </a>
        </div>
      )}
      {app.id === 'droidime' && <p className="panel-foot">Pushes to <code>main</code> rebuild a signed APK and replace the rolling <code>latest</code> release.</p>}
    </Panel>
  )
}

/* ---------------- repo meta ---------------- */

export function MetaPanel({ snapshot }: { snapshot: Snapshot }) {
  const entries = Object.entries(snapshot.languages || {}).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((n, [, v]) => n + v, 0) || 1
  const colors = ['#8b7cff', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#a78bfa']
  return (
    <Panel title="Repository" icon={<Server size={17} />}>
      <div className="lang-head"><span>LANGUAGES</span><span>{entries.length} detected</span></div>
      <div className="lang-bar">
        {entries.map(([name, bytes], i) => (
          <span key={name} style={{ width: `${(bytes / total) * 100}%`, background: colors[i % colors.length] }} title={`${name} ${((bytes / total) * 100).toFixed(1)}%`} />
        ))}
      </div>
      <div className="lang-legend">
        {entries.map(([name, bytes], i) => (
          <span key={name}><i style={{ background: colors[i % colors.length] }} />{name} <b>{((bytes / total) * 100).toFixed(1)}%</b></span>
        ))}
        {entries.length === 0 && <span className="muted">no language data</span>}
      </div>
      <div className="fact-grid">
        <div><span>Created</span><strong>{relTime(snapshot.repo.createdAt)}</strong></div>
        <div><span>Size</span><strong>{fmtBytes((snapshot.repo.sizeKb || 0) * 1024)}</strong></div>
        <div><span>Branch</span><strong>{snapshot.repo.defaultBranch}</strong></div>
        <div><span>PRs open</span><strong>{snapshot.openPulls}</strong></div>
      </div>
      {snapshot.repo.topics.length > 0 && (
        <div className="topics">{snapshot.repo.topics.map((t) => <span key={t}>{t}</span>)}</div>
      )}
    </Panel>
  )
}

/* ---------------- commits ---------------- */

export function CommitsPanel({ commits }: { commits: Snapshot['commits'] }) {
  return (
    <Panel title="Recent commits" icon={<GitCommitHorizontal size={17} />} extra={<span className="panel-extra">{commits.length} latest</span>}>
      {commits.length === 0 ? <Empty text="No commits found." /> : (
        <ul className="commit-list">
          {commits.map((c) => (
            <li key={c.sha}>
              <code>{c.short}</code>
              <a href={c.url} target="_blank" rel="noreferrer" title={c.message}>{c.message}</a>
              <span className="commit-meta">{c.author} · {relTime(c.date)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

export function HighlightsPanel({ app }: { app: AppConfig }) {
  const icons = [<Wifi size={14} />, <Database size={14} />, <Layers size={14} />, <Code2 size={14} />]
  return (
    <Panel title="What's inside" icon={<Sparkles size={17} />} extra={<span className="panel-extra">{app.tag}</span>}>
      <ul className="highlight-list">
        {app.highlights.map((h, i) => (
          <li key={h}><span className="hi-icon">{icons[i % icons.length]}</span>{h}</li>
        ))}
      </ul>
      <div className="add-hint">
        <strong>Adding another app?</strong>
        <span>Append one entry to <code>apps.config.json</code> — the sidebar, overview and API pick it up automatically.</span>
      </div>
    </Panel>
  )
}

/* ---------------- misc ---------------- */

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner"><AlertCircle size={17} /><span>{message}</span></div>
}

export function Skeleton() {
  return (
    <div className="skeleton-wrap">
      <div className="sk sk-hero" />
      <div className="sk-grid">{Array.from({ length: 6 }).map((_, i) => <div className="sk" key={i} />)}</div>
      <div className="sk sk-panel" />
    </div>
  )
}

export function Boot({ error }: { error: string | null }) {
  return (
    <div className="boot">
      <div className="boot-mark"><Boxes size={26} /></div>
      <strong>AIxodia Console</strong>
      {error ? <span className="boot-error">{error}</span> : <span className="boot-loading"><LoaderCircle size={14} className="spin" /> connecting to GitHub…</span>}
    </div>
  )
}

export function Footer({ health }: { health: Health | null }) {
  return (
    <footer className="footer">
      <span>{health?.tagline || 'Build & release dashboard'}</span>
      <span>
        {health?.authenticated ? <><ShieldCheck size={13} /> server-side token · {health.tokenSource}</> : 'public GitHub API'}
        {' · '}cache {health ? Math.round(health.cacheTtlMs / 1000) : 60}s
      </span>
    </footer>
  )
}
