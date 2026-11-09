import { useEffect, useState } from 'react'

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

  const handleGithubLogin = () => {
    setLoginBusy(true)
    setLoginError(null)
    window.location.assign('/auth/github')
  }

  const handleLogout = async () => {
    try {
      await api.logout()
    } catch {
      // The server-side session may already have expired.
    }
    setSession(null)
    setPhase('login')
  }

  if (phase === 'boot') return <Boot label="กำลังตรวจสอบเซสชัน…" />

  if (phase === 'login') {
    return (
      <LoginPage
        info={null}
        onGithubLogin={handleGithubLogin}
        busy={loginBusy}
        error={loginError}
        health={health}
      />
    )
  }

  return (
    <main className="hello-world-screen" aria-label="Dashboard">
      <span>hello world</span>
    </main>
  )
}
