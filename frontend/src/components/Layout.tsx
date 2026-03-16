import { NavLink } from 'react-router-dom'
import { ReactNode, useState, useEffect, useRef } from 'react'
import { AuthState, SessionState, saveSession, saveLastWallet, clearSession } from '../lib/session'
import { loadWallets } from '../lib/crypto'
import { api } from '../lib/api'

interface Props {
  auth: AuthState
  session: SessionState | null
  onLogout: () => void
  onSessionChange: (session: SessionState | null) => void
  children: ReactNode
}

export default function Layout({ auth, session, onLogout, onSessionChange, children }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activating, setActivating] = useState<string | null>(null)
  const [error, setError] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)

  const wallets = loadWallets()

  useEffect(() => {
    if (!pickerOpen) return
    function onClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [pickerOpen])

  async function handleLogout() {
    try { await api.delete('/auth/logout') } catch { /* ignora */ }
    onLogout()
  }

  async function handleSelectWallet(pubkey: string) {
    const wallet = wallets.find(w => w.publicKey === pubkey)
    if (!wallet) return
    setActivating(pubkey)
    setError('')
    try {
      const res = await api.post<{ token: string; publicKey: string }>('/wallet/session', {
        privateKeyBase58: wallet.privateKeyBase58,
      })
      const newSession: SessionState = {
        token: res.token,
        publicKey: res.publicKey,
        walletLabel: wallet.label,
      }
      saveSession(newSession)
      saveLastWallet(newSession.publicKey)
      onSessionChange(newSession)
      setPickerOpen(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao ativar wallet')
    } finally {
      setActivating(null)
    }
  }

  function handleDeactivate() {
    clearSession()
    onSessionChange(null)
    setPickerOpen(false)
  }

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 rounded text-sm transition-colors ${
      isActive
        ? 'bg-brand-dark text-brand'
        : 'text-gray-400 hover:text-white hover:bg-surface-700'
    }`

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-600 bg-surface-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="text-brand font-bold text-sm tracking-widest uppercase">
            Pump Launcher
          </span>
          <nav className="flex gap-1">
            <NavLink to="/deploy" className={navClass}>Pump Deploy</NavLink>
            <NavLink to="/standard" className={navClass}>Standard Deploy</NavLink>
            <NavLink to="/monitor" className={navClass}>Monitor</NavLink>
            <NavLink to="/wallets" className={navClass}>Wallets</NavLink>
            <NavLink to="/live" className={navClass}>Live Deploys</NavLink>
          </nav>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-500">{auth.username}</span>

          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => { setPickerOpen(v => !v); setError('') }}
              className={`px-3 py-1 rounded text-xs border transition-colors ${
                session
                  ? 'border-brand/40 text-brand bg-brand/5 hover:bg-brand/10'
                  : 'border-surface-500 text-gray-400 hover:text-white hover:border-surface-400'
              }`}
            >
              {session ? session.walletLabel : 'selecionar wallet'}
            </button>

            {pickerOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-surface-800 border border-surface-600 rounded-lg shadow-xl w-64 p-3 space-y-2">
                {session && (
                  <div className="pb-2 border-b border-surface-600 flex items-center justify-between">
                    <div>
                      <span className="text-xs text-brand font-medium">{session.walletLabel}</span>
                      <span className="text-xs text-gray-600 ml-2 font-mono">
                        {session.publicKey.slice(0, 4)}...{session.publicKey.slice(-4)}
                      </span>
                    </div>
                    <button onClick={handleDeactivate} className="text-xs text-gray-500 hover:text-danger transition-colors">
                      desativar
                    </button>
                  </div>
                )}

                {wallets.length === 0 ? (
                  <p className="text-xs text-gray-500 text-center py-2">
                    Nenhuma wallet. Crie em <span className="text-brand">Wallets</span>.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {wallets.map(w => {
                      const isActive = session?.publicKey === w.publicKey
                      return (
                        <button
                          key={w.publicKey}
                          onClick={() => !isActive && handleSelectWallet(w.publicKey)}
                          disabled={activating !== null || isActive}
                          className={`w-full rounded p-2 text-left transition-colors text-xs border ${
                            isActive
                              ? 'border-brand/30 bg-brand/10 cursor-default'
                              : 'border-transparent hover:bg-surface-700 cursor-pointer'
                          } disabled:opacity-60`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{w.label}</span>
                            <span className="text-gray-500 font-mono">
                              {w.publicKey.slice(0, 4)}...{w.publicKey.slice(-4)}
                            </span>
                          </div>
                          {isActive && <span className="text-brand text-xs">ativa</span>}
                          {activating === w.publicKey && <span className="text-brand text-xs">ativando...</span>}
                        </button>
                      )
                    })}
                  </div>
                )}

                {error && <p className="text-danger text-xs">{error}</p>}
              </div>
            )}
          </div>

          <button onClick={handleLogout} className="btn-ghost text-xs px-3 py-1">
            sair
          </button>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-5xl mx-auto w-full">
        {children}
      </main>
    </div>
  )
}
