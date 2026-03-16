import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { loadAuth, loadSession, clearAll, AuthState, SessionState } from './lib/session'
import { clearLegacyStorage } from './lib/crypto'
import { setAuthExpiredHandler, setSessionExpiredHandler } from './lib/api'
import { SessionContext } from './lib/SessionContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import DeployPage from './pages/DeployPage'
import WalletsPage from './pages/WalletsPage'
import MonitorPage from './pages/MonitorPage'

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    clearLegacyStorage()
    setAuth(loadAuth())
    setSession(loadSession())
    setLoading(false)

    setAuthExpiredHandler(() => {
      clearAll()
      setAuth(null)
      setSession(null)
    })

    setSessionExpiredHandler(() => {
      setSession(null)
    })
  }, [])

  function handleLogin(a: AuthState, s: SessionState) {
    setAuth(a)
    // session vazia (token='') significa que entrou sem wallet — trata como null
    setSession(s.token ? s : null)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center">
        <span className="text-brand text-sm">carregando...</span>
      </div>
    )
  }

  if (!auth) {
    return <LoginPage onLogin={handleLogin} />
  }

  return (
    <SessionContext.Provider value={{ session, setSession }}>
      <Layout
        auth={auth}
        session={session}
        onLogout={() => { clearAll(); setAuth(null); setSession(null) }}
        onSessionChange={setSession}
      >
        <Routes>
          <Route path="/" element={<Navigate to="/deploy" replace />} />
          <Route path="/deploy" element={<DeployPage />} />
          <Route path="/wallets" element={<WalletsPage />} />
          <Route path="/monitor" element={<MonitorPage />} />
        </Routes>
      </Layout>
    </SessionContext.Provider>
  )
}
