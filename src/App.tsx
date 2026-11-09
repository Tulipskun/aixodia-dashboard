import { useEffect, useRef, useState } from 'react'

import * as api from './api'
import type { Health, Session } from './types'
import { Boot, LoginPage } from './components'

type Phase = 'boot' | 'login' | 'home'

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot')
  const [session, setSession] = useState<Session | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.setUnauthorizedHandler(() => {
      setSession(null)
      setPhase('login')
    })
    return () => api.setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authError = params.get('auth_error')
    if (authError) {
      const messages: Record<string, string> = {
        access_denied: 'You cancelled GitHub authorization.',
        not_allowed: 'This GitHub account is not authorized to access the console.',
        oauth_failed: 'GitHub sign-in failed. Please try again.',
      }
      setLoginError(messages[authError] || 'Unable to sign in with GitHub.')
      window.history.replaceState({}, '', window.location.pathname)
    }

    let alive = true
    void (async () => {
      try {
        const [currentSession, currentHealth] = await Promise.all([
          api.getSession(),
          api.getHealth(),
        ])
        if (!alive) return
        setSession(currentSession)
        setHealth(currentHealth)
        setPhase(currentSession.authenticated ? 'home' : 'login')
      } catch {
        if (alive) setPhase('login')
      }
    })()

    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (phase !== 'home') return

    const lockAuthenticatedHistory = () => {
      window.history.pushState({ aixodiaAuthenticated: true }, '', window.location.href)
    }

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
      if (event.key === 'Escape' && !logoutBusy) setLogoutConfirmOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [logoutConfirmOpen, logoutBusy])

  const handleGithubLogin = () => {
    setLoginBusy(true)
    setLoginError(null)
    window.location.assign('/sso/github')
  }

  const handleLogout = async () => {
    if (logoutBusy) return
    setLogoutBusy(true)
    try {
      await api.logout()
    } catch {
      // The server-side session may already have expired.
    }
    setSession(null)
    setLogoutConfirmOpen(false)
    setLogoutBusy(false)
    setPhase('login')
  }

  if (phase === 'boot') return <Boot label="Checking your session…" />

  if (phase === 'login') {
    return (
      <LoginPage
        onGithubLogin={handleGithubLogin}
        busy={loginBusy}
        error={loginError}
        health={health}
      />
    )
  }

  return (
    <div className="hello-world-layout">
      <header className="hello-world-topbar">
        <a className="hello-world-brand" href="/" aria-label="AIxodia Dashboard">
          <span className="hello-world-brand-mark">A</span>
          <span className="hello-world-brand-name">AIxodia</span>
        </a>
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
      <main className="hello-world-screen" aria-label="Dashboard">
        <span>hello world</span>
      </main>
      {logoutConfirmOpen && (
        <div
          className="logout-confirm-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !logoutBusy) setLogoutConfirmOpen(false)
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
                disabled={logoutBusy}
                onClick={() => setLogoutConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                className="logout-confirm-submit"
                type="button"
                disabled={logoutBusy}
                onClick={() => void handleLogout()}
              >
                {logoutBusy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
