import { Router } from 'express'
import { Connection } from '@solana/web3.js'
import dotenv from 'dotenv'

dotenv.config()

export const healthRouter = Router()

healthRouter.get('/', async (_req, res) => {
  let rpcStatus = 'offline'
  let blockHeight: number | null = null

  try {
    const connection = new Connection(
      process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
      'confirmed'
    )
    blockHeight = await connection.getBlockHeight()
    rpcStatus = 'online'
  } catch {
    rpcStatus = 'offline'
  }

  res.json({
    status: 'ok',
    rpc: rpcStatus,
    blockHeight,
    timestamp: new Date().toISOString(),
  })
})
