export interface LpPosition {
  id: string
  mint: string
  name: string
  symbol: string
  decimals: number
  platform: 'raydium' | 'meteora'
  poolAddress: string
  lpMint: string
  tokenAdded: string   // raw amount as string
  solAdded: number
  feeTier: string
  scheduledOpenTime?: number // unix ts, undefined = immediate
  createdAt: number
}

const KEY = 'lp_positions'

export function loadLpPositions(): LpPosition[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

export function saveLpPosition(pos: LpPosition): void {
  const all = loadLpPositions()
  const idx = all.findIndex(p => p.id === pos.id)
  if (idx >= 0) all[idx] = pos
  else all.push(pos)
  localStorage.setItem(KEY, JSON.stringify(all))
}

export function removeLpPosition(id: string): void {
  const all = loadLpPositions().filter(p => p.id !== id)
  localStorage.setItem(KEY, JSON.stringify(all))
}
