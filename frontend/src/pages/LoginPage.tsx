import { useState } from 'react'
import { saveAuth, saveSession, saveLastWallet, AuthState, SessionState } from '../lib/session'
import { loadWallets, StoredWallet } from '../lib/crypto'
import { api } from '../lib/api'

interface Props {
  onLogin: (auth: AuthState, session: SessionState) => void
}

export default function LoginPage({ onLogin }: Props) {
  const [step, setStep] = useState<'auth' | 'wallet'>('auth')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authResult, setAuthResult] = useState<AuthState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [activating, setActivating] = useState<string | null>(null)

  const wallets = loadWallets()

  async function handleAuth() {
    if (!username.trim() || !password) { setError('Preencha usuario e senha'); return }
    setLoading(true)
    setError('')
    try {
      const res = await api.post<{ token: string; username: string }>('/auth/login', {
        username: username.trim(),
        password,
      })
      saveAuth(res)
      setAuthResult(res)
      setStep('wallet')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao entrar')
    } finally {
      setLoading(false)
    }
  }

  async function handleSelectWallet(wallet: StoredWallet) {
    if (!authResult) return
    setActivating(wallet.publicKey)
    setError('')
    try {
      const res = await api.post<{ token: string; publicKey: string }>('/wallet/session', {
        privateKeyBase58: wallet.privateKeyBase58,
      })
      const session: SessionState = {
        token: res.token,
        publicKey: res.publicKey,
        walletLabel: wallet.label,
      }
      saveSession(session)
      saveLastWallet(session.publicKey)
      onLogin(authResult, session)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao ativar wallet')
    } finally {
      setActivating(null)
    }
  }

  // --- STEP: wallet selection ---
  if (step === 'wallet') {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="card w-full max-w-xs space-y-4">
          <div>
            <h1 className="text-brand font-bold text-lg tracking-widest uppercase text-center">
              Pump Launcher
            </h1>
            <p className="text-gray-500 text-xs text-center mt-1">
              Selecione a wallet principal
            </p>
          </div>

          {wallets.length === 0 ? (
            <div className="space-y-3 text-center">
              <p className="text-gray-400 text-sm">Nenhuma wallet criada ainda.</p>
              <p className="text-gray-500 text-xs">
                Voce pode criar sua primeira wallet apos entrar, em <span className="text-brand">Wallets</span>.
              </p>
              <button
                onClick={() => {
                  // Entra sem wallet ativa — vai criar depois
                  if (!authResult) return
                  // Cria uma session dummy? Na verdade nao precisa de session pra entrar
                  // Apenas sinalizamos que nao ha wallet e deixamos o user entrar
                  onLogin(authResult, { token: '', publicKey: '', walletLabel: '' })
                }}
                className="btn-primary w-full"
              >
                entrar sem wallet
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {wallets.map(w => (
                <button
                  key={w.publicKey}
                  onClick={() => handleSelectWallet(w)}
                  disabled={activating !== null}
                  className="w-full rounded-lg border border-surface-600 hover:border-brand/50 hover:bg-brand/5
                             p-3 text-left transition-colors disabled:opacity-60 disabled:cursor-wait"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm">{w.label}</span>
                    <span className="text-xs text-gray-500 font-mono">
                      {w.publicKey.slice(0, 4)}...{w.publicKey.slice(-4)}
                    </span>
                  </div>
                  {activating === w.publicKey && (
                    <p className="text-brand text-xs mt-1">ativando...</p>
                  )}
                </button>
              ))}
            </div>
          )}

          {error && <p className="text-danger text-xs">{error}</p>}

          <button
            onClick={() => { setStep('auth'); setError('') }}
            className="btn-ghost w-full text-xs"
          >
            voltar
          </button>
        </div>
      </div>
    )
  }

  // --- STEP: auth ---
  return (
    <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
      <div className="card w-full max-w-xs space-y-5">
        <h1 className="text-brand font-bold text-lg tracking-widest uppercase text-center">
          Pump Launcher
        </h1>

        <div className="space-y-3">
          <div>
            <label className="label">Usuario</label>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full"
              placeholder="seu usuario"
              autoFocus
              autoComplete="username"
            />
          </div>
          <div>
            <label className="label">Senha</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full"
              autoComplete="current-password"
              onKeyDown={e => e.key === 'Enter' && handleAuth()}
            />
          </div>
        </div>

        {error && <p className="text-danger text-xs">{error}</p>}

        <button onClick={handleAuth} disabled={loading} className="btn-primary w-full">
          {loading ? 'entrando...' : 'entrar'}
        </button>
      </div>
    </div>
  )
}
