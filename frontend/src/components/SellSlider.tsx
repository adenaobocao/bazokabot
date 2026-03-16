import { useState } from 'react'

interface Props {
  onSell: (percentage: number) => Promise<void>
  loading?: boolean
  label?: string
  compact?: boolean
}

export default function SellSlider({ onSell, loading = false, label, compact = false }: Props) {
  const [pct, setPct] = useState(100)
  const [confirming, setConfirming] = useState(false)

  async function handleSell() {
    if (pct === 100 && !confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 3000)
      return
    }
    setConfirming(false)
    await onSell(pct)
  }

  const trackColor = pct >= 80
    ? 'from-danger/80 to-danger'
    : pct >= 50
    ? 'from-warning/80 to-warning'
    : 'from-brand/60 to-brand'

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {[25, 50, 75, 100].map(q => (
          <button
            key={q}
            onClick={() => onSell(q)}
            disabled={loading}
            className={`flex-1 py-1 rounded text-xs font-semibold transition-colors disabled:opacity-40
              ${q === 100 ? 'bg-danger/20 text-danger hover:bg-danger/40 border border-danger/40'
                         : 'bg-surface-700 text-gray-300 hover:text-white hover:bg-surface-600'}`}
          >
            {loading ? '...' : `${q}%`}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {label && <p className="text-xs text-gray-400">{label}</p>}

      {/* Quick buttons */}
      <div className="flex gap-1.5">
        {[25, 50, 75, 100].map(q => (
          <button
            key={q}
            onClick={() => setPct(q)}
            className={`flex-1 py-1 rounded text-xs font-semibold transition-colors
              ${pct === q
                ? q === 100 ? 'bg-danger text-white' : 'bg-brand text-black'
                : 'bg-surface-700 text-gray-400 hover:text-white'}`}
          >
            {q}%
          </button>
        ))}
      </div>

      {/* Slider */}
      <div className="relative">
        <div className="relative h-1.5 bg-surface-600 rounded-full overflow-hidden">
          <div
            className={`h-full bg-gradient-to-r ${trackColor} transition-all`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={1}
          max={100}
          value={pct}
          onChange={e => setPct(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-1.5"
        />
      </div>

      <div className="flex items-center justify-between">
        <span className={`text-sm font-bold font-mono ${pct >= 80 ? 'text-danger' : pct >= 50 ? 'text-warning' : 'text-brand'}`}>
          {pct}%
        </span>
        <button
          onClick={handleSell}
          disabled={loading}
          className={`px-4 py-1.5 rounded text-xs font-semibold transition-all disabled:opacity-40
            ${confirming
              ? 'bg-danger text-white animate-pulse'
              : pct === 100
              ? 'bg-danger/20 text-danger border border-danger/50 hover:bg-danger hover:text-white'
              : 'btn-ghost'}`}
        >
          {loading ? 'vendendo...' : confirming ? 'confirmar venda 100%' : `vender ${pct}%`}
        </button>
      </div>
    </div>
  )
}
