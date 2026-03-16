import { useState, useEffect } from 'react'
import { saveBundleWallet, loadBundleWallets, removeBundleWallet, BundleStoredWallet } from '../lib/crypto'
import { api } from '../lib/api'
import WalletCard from './WalletCard'
import Tooltip from './Tooltip'

export interface BundleWallet {
  publicKey: string
  label: string
  privateKeyBase58: string
  buySol: number
  solBalance: number
}

interface Props {
  wallets: BundleWallet[]
  onChange: (wallets: BundleWallet[]) => void
  mainPublicKey?: string
  mainBalance?: number
  devWalletPublicKey?: string
  devWalletBalance?: number
  devWalletPrivateKey?: string
  onMainBalanceRefresh?: () => void
}

type FundSource = 'main' | 'dev'

export default function BundleManager({
  wallets, onChange,
  mainPublicKey, mainBalance,
  devWalletPublicKey, devWalletBalance, devWalletPrivateKey,
  onMainBalanceRefresh,
}: Props) {
  const [savedBundles, setSavedBundles] = useState<BundleStoredWallet[]>([])
  const [funding, setFunding] = useState(false)
  const [fundErrors, setFundErrors] = useState<Record<string, string>>({})
  const [fundSuccess, setFundSuccess] = useState(0)
  const [fundSource, setFundSource] = useState<FundSource>('main')

  // dev wallet diferente da principal?
  const hasDevWallet = devWalletPublicKey && devWalletPublicKey !== mainPublicKey

  useEffect(() => {
    if (!mainPublicKey) return
    const filtered = loadBundleWallets(mainPublicKey).filter(
      w => w.publicKey !== devWalletPublicKey
    )
    setSavedBundles(filtered)
  }, [mainPublicKey, devWalletPublicKey])

  async function addNew() {
    if (wallets.length >= 5 || !mainPublicKey) return
    const res = await api.post<{ publicKey: string; privateKeyBase58: string }>('/wallet/generate')
    const label = `Bundle ${loadBundleWallets(mainPublicKey).length + 1}`
    saveBundleWallet({ label, publicKey: res.publicKey, privateKeyBase58: res.privateKeyBase58 }, mainPublicKey)
    setSavedBundles(loadBundleWallets(mainPublicKey).filter(
      w => w.publicKey !== devWalletPublicKey
    ))
    onChange([...wallets, {
      publicKey: res.publicKey,
      label,
      privateKeyBase58: res.privateKeyBase58,
      buySol: 0.5,
      solBalance: 0,
    }])
  }

  function addSaved(saved: BundleStoredWallet) {
    if (wallets.find(w => w.publicKey === saved.publicKey) || wallets.length >= 5) return
    onChange([...wallets, {
      publicKey: saved.publicKey,
      label: saved.label,
      privateKeyBase58: saved.privateKeyBase58,
      buySol: 0.5,
      solBalance: 0,
    }])
  }

  function remove(pubkey: string) {
    onChange(wallets.filter(w => w.publicKey !== pubkey))
  }

  function deleteSaved(pubkey: string) {
    if (!mainPublicKey) return
    removeBundleWallet(pubkey, mainPublicKey)
    setSavedBundles(loadBundleWallets(mainPublicKey).filter(
      w => w.publicKey !== devWalletPublicKey
    ))
    onChange(wallets.filter(w => w.publicKey !== pubkey))
  }

  async function refreshBalances() {
    if (wallets.length === 0) return
    const res = await api.get<{ balances: Array<{ address: string; sol: number }> }>(
      `/wallet/balances?addresses=${wallets.map(w => w.publicKey).join(',')}`
    )
    onChange(wallets.map(w => {
      const found = res.balances.find(b => b.address === w.publicKey)
      return found ? { ...w, solBalance: found.sol } : w
    }))
  }

  async function fundAll() {
    const toFund = wallets.filter(w => w.buySol > 0)
    if (toFund.length === 0) return
    setFunding(true)
    setFundErrors({})
    setFundSuccess(0)
    try {
      const payload: Record<string, unknown> = {
        targets: toFund.map(w => ({ publicKey: w.publicKey, amountSol: w.buySol + 0.005 })),
      }
      // Se financiar da dev wallet, passa a PK dela para o backend usar como remetente
      if (fundSource === 'dev' && devWalletPrivateKey) {
        payload.sourcePrivateKey = devWalletPrivateKey
      }
      const res = await api.post<{ results: Array<{ publicKey: string; success: boolean; error?: string }> }>(
        '/wallet/fund-bundles', payload
      )
      const errors: Record<string, string> = {}
      let ok = 0
      for (const r of res.results) {
        if (!r.success) errors[r.publicKey] = r.error || 'Erro'
        else ok++
      }
      setFundErrors(errors)
      setFundSuccess(ok)
      await refreshBalances()
      if (ok > 0) onMainBalanceRefresh?.()
    } catch (err: unknown) {
      setFundErrors({ _global: err instanceof Error ? err.message : 'Erro ao financiar' })
    } finally {
      setFunding(false)
    }
  }

  function updateBuySol(pubkey: string, v: number) {
    onChange(wallets.map(w => w.publicKey === pubkey ? { ...w, buySol: v } : w))
  }

  const totalBuy = wallets.reduce((s, w) => s + w.buySol, 0)
  const totalNeeded = totalBuy + wallets.length * 0.005
  const available = savedBundles.filter(s => !wallets.find(w => w.publicKey === s.publicKey))

  const sourceBalance = fundSource === 'main' ? mainBalance : devWalletBalance
  const sourcePubkey = fundSource === 'main' ? mainPublicKey : devWalletPublicKey
  const hasSufficientFunds = sourceBalance !== undefined && sourceBalance >= totalNeeded

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold text-gray-300">
            Bundle ({wallets.length}/5)
          </span>
          {totalBuy > 0 && (
            <span className="text-gray-500 text-xs">{totalBuy.toFixed(2)} SOL total</span>
          )}
          <Tooltip text="Wallets que compram o token no mesmo bloco do deploy via Jito. Cria pressao de compra inicial. As private keys ficam armazenadas localmente no seu browser.">
            <span className="w-4 h-4 rounded-full bg-surface-700 text-gray-500 text-xs flex items-center justify-center cursor-default">?</span>
          </Tooltip>
        </div>
        <div className="flex gap-2">
          {wallets.length > 0 && (
            <button onClick={refreshBalances} className="btn-ghost text-xs px-2 py-1">
              atualizar saldos
            </button>
          )}
          {wallets.length < 5 && (
            <button onClick={addNew} className="btn-primary text-xs px-3 py-1">
              + nova wallet
            </button>
          )}
        </div>
      </div>

      {/* Wallets salvas disponíveis */}
      {available.length > 0 && wallets.length < 5 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-gray-500 self-center">salvas:</span>
          {available.map(s => (
            <button key={s.publicKey} onClick={() => addSaved(s)} className="btn-ghost text-xs px-2 py-1">
              + {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Lista de wallets ativas */}
      {wallets.map(w => (
        <div key={w.publicKey} className="space-y-2">
          <WalletCard
            publicKey={w.publicKey}
            label={w.label}
            balance={w.solBalance || undefined}
            badge={w.solBalance > 0 && w.solBalance < w.buySol ? 'saldo insuficiente' : undefined}
            badgeColor="danger"
            privateKey={w.privateKeyBase58}
            onRemove={() => remove(w.publicKey)}
          />

          {/* Buy amount */}
          <div className="flex items-center gap-2 pl-1">
            <label className="text-xs text-gray-500 whitespace-nowrap">Buy (SOL)</label>
            <input
              type="number" value={w.buySol} min="0" step="0.1"
              onChange={e => updateBuySol(w.publicKey, parseFloat(e.target.value) || 0)}
              className="w-20 text-xs"
            />
            <div className="flex gap-1">
              {[0.1, 0.5, 1, 2].map(v => (
                <button key={v} onClick={() => updateBuySol(w.publicKey, v)}
                  className={`text-xs px-1.5 py-0.5 rounded transition-colors
                    ${w.buySol === v ? 'bg-brand text-black' : 'bg-surface-700 text-gray-400 hover:text-white'}`}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          {fundErrors[w.publicKey] && (
            <p className="text-danger text-xs pl-1">{fundErrors[w.publicKey]}</p>
          )}
        </div>
      ))}

      {/* Painel de financiamento */}
      {wallets.length > 0 && (
        <div className="border border-surface-600 rounded-xl p-3 space-y-3 bg-surface-800/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-300">Financiar bundle wallets</span>
            <span className="text-xs text-gray-500 font-mono">
              total: <span className="text-white font-semibold">{totalNeeded.toFixed(4)} SOL</span>
              <span className="text-gray-600 ml-1">(+0.005 gas/wallet)</span>
            </span>
          </div>

          {/* Seletor de fonte */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">Financiar de:</span>
              <Tooltip text="Escolha qual wallet enviara o SOL para as bundle wallets.">
                <span className="w-4 h-4 rounded-full bg-surface-700 text-gray-500 text-xs flex items-center justify-center cursor-default">?</span>
              </Tooltip>
            </div>
            <div className="flex gap-2">
              {/* Opção: principal */}
              <button
                onClick={() => setFundSource('main')}
                className={`flex-1 rounded-lg border p-2 text-left transition-colors ${
                  fundSource === 'main'
                    ? 'border-brand bg-brand/5'
                    : 'border-surface-600 hover:border-surface-500'
                }`}
              >
                <p className="text-xs font-semibold">Wallet Principal</p>
                <p className="text-xs text-gray-500 font-mono mt-0.5">
                  {mainPublicKey ? `${mainPublicKey.slice(0,6)}...${mainPublicKey.slice(-4)}` : '—'}
                </p>
                {mainBalance !== undefined && (
                  <p className={`text-xs font-semibold mt-0.5 ${mainBalance >= totalNeeded ? 'text-brand' : 'text-danger'}`}>
                    {mainBalance.toFixed(4)} SOL
                  </p>
                )}
              </button>

              {/* Opção: dev wallet (só se diferente da principal) */}
              {hasDevWallet ? (
                <button
                  onClick={() => setFundSource('dev')}
                  disabled={!devWalletPrivateKey}
                  className={`flex-1 rounded-lg border p-2 text-left transition-colors disabled:opacity-40 ${
                    fundSource === 'dev'
                      ? 'border-brand bg-brand/5'
                      : 'border-surface-600 hover:border-surface-500'
                  }`}
                >
                  <p className="text-xs font-semibold">Dev Wallet</p>
                  <p className="text-xs text-gray-500 font-mono mt-0.5">
                    {devWalletPublicKey ? `${devWalletPublicKey.slice(0,6)}...${devWalletPublicKey.slice(-4)}` : '—'}
                  </p>
                  {devWalletBalance !== undefined && (
                    <p className={`text-xs font-semibold mt-0.5 ${devWalletBalance >= totalNeeded ? 'text-brand' : 'text-danger'}`}>
                      {devWalletBalance.toFixed(4)} SOL
                    </p>
                  )}
                </button>
              ) : (
                <div className="flex-1 rounded-lg border border-surface-700 p-2 opacity-40">
                  <p className="text-xs font-semibold text-gray-500">Dev Wallet</p>
                  <p className="text-xs text-gray-600 mt-0.5">mesma que a principal</p>
                </div>
              )}
            </div>
          </div>

          {/* Alerta de saldo */}
          {sourceBalance !== undefined && !hasSufficientFunds && (
            <p className="text-warning text-xs">
              Saldo insuficiente em {fundSource === 'main' ? 'wallet principal' : 'dev wallet'}.
              Faltam {Math.max(0, totalNeeded - sourceBalance).toFixed(4)} SOL.
            </p>
          )}

          {sourcePubkey && (
            <p className="text-xs text-gray-600">
              Origem: <span className="font-mono text-gray-500">{sourcePubkey.slice(0,8)}...{sourcePubkey.slice(-8)}</span>
            </p>
          )}

          <button
            onClick={fundAll}
            disabled={funding}
            className="btn-primary w-full text-sm disabled:opacity-40"
          >
            {funding ? 'enviando...' : `financiar ${wallets.length} wallet${wallets.length > 1 ? 's' : ''}`}
          </button>

          {fundSuccess > 0 && Object.keys(fundErrors).filter(k => k !== '_global').length === 0 && (
            <p className="text-brand text-xs">
              {fundSuccess === wallets.length
                ? `Todas as ${fundSuccess} wallets financiadas com sucesso.`
                : `${fundSuccess} de ${wallets.length} wallets financiadas.`}{' '}
              Saldos atualizados acima.
            </p>
          )}
          {fundErrors._global && <p className="text-danger text-xs">{fundErrors._global}</p>}
        </div>
      )}

      {/* Wallets salvas (gerenciar) */}
      {savedBundles.length > 0 && (
        <details className="text-xs">
          <summary className="text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">
            wallets bundle salvas ({savedBundles.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {savedBundles.map(s => (
              <div key={s.publicKey} className="flex items-center justify-between bg-surface-700 rounded-lg px-2.5 py-2">
                <div>
                  <span className="text-gray-300">{s.label}</span>
                  <span className="text-gray-600 ml-2 font-mono">{s.publicKey.slice(0, 6)}...{s.publicKey.slice(-4)}</span>
                </div>
                <div className="flex gap-2">
                  {!wallets.find(w => w.publicKey === s.publicKey) && wallets.length < 5 && (
                    <button onClick={() => addSaved(s)} className="text-brand hover:opacity-70">+ add</button>
                  )}
                  <button onClick={() => deleteSaved(s.publicKey)} className="text-danger hover:opacity-70">del</button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
