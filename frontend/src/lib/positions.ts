// Posicoes abertas salvas no localStorage do browser
// Estrutura persiste mesmo se o servidor reiniciar

export interface BundleWalletEntry {
  publicKey: string
  privateKeyBase58: string
  label: string
  buySol: number
  tokenAmount: string   // bigint como string
  buyPriceSol: number
}

export interface Position {
  mint: string
  name: string
  symbol: string
  openedAt: number
  devBuySol: number
  devTokenAmount: string
  devBuyPriceSol: number
  devWalletPublicKey?: string       // se foi fresh wallet
  devWalletPrivateKey?: string      // se foi fresh wallet
  bundleWallets: BundleWalletEntry[]
  totalSolSpent: number
  signature?: string
  bundleId?: string
}

const STORAGE_KEY = 'pump_positions'

export function loadPositions(): Position[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

export function savePosition(position: Position): void {
  const positions = loadPositions()
  const idx = positions.findIndex(p => p.mint === position.mint)
  if (idx >= 0) {
    positions[idx] = position
  } else {
    positions.unshift(position)
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(positions))
}

export function removePosition(mint: string): void {
  const positions = loadPositions().filter(p => p.mint !== mint)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(positions))
}

export function calcPNL(
  tokenAmount: string,
  buyPriceSol: number,
  currentPriceSol: number
): { pnlSol: number; pnlPct: number; currentValueSol: number } {
  const amount = Number(BigInt(tokenAmount)) / 1e6
  const invested = amount * buyPriceSol
  const currentValue = amount * currentPriceSol
  const pnlSol = currentValue - invested
  const pnlPct = invested > 0 ? (pnlSol / invested) * 100 : 0
  return { pnlSol, pnlPct, currentValueSol: currentValue }
}
