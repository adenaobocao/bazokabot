import { useState } from 'react'
import {
  saveWallet,
  loadWallets,
  removeWallet,
  StoredWallet,
  parsePrivateKeyFull,
} from '../lib/crypto'
import { api } from '../lib/api'

export default function WalletsPage() {
  const [wallets, setWallets] = useState<StoredWallet[]>(loadWallets)
  const [mode, setMode] = useState<'list' | 'import' | 'generate'>('list')

  // Import form
  const [importLabel, setImportLabel] = useState('')
  const [importKey, setImportKey] = useState('')
  const [importError, setImportError] = useState('')
  const [importLoading, setImportLoading] = useState(false)

  // Generate result
  const [generatedKey, setGeneratedKey] = useState('')
  const [generatedPubkey, setGeneratedPubkey] = useState('')
  const [genLabel, setGenLabel] = useState('')
  const [genSaved, setGenSaved] = useState(false)

  // Export
  const [exportTarget, setExportTarget] = useState('')

  function refresh() { setWallets(loadWallets()) }

  async function handleImport() {
    setImportError('')
    if (!importLabel || !importKey) { setImportError('Preencha nome e private key'); return }
    setImportLoading(true)
    try {
      const { base58, publicKey } = await parsePrivateKeyFull(importKey.trim())
      saveWallet({ label: importLabel, publicKey, privateKeyBase58: base58 })
      setImportLabel('')
      setImportKey('')
      setMode('list')
      refresh()
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Erro ao importar')
    } finally {
      setImportLoading(false)
    }
  }

  async function handleGenerate() {
    const res = await api.post<{ publicKey: string; privateKeyBase58: string }>('/wallet/generate')
    setGeneratedKey(res.privateKeyBase58)
    setGeneratedPubkey(res.publicKey)
    setGenSaved(false)
    setMode('generate')
  }

  function handleSaveGenerated() {
    if (!genLabel) return
    saveWallet({ label: genLabel, publicKey: generatedPubkey, privateKeyBase58: generatedKey })
    setGeneratedKey('')
    setGeneratedPubkey('')
    setGenLabel('')
    setGenSaved(true)
    refresh()
    setTimeout(() => setMode('list'), 1500)
  }

  function handleRemove(publicKey: string) {
    if (!confirm('Remover essa wallet? (So remove o registro local, nao apaga os fundos)')) return
    removeWallet(publicKey)
    refresh()
  }

  if (mode === 'import') {
    return (
      <div className="max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => setMode('list')} className="btn-ghost text-xs px-2 py-1">voltar</button>
          <h2 className="font-semibold">Importar wallet</h2>
        </div>
        <div className="card space-y-3">
          <div>
            <label className="label">Nome</label>
            <input value={importLabel} onChange={e => setImportLabel(e.target.value)} className="w-full" placeholder="Ex: Principal, Trader..." autoFocus />
          </div>
          <div>
            <label className="label">Private Key</label>
            <input
              value={importKey}
              onChange={e => setImportKey(e.target.value)}
              className="w-full font-mono text-xs"
              placeholder="5Jxxx... ou [12,34,...] (Phantom)"
              type="password"
              onKeyDown={e => e.key === 'Enter' && handleImport()}
            />
          </div>
          {importError && <p className="text-danger text-xs">{importError}</p>}
          <button onClick={handleImport} disabled={importLoading} className="btn-primary w-full">
            {importLoading ? 'importando...' : 'importar wallet'}
          </button>
          <p className="text-gray-500 text-xs">
            A private key e salva localmente no seu browser. O app e protegido pelo login.
          </p>
        </div>
      </div>
    )
  }

  if (mode === 'generate') {
    return (
      <div className="max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => setMode('list')} className="btn-ghost text-xs px-2 py-1">voltar</button>
          <h2 className="font-semibold">Nova wallet gerada</h2>
        </div>
        <div className="card space-y-3">
          <div className="bg-warning/10 border border-warning/30 rounded p-3 text-xs text-warning">
            <p className="font-semibold">Salve a private key agora.</p>
            <p>Se perder acesso ao browser, precisara dela para recuperar os fundos.</p>
          </div>
          <div>
            <label className="label">Public Key</label>
            <p className="text-brand text-xs font-mono break-all">{generatedPubkey}</p>
          </div>
          <div>
            <label className="label">Private Key</label>
            <p className="font-mono text-xs break-all bg-surface-700 p-2 rounded border border-surface-600">{generatedKey}</p>
            <button onClick={() => navigator.clipboard.writeText(generatedKey)} className="btn-ghost text-xs px-2 py-1 mt-1">
              copiar
            </button>
          </div>
          <hr className="border-surface-600" />
          <div>
            <label className="label">Nome da wallet</label>
            <input value={genLabel} onChange={e => setGenLabel(e.target.value)} className="w-full" placeholder="Ex: Principal" autoFocus />
          </div>
          {genSaved && <p className="text-brand text-xs">Wallet salva.</p>}
          <button onClick={handleSaveGenerated} disabled={!genLabel} className="btn-primary w-full">
            salvar wallet
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Wallets</h2>
        <div className="flex gap-2">
          <button onClick={() => setMode('import')} className="btn-ghost text-xs">importar PK</button>
          <button onClick={handleGenerate} className="btn-primary text-xs">gerar nova</button>
        </div>
      </div>

      {wallets.length === 0 && (
        <div className="card text-gray-400 text-sm text-center py-8">
          Nenhuma wallet. Importe uma PK existente ou gere uma nova.
        </div>
      )}

      {wallets.map(w => (
        <div key={w.publicKey} className="card space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-sm">{w.label}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setExportTarget(exportTarget === w.publicKey ? '' : w.publicKey)}
                className="btn-ghost text-xs px-2 py-1"
              >
                {exportTarget === w.publicKey ? 'ocultar PK' : 'ver PK'}
              </button>
              <button onClick={() => handleRemove(w.publicKey)} className="btn-danger text-xs px-2 py-1">remover</button>
            </div>
          </div>
          <p className="text-gray-400 text-xs font-mono break-all">{w.publicKey}</p>
          {exportTarget === w.publicKey && (
            <div className="border-t border-surface-600 pt-2 space-y-1">
              <p className="font-mono text-xs break-all bg-surface-700 p-2 rounded border border-surface-600">
                {w.privateKeyBase58}
              </p>
              <button onClick={() => navigator.clipboard.writeText(w.privateKeyBase58)} className="btn-ghost text-xs px-2 py-1">
                copiar
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
