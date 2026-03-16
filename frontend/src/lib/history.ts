export interface ClosedTrade {
  id: string
  mint: string
  name: string
  symbol: string
  openedAt: number
  closedAt: number
  totalSolInvested: number
  totalSolReceived: number
  pnlSol: number
  pnlPct: number
  wallets: Array<{ label: string; solInvested: number; solReceived: number }>
  devWalletPrivateKey?: string   // para claim de fees pos-fechamento
}

const KEY = 'pump_history'

export function loadHistory(): ClosedTrade[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

export function addToHistory(trade: Omit<ClosedTrade, 'id'>): void {
  const history = loadHistory()
  history.unshift({ id: crypto.randomUUID(), ...trade })
  // Mantem os ultimos 200
  localStorage.setItem(KEY, JSON.stringify(history.slice(0, 200)))
}

export function clearHistory(): void {
  localStorage.removeItem(KEY)
}
