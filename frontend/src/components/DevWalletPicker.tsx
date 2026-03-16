import { useState } from 'react'
import { api } from '../lib/api'
import { saveBundleWallet, parsePrivateKeyFull } from '../lib/crypto'
import WalletCard from './WalletCard'
import Tooltip from './Tooltip'

export interface DevWalletConfig {
  type: 'main' | 'fresh'
  publicKey?: string
  privateKeyBase58?: string
}

type DevMode = 'main' | 'fresh' | 'import'

interface Props {
  value: DevWalletConfig
  onChange: (config: DevWalletConfig) => void
  devBuySol: number
  mainPublicKey?: string
  mainBalance?: number
  devBalance?: number
  onDevBalanceRefresh?: () => void
  onMainBalanceRefresh?: () => void
}

const MODE_LABELS: Record<DevMode, string> = {
  main:   'Wallet principal',
  fresh:  'Gerar nova (fresh)',
  import: 'Importar PK',
}

const MODE_HELP: Record<DevMode, string> = {
  main:   'O token sera criado em nome da sua wallet principal. Mais simples, mas expoe sua identidade on-chain.',
  fresh:  'Uma nova wallet descartavel e criada automaticamente. Desacopla sua identidade do token. Precisa ser financiada com SOL.',
  import: 'Use uma wallet sua ja existente como dev wallet. A private key fica so no seu browser.',
}

export default function DevWalletPicker({
  value, onChange, devBuySol, mainPublicKey, mainBalance, devBalance, onDevBalanceRefresh, onMainBalanceRefresh,
}: Props) {
  const [mode, setMode] = useState<DevMode>(value.type === 'main' ? 'main' : 'fresh')

  // Fresh wallet
  const [creating, setCreating] = useState(false)

  // Import PK
  const [importPk, setImportPk] = useState('')
  const [importError, setImportError] = useState('')
  const [importLoading, setImportLoading] = useState(false)

  // Fund panel
  const [showFund, setShowFund] = useState(false)
  const [funding, setFunding] = useState(false)
  const [fundResult, setFundResult] = useState<{ ok?: boolean; sig?: string; error?: string } | null>(null)

  const totalNeeded = devBuySol + 0.01
  const hasSufficientMain = mainBalance !== undefined && mainBalance >= totalNeeded

  function selectMode(m: DevMode) {
    setMode(m)
    setImportError('')
    setImportPk('')
    setFundResult(null)
    setShowFund(false)
    if (m === 'main') {
      onChange({ type: 'main', publicKey: mainPublicKey })
    }
  }

  async function createFreshWallet() {
    setCreating(true)
    setFundResult(null)
    try {
      const res = await api.post<{ publicKey: string; privateKeyBase58: string }>('/wallet/generate')
      saveBundleWallet({ label: 'Dev Fresh', publicKey: res.publicKey, privateKeyBase58: res.privateKeyBase58 }, mainPublicKey || '')
      onChange({ type: 'fresh', publicKey: res.publicKey, privateKeyBase58: res.privateKeyBase58 })
    } finally {
      setCreating(false)
    }
  }

  async function handleImport() {
    setImportError('')
    if (!importPk.trim()) { setImportError('Cole a private key'); return }
    setImportLoading(true)
    try {
      const { base58, publicKey } = await parsePrivateKeyFull(importPk.trim())
      saveBundleWallet({ label: 'Dev Importada', publicKey, privateKeyBase58: base58 }, mainPublicKey || '')
      onChange({ type: 'fresh', publicKey, privateKeyBase58: base58 })
      setImportPk('')
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Erro ao importar')
    } finally {
      setImportLoading(false)
    }
  }

  async function fundFromMain() {
    if (!value.publicKey) return
    setFunding(true)
    setFundResult(null)
    try {
      const res = await api.post<{ results: Array<{ success: boolean; signature?: string; error?: string }> }>(
        '/wallet/fund-bundles',
        { targets: [{ publicKey: value.publicKey, amountSol: totalNeeded }] }
      )
      const r = res.results[0]
      if (r?.success) {
        setFundResult({ ok: true, sig: r.signature })
        onDevBalanceRefresh?.()
        onMainBalanceRefresh?.()
      } else {
        setFundResult({ error: r?.error || 'Erro ao financiar' })
      }
    } catch (err: unknown) {
      setFundResult({ error: err instanceof Error ? err.message : 'Erro' })
    } finally {
      setFunding(false)
    }
  }

  const hasFreshWallet = value.type === 'fresh' && value.publicKey

  return (
    <div className="space-y-3">
      {/* Seletor de modo */}
      <div className="flex gap-1.5">
        {(Object.keys(MODE_LABELS) as DevMode[]).map(m => (
          <button
            key={m}
            onClick={() => selectMode(m)}
            className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition-colors leading-tight ${
              mode === m
                ? 'bg-brand text-black'
                : 'bg-surface-700 text-gray-400 hover:text-white hover:bg-surface-600'
            }`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Help text */}
      <p className="text-xs text-gray-500 leading-relaxed">{MODE_HELP[mode]}</p>

      {/* Modo: principal */}
      {mode === 'main' && mainPublicKey && (
        <WalletCard
          publicKey={mainPublicKey}
          label="Wallet Principal"
          balance={mainBalance}
          badge="sera usada como dev"
          badgeColor="brand"
        />
      )}

      {/* Modo: fresh — ainda nao criada */}
      {mode === 'fresh' && !hasFreshWallet && (
        <button
          onClick={createFreshWallet}
          disabled={creating}
          className="btn-primary w-full text-sm disabled:opacity-50"
        >
          {creating ? 'gerando...' : 'gerar wallet fresh'}
        </button>
      )}

      {/* Modo: fresh — ja criada */}
      {mode === 'fresh' && hasFreshWallet && (
        <WalletCard
          publicKey={value.publicKey!}
          label="Dev Fresh"
          balance={devBalance}
          badge="fresh"
          badgeColor="warning"
          privateKey={value.privateKeyBase58}
          onRefreshBalance={onDevBalanceRefresh}
        >
          <button
            onClick={createFreshWallet}
            disabled={creating}
            className="text-xs text-gray-600 hover:text-gray-300 transition-colors disabled:opacity-40"
            title="Gerar nova fresh wallet (descarta a atual)"
          >
            {creating ? 'gerando...' : 'trocar'}
          </button>
          <button
            onClick={() => setShowFund(v => !v)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ml-auto ${
              showFund ? 'bg-brand/20 text-brand border border-brand/30' : 'btn-ghost'
            }`}
          >
            financiar
          </button>
        </WalletCard>
      )}

      {/* Modo: importar PK */}
      {mode === 'import' && !hasFreshWallet && (
        <div className="border border-surface-600 rounded-xl p-3 space-y-3">
          <div className="flex items-center gap-1.5">
            <label className="label mb-0 text-xs">Private Key (base58)</label>
            <Tooltip text="Cole a private key base58 da wallet que deseja usar como dev wallet. Fica armazenada so no seu browser, nunca e enviada ao servidor de forma permanente.">
              <span className="w-4 h-4 rounded-full bg-surface-700 text-gray-500 text-xs flex items-center justify-center cursor-default">?</span>
            </Tooltip>
          </div>
          <input
            type="password"
            value={importPk}
            onChange={e => setImportPk(e.target.value)}
            className="w-full font-mono text-xs"
            placeholder="5Jxxx... ou [12,34,56,...] (Phantom)"
            onKeyDown={e => e.key === 'Enter' && handleImport()}
          />
          {importError && <p className="text-danger text-xs">{importError}</p>}
          <button
            onClick={handleImport}
            disabled={importLoading || !importPk.trim()}
            className="btn-primary w-full text-sm disabled:opacity-50"
          >
            {importLoading ? 'validando...' : 'importar como dev wallet'}
          </button>
        </div>
      )}

      {/* Wallet importada ja configurada */}
      {mode === 'import' && hasFreshWallet && (
        <WalletCard
          publicKey={value.publicKey!}
          label="Dev Importada"
          balance={devBalance}
          badge="importada"
          badgeColor="warning"
          privateKey={value.privateKeyBase58}
          onRefreshBalance={onDevBalanceRefresh}
        >
          <button
            onClick={() => { onChange({ type: 'main', publicKey: mainPublicKey }); setImportPk('') }}
            className="text-xs text-gray-600 hover:text-gray-300 transition-colors"
          >
            trocar
          </button>
          <button
            onClick={() => setShowFund(v => !v)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ml-auto ${
              showFund ? 'bg-brand/20 text-brand border border-brand/30' : 'btn-ghost'
            }`}
          >
            financiar
          </button>
        </WalletCard>
      )}

      {/* Painel de financiamento (fresh ou importada) */}
      {showFund && hasFreshWallet && (
        <div className="border border-surface-600 rounded-xl p-3 space-y-3 bg-surface-800/50">
          <p className="text-xs font-semibold text-gray-200">Financiar dev wallet</p>

          {/* Origem */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Origem (wallet principal)</span>
            <span className="font-mono text-gray-400">
              {mainPublicKey ? `${mainPublicKey.slice(0,6)}...${mainPublicKey.slice(-4)}` : '—'}
              {mainBalance !== undefined && (
                <span className={`ml-2 font-semibold ${hasSufficientMain ? 'text-brand' : 'text-danger'}`}>
                  {mainBalance.toFixed(4)} SOL
                </span>
              )}
            </span>
          </div>

          {/* Necessario */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Necessario</span>
            <span className="font-mono text-white font-semibold">
              {totalNeeded.toFixed(4)} SOL
              <span className="text-gray-600 ml-1">({devBuySol} buy + 0.01 taxa)</span>
            </span>
          </div>

          {!hasSufficientMain && mainBalance !== undefined && (
            <p className="text-warning text-xs">
              Saldo insuficiente na principal. Faltam {(totalNeeded - mainBalance).toFixed(4)} SOL.
            </p>
          )}

          <button
            onClick={fundFromMain}
            disabled={funding || !hasSufficientMain}
            className="btn-primary w-full text-sm disabled:opacity-40"
          >
            {funding ? 'enviando...' : `enviar ${totalNeeded.toFixed(4)} SOL`}
          </button>

          {/* Ou manual */}
          <div className="border-t border-surface-600 pt-2 space-y-1.5">
            <p className="text-xs text-gray-500">Ou envie manualmente para:</p>
            <div className="flex items-center gap-2 bg-surface-900 rounded-lg px-2 py-1.5">
              <span className="text-xs font-mono text-gray-300 flex-1 break-all">{value.publicKey}</span>
              <button
                onClick={() => navigator.clipboard.writeText(value.publicKey!)}
                className="text-brand text-xs shrink-0 hover:opacity-70"
              >
                copiar
              </button>
            </div>
          </div>

          {fundResult?.ok && (
            <p className="text-brand text-xs">
              Enviado com sucesso.{' '}
              {fundResult.sig && <span className="text-gray-400 font-mono">{fundResult.sig.slice(0, 12)}...</span>}
            </p>
          )}
          {fundResult?.error && <p className="text-danger text-xs">{fundResult.error}</p>}
        </div>
      )}
    </div>
  )
}
