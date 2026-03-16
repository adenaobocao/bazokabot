import { useState } from 'react'

interface Props {
  publicKey: string
  label: string
  balance?: number
  badge?: string
  badgeColor?: 'brand' | 'warning' | 'gray' | 'danger'
  privateKey?: string
  onRemove?: () => void
  onRefreshBalance?: () => void
  className?: string
  children?: React.ReactNode // slot para acoes extras no rodape
}

function walletAvatar(pubkey: string): { bg: string; fg: string; initials: string } {
  const n = parseInt(pubkey.slice(0, 6), 16) || 0
  const hue = n % 360
  return {
    bg: `hsl(${hue}, 50%, 22%)`,
    fg: `hsl(${hue}, 70%, 65%)`,
    initials: pubkey.slice(0, 2).toUpperCase(),
  }
}

const BADGE_CLASSES: Record<string, string> = {
  brand:   'bg-brand/15 text-brand border border-brand/30',
  warning: 'bg-warning/15 text-warning border border-warning/30',
  gray:    'bg-surface-700 text-gray-400 border border-surface-600',
  danger:  'bg-danger/15 text-danger border border-danger/30',
}

export default function WalletCard({
  publicKey, label, balance, badge, badgeColor = 'gray',
  privateKey, onRemove, onRefreshBalance, className = '', children,
}: Props) {
  const [showKey, setShowKey] = useState(false)
  const [copiedAddr, setCopiedAddr] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const avatar = walletAvatar(publicKey)

  function copyAddr() {
    navigator.clipboard.writeText(publicKey)
    setCopiedAddr(true)
    setTimeout(() => setCopiedAddr(false), 2000)
  }

  function copyKey() {
    if (!privateKey) return
    navigator.clipboard.writeText(privateKey)
    setCopiedKey(true)
    setTimeout(() => setCopiedKey(false), 2000)
  }

  return (
    <div className={`border border-surface-600 rounded-xl p-3 space-y-2.5 ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-2.5">
        {/* Avatar */}
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 select-none"
          style={{ background: avatar.bg, color: avatar.fg }}
        >
          {avatar.initials}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold leading-tight">{label}</span>
            {badge && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full leading-none ${BADGE_CLASSES[badgeColor]}`}>
                {badge}
              </span>
            )}
          </div>
          <button
            onClick={copyAddr}
            className="text-xs text-gray-500 font-mono hover:text-gray-300 transition-colors text-left"
            title="Clique para copiar endereco"
          >
            {copiedAddr ? 'copiado!' : `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`}
          </button>
        </div>

        {/* Saldo */}
        <div className="text-right shrink-0">
          {balance === undefined ? (
            <button onClick={onRefreshBalance} className="text-xs text-gray-600 hover:text-gray-400 transition-colors">
              ver saldo
            </button>
          ) : balance < 0 ? (
            <span className="text-xs text-gray-600">erro</span>
          ) : (
            <div className="flex items-center gap-1">
              <span className={`text-sm font-semibold ${balance === 0 ? 'text-gray-500' : 'text-white'}`}>
                {balance.toFixed(3)}
              </span>
              <span className="text-xs text-gray-500">SOL</span>
              {onRefreshBalance && (
                <button onClick={onRefreshBalance} className="text-gray-600 hover:text-gray-400 ml-0.5 transition-colors" title="Atualizar saldo">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M1 4v6h6M23 20v-6h-6"/>
                    <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Private key (expandida) */}
      {privateKey && showKey && (
        <div className="bg-surface-900 border border-warning/25 rounded-lg p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-warning text-xs font-semibold">Private Key — salve antes de fechar</span>
            <button onClick={() => setShowKey(false)} className="text-gray-600 hover:text-gray-400 text-xs">fechar</button>
          </div>
          <p className="text-xs font-mono break-all text-gray-300 select-all leading-relaxed">{privateKey}</p>
          <button onClick={copyKey} className="flex items-center gap-1.5 text-xs text-brand hover:opacity-75 transition-opacity">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
            {copiedKey ? 'copiado!' : 'copiar private key'}
          </button>
        </div>
      )}

      {/* Rodape: acoes */}
      <div className="flex items-center gap-2 flex-wrap">
        {privateKey && !showKey && (
          <button
            onClick={() => setShowKey(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-warning transition-colors px-1.5 py-0.5 rounded hover:bg-warning/10"
            title="Revelar private key"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>
            </svg>
            ver key
          </button>
        )}
        {onRemove && (
          <button
            onClick={onRemove}
            className="text-xs text-gray-600 hover:text-danger transition-colors px-1.5 py-0.5 rounded hover:bg-danger/10 ml-auto"
          >
            remover
          </button>
        )}
        {children}
      </div>
    </div>
  )
}
