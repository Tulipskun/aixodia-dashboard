import { useEffect, useRef, useState } from 'react'

import * as api from './api'
import type { Device, Session } from './types'
import { DashboardHome, DeviceControl, EngineChat } from './dashboard'
import { Boot, LoginPage } from './components'

type Phase = 'boot' | 'login' | 'home'
type View = 'home' | 'chat' | 'device'

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot')
  const [session, setSession] = useState<Session | null>(null)
  const [view, setView] = useState<View>('home')
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const oauthCallbackHandled = useRef(false)

  useEffect(() => {
    const callback = new URL(window.location.href)
    const code = callback.searchParams.get('code')
    const state = callback.searchParams.get('state')
    const oauthError = callback.searchParams.get('error')
    if (oauthCallbackHandled.current) return

    // Android uses the same registered HTTPS callback as the dashboard. This
    // tiny bridge returns the temporary code to the app's verified scheme URI;
    // the PKCE verifier remains encrypted inside the Android app.
    if (state?.startsWith('aixodia-android.')) {
      oauthCallbackHandled.current = true
      const appCallback = new URL('aixodia://oauth/callback')
      if (code) appCallback.searchParams.set('code', code)
      if (state) appCallback.searchParams.set('state', state)
      if (oauthError) appCallback.searchParams.set('error', oauthError)
      window.location.replace(appCallback.toString())
      return
    }
    if (!code && !oauthError) return
    oauthCallbackHandled.current = true
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    if (oauthError || !code || !state) {
      setLoginError(oauthError === 'access_denied' ? 'GitHub authorization was cancelled.' : 'GitHub returned an incomplete authorization response.')
      setPhase('login')
      return
    }
    setLoginBusy(true)
    api.completeGitHubOAuth(code, state)
      .then(next => {
        setSession(next)
        setPhase(next.authenticated ? 'home' : 'login')
      })
      .catch(error => {
        setLoginError(error instanceof Error ? error.message : 'GitHub sign-in failed.')
        setPhase('login')
      })
      .finally(() => setLoginBusy(false))
  }, [])

  useEffect(() => {
    // A 401 means the Engine rejected the access/refresh credentials. Transient
    // refresh failures never call this handler and keep the user signed in.
    api.setUnauthorizedHandler(() => {
      api.logout()
      setSession(null)
      setPhase('login')
    })
    return () => api.setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    // Session is derived locally from the access/refresh credentials in
    // sessionStorage. Every engine route except auth issuance/refresh requires
    // an access token, so do not call /healthz before sign-in.
    const current = api.getSession()
    setSession(current)
    setPhase(current.authenticated ? 'home' : 'login')
  }, [])

  useEffect(() => {
    if (phase !== 'home') return
    const lockAuthenticatedHistory = () => {
      window.history.pushState({ aixodiaAuthenticated: true }, '', window.location.href)
    }
    window.history.replaceState({ aixodiaAuthenticated: true }, '', window.location.href)
    lockAuthenticatedHistory()
    window.addEventListener('popstate', lockAuthenticatedHistory)
    return () => window.removeEventListener('popstate', lockAuthenticatedHistory)
  }, [phase])

  useEffect(() => {
    if (!accountMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [accountMenuOpen])

  useEffect(() => {
    if (!logoutConfirmOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLogoutConfirmOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [logoutConfirmOpen])

  const handleStartGitHubOAuth = async () => {
    setLoginBusy(true)
    setLoginError(null)
    try {
      await api.beginGitHubOAuth()
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Unable to start GitHub sign-in.')
      setLoginBusy(false)
    }
  }

  const handleLogout = () => {
    api.logout()
    setSession(null)
    setLogoutConfirmOpen(false)
    setPhase('login')
  }

  if (phase === 'boot') return <Boot label="Checking your session…" />

  if (phase === 'login') {
    return (
      <LoginPage
        onStart={handleStartGitHubOAuth}
        busy={loginBusy}
        error={loginError}
      />
    )
  }

  return (
    <div className="hello-world-layout">
      <header className="hello-world-topbar">
        <button className="hello-world-brand brand-button" type="button" onClick={() => { setView('home'); setSelectedDevice(null) }} aria-label="AIxodia Dashboard">
          <span className="hello-world-brand-mark">A</span>
          <span className="hello-world-brand-name">AIxodia</span>
        </button>
        <div className="hello-world-account-menu" ref={accountMenuRef}>
          <button
            className="hello-world-account-trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            onClick={() => setAccountMenuOpen(open => !open)}
          >
            <span className="hello-world-username">{session?.username ?? 'Signed in'}</span>
            <span className={`hello-world-account-chevron${accountMenuOpen ? ' is-open' : ''}`} aria-hidden="true">⌄</span>
          </button>
          {accountMenuOpen && (
            <div className="hello-world-account-dropdown" role="menu">
              <div className="hello-world-dropdown-user">{session?.username ?? 'Signed in'}</div>
              <button
                className="hello-world-logout"
                type="button"
                role="menuitem"
                onClick={() => { setAccountMenuOpen(false); setLogoutConfirmOpen(true) }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className={`hello-world-screen app-content ${view !== 'home' ? 'is-subview' : ''}`} aria-label="Dashboard">
        {view === 'home' && (
          <DashboardHome
            onOpenChat={() => setView('chat')}
            onOpenDevice={device => { setSelectedDevice(device); setView('device') }}
          />
        )}
        {view === 'chat' && <EngineChat onBack={() => setView('home')} />}
        {view === 'device' && selectedDevice && (
          <DeviceControl device={selectedDevice} onBack={() => setView('home')} />
        )}
      </main>
      {logoutConfirmOpen && (
        <div
          className="logout-confirm-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setLogoutConfirmOpen(false)
          }}
        >
          <section
            className="logout-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
            aria-describedby="logout-confirm-description"
          >
            <div className="logout-confirm-icon" aria-hidden="true">↪</div>
            <h2 id="logout-confirm-title">Sign out?</h2>
            <p id="logout-confirm-description">Are you sure you want to sign out of your AIxodia account?</p>
            <div className="logout-confirm-actions">
              <button
                className="logout-confirm-cancel"
                type="button"
                autoFocus
                onClick={() => setLogoutConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                className="logout-confirm-submit"
                type="button"
                onClick={handleLogout}
              >
                Sign out
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
