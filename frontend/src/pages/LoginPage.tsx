import { useState } from 'react'
import { saveAuth, saveSession, saveLastWallet, AuthState, SessionState } from '../lib/session'
import { loadWallets, saveWallet, StoredWallet } from '../lib/crypto'
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

  // Criação de wallet inline (tela de seleção)
  const [createMode, setCreateMode] = useState<'none' | 'generate' | 'import'>('none')
  const [genKey, setGenKey] = useState('')
  const [genPubkey, setGenPubkey] = useState('')
  const [genLabel, setGenLabel] = useState('')
  const [genLoading, setGenLoading] = useState(false)
  const [importKey, setImportKey] = useState('')
  const [importLabel, setImportLabel] = useState('')
  const [createError, setCreateError] = useState('')

  const [wallets, setWallets] = useState<StoredWallet[]>(loadWallets)

  function refreshWallets() { setWallets(loadWallets()) }

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

  async function handleGenerate() {
    setGenLoading(true)
    setCreateError('')
    try {
      const res = await api.post<{ publicKey: string; privateKeyBase58: string }>('/wallet/generate')
      setGenKey(res.privateKeyBase58)
      setGenPubkey(res.publicKey)
      setCreateMode('generate')
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Erro ao gerar wallet')
    } finally {
      setGenLoading(false)
    }
  }

  async function handleSaveGenerated() {
    if (!genLabel.trim()) { setCreateError('Dê um nome para a wallet'); return }
    saveWallet({ label: genLabel.trim(), publicKey: genPubkey, privateKeyBase58: genKey })
    refreshWallets()
    setCreateMode('none')
    setGenLabel(''); setGenKey(''); setGenPubkey('')
    // Ativa automaticamente a wallet recém-criada
    await handleSelectWallet({ label: genLabel.trim(), publicKey: genPubkey, privateKeyBase58: genKey })
  }

  async function handleSaveImport() {
    if (!importLabel.trim() || !importKey.trim()) { setCreateError('Preencha nome e private key'); return }
    setCreateError('')
    try {
      const { parsePrivateKeyFull } = await import('../lib/crypto')
      const { base58, publicKey } = await parsePrivateKeyFull(importKey.trim())
      saveWallet({ label: importLabel.trim(), publicKey, privateKeyBase58: base58 })
      refreshWallets()
      setCreateMode('none')
      setImportLabel(''); setImportKey('')
      await handleSelectWallet({ label: importLabel.trim(), publicKey, privateKeyBase58: base58 })
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Private key inválida')
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

          {wallets.length === 0 && createMode === 'none' ? (
            <div className="space-y-3">
              <p className="text-gray-400 text-sm text-center">Nenhuma wallet criada ainda.</p>
              <button
                onClick={handleGenerate}
                disabled={genLoading}
                className="btn-primary w-full"
              >
                {genLoading ? 'gerando...' : 'gerar nova wallet'}
              </button>
              <button
                onClick={() => { setCreateMode('import'); setCreateError('') }}
                className="btn-ghost w-full"
              >
                importar private key
              </button>
              <button
                onClick={() => authResult && onLogin(authResult, { token: '', publicKey: '', walletLabel: '' })}
                className="text-gray-600 hover:text-gray-400 text-xs w-full text-center transition-colors"
              >
                entrar sem wallet
              </button>
            </div>
          ) : wallets.length === 0 && createMode === 'generate' ? (
            <div className="space-y-3">
              <div className="bg-yellow-900/30 border border-yellow-700/40 rounded p-3 text-xs text-yellow-400">
                <p className="font-semibold">Salve a private key agora.</p>
                <p className="text-yellow-500/80 mt-0.5">Sem ela não é possível recuperar os fundos.</p>
              </div>
              <div>
                <p className="label">Public Key</p>
                <p className="text-brand text-xs font-mono break-all">{genPubkey}</p>
              </div>
              <div>
                <p className="label">Private Key</p>
                <div className="bg-surface-700 border border-surface-600 rounded p-2 flex items-center justify-between gap-2">
                  <p className="font-mono text-xs break-all">{genKey}</p>
                  <button onClick={() => navigator.clipboard.writeText(genKey)} className="btn-ghost text-xs px-2 py-1 shrink-0">copiar</button>
                </div>
              </div>
              <div>
                <label className="label">Nome da wallet</label>
                <input value={genLabel} onChange={e => setGenLabel(e.target.value)} className="w-full" placeholder="Ex: Principal" autoFocus onKeyDown={e => e.key === 'Enter' && handleSaveGenerated()} />
              </div>
              {createError && <p className="text-danger text-xs">{createError}</p>}
              <button onClick={handleSaveGenerated} disabled={!genLabel.trim()} className="btn-primary w-full">salvar e entrar</button>
              <button onClick={() => setCreateMode('none')} className="btn-ghost w-full text-xs">voltar</button>
            </div>
          ) : wallets.length === 0 && createMode === 'import' ? (
            <div className="space-y-3">
              <div>
                <label className="label">Nome</label>
                <input value={importLabel} onChange={e => setImportLabel(e.target.value)} className="w-full" placeholder="Ex: Principal" autoFocus />
              </div>
              <div>
                <label className="label">Private Key</label>
                <input value={importKey} onChange={e => setImportKey(e.target.value)} type="password" className="w-full font-mono text-xs" placeholder="5Jxxx... ou [12,34,...]" onKeyDown={e => e.key === 'Enter' && handleSaveImport()} />
              </div>
              {createError && <p className="text-danger text-xs">{createError}</p>}
              <button onClick={handleSaveImport} className="btn-primary w-full">importar e entrar</button>
              <button onClick={() => setCreateMode('none')} className="btn-ghost w-full text-xs">voltar</button>
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

          {createMode === 'none' && (
            <button
              onClick={() => { setStep('auth'); setError('') }}
              className="btn-ghost w-full text-xs"
            >
              voltar
            </button>
          )}
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
