import { Router, Request, Response } from 'express'
import { Keypair, PublicKey } from '@solana/web3.js'
import { getSDK, getCurrentPrice } from '../solana/pumpfun'
import { getConnection } from '../solana/connection'
import { wsClients } from '../server'
import { ActiveSession } from '../middleware/session'

export const monitorRouter = Router()

// Map de monitores ativos: mint → event listener ID
const activeMonitors = new Map<string, number>()

// Envia update de preco para todos os clientes WebSocket com esse session token
function broadcastPrice(sessionToken: string, mint: string, price: number) {
  const ws = wsClients.get(sessionToken)
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'price_update', mint, price }))
  }
}

// POST /api/monitor/start
// Body: { mint, buyPriceSol }
monitorRouter.post('/start', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const { mint } = req.body

  if (!mint) {
    res.status(400).json({ error: 'mint obrigatorio' })
    return
  }

  // Nao duplica monitor para o mesmo mint
  if (activeMonitors.has(mint)) {
    res.json({ ok: true, already: true })
    return
  }

  try {
    const owner = Keypair.fromSecretKey(session.privateKeyBytes)
    const sdk = getSDK(owner)
    const mintPubkey = new PublicKey(mint)

    // Preco inicial imediato
    const initialPrice = await getCurrentPrice(sdk, mintPubkey)

    // Escuta tradeEvents em tempo real
    const listenerId = sdk.addEventListener('tradeEvent', (event, _slot, _sig) => {
      if (event.mint.toBase58() !== mint) return
      if (event.virtualTokenReserves === 0n) return

      const price =
        Number(event.virtualSolReserves) /
        Number(event.virtualTokenReserves) /
        1e9

      broadcastPrice(session.token, mint, price)
    })

    activeMonitors.set(mint, listenerId)

    res.json({ ok: true, initialPrice })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro ao iniciar monitor' })
  }
})

// POST /api/monitor/stop
monitorRouter.post('/stop', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const { mint } = req.body

  if (!mint) {
    res.status(400).json({ error: 'mint obrigatorio' })
    return
  }

  const listenerId = activeMonitors.get(mint)
  if (listenerId !== undefined) {
    try {
      const owner = Keypair.fromSecretKey(session.privateKeyBytes)
      const sdk = getSDK(owner)
      sdk.removeEventListener(listenerId)
    } catch { /* ignora */ }
    activeMonitors.delete(mint)
  }

  res.json({ ok: true })
})
