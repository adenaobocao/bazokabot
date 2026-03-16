import { Router } from 'express'
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import bs58 from 'bs58'
import crypto from 'crypto'
import { sessions, ActiveSession } from '../middleware/session'
import { getConnection } from '../solana/connection'

export const walletRouter = Router()

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

// POST /api/wallet/session
walletRouter.post('/session', (req, res) => {
  const { privateKeyBase58 } = req.body
  if (!privateKeyBase58 || typeof privateKeyBase58 !== 'string') {
    res.status(400).json({ error: 'privateKeyBase58 obrigatorio' })
    return
  }
  let keypair: Keypair
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58))
  } catch {
    res.status(400).json({ error: 'Private key invalida' })
    return
  }
  const token = generateSessionToken()
  sessions.set(token, {
    token,
    walletPublicKey: keypair.publicKey.toBase58(),
    privateKeyBytes: new Uint8Array(keypair.secretKey),
    createdAt: Date.now(),
  })
  res.json({ token, publicKey: keypair.publicKey.toBase58() })
})

// DELETE /api/wallet/session
walletRouter.delete('/session', (req, res) => {
  const token = req.headers['x-session-token'] as string | undefined
  if (token) {
    const session = sessions.get(token)
    if (session) {
      session.privateKeyBytes.fill(0)
      sessions.delete(token)
    }
  }
  res.json({ ok: true })
})

// POST /api/wallet/generate
walletRouter.post('/generate', (_req, res) => {
  const keypair = Keypair.generate()
  res.json({
    publicKey: keypair.publicKey.toBase58(),
    privateKeyBase58: bs58.encode(keypair.secretKey),
  })
})

// GET /api/wallet/balances?addresses=addr1,addr2,...
// Retorna saldo SOL de multiplas wallets de uma vez
walletRouter.get('/balances', async (req, res) => {
  const { addresses } = req.query
  if (!addresses || typeof addresses !== 'string') {
    res.status(400).json({ error: 'addresses obrigatorio' })
    return
  }
  const addrs = addresses.split(',').filter(Boolean).slice(0, 10)
  const connection = getConnection()
  try {
    const pubkeys = addrs.map(a => new PublicKey(a))
    const balances = await Promise.all(
      pubkeys.map(async (pk) => {
        try {
          const lamports = await connection.getBalance(pk, 'confirmed')
          return { address: pk.toBase58(), sol: lamports / LAMPORTS_PER_SOL }
        } catch {
          return { address: pk.toBase58(), sol: 0 }
        }
      })
    )
    res.json({ balances })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro' })
  }
})

// POST /api/wallet/fund-bundles
// Transfere SOL da wallet da sessao (ou de uma sourcePrivateKey opcional) para wallets de bundle
// Body: { targets: Array<{ publicKey: string, amountSol: number }>, sourcePrivateKey?: string }
walletRouter.post('/fund-bundles', async (req, res) => {
  const session = (req as any).session as ActiveSession
  const { targets, sourcePrivateKey } = req.body

  if (!Array.isArray(targets) || targets.length === 0) {
    res.status(400).json({ error: 'targets obrigatorio' })
    return
  }

  const connection = getConnection()
  let payer: Keypair
  if (sourcePrivateKey && typeof sourcePrivateKey === 'string') {
    try {
      payer = Keypair.fromSecretKey(bs58.decode(sourcePrivateKey))
    } catch {
      res.status(400).json({ error: 'sourcePrivateKey invalida' })
      return
    }
  } else {
    payer = Keypair.fromSecretKey(session.privateKeyBytes)
  }
  const results: Array<{ publicKey: string; success: boolean; signature?: string; error?: string }> = []

  for (const { publicKey, amountSol } of targets) {
    if (!publicKey || !amountSol || amountSol <= 0) {
      results.push({ publicKey, success: false, error: 'Dados invalidos' })
      continue
    }
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: new PublicKey(publicKey),
          lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
        })
      )
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: 'confirmed',
      })
      results.push({ publicKey, success: true, signature: sig })
    } catch (err: unknown) {
      results.push({
        publicKey,
        success: false,
        error: err instanceof Error ? err.message : 'Erro na transferencia',
      })
    }
  }

  res.json({ results })
})

// POST /api/wallet/sweep
// Varre todo SOL de wallets de bundle de volta para a wallet da sessao
// Body: { fromPrivateKeys: string[] }
walletRouter.post('/sweep', async (req, res) => {
  const session = (req as any).session as ActiveSession
  const { fromPrivateKeys } = req.body

  if (!Array.isArray(fromPrivateKeys) || fromPrivateKeys.length === 0) {
    res.status(400).json({ error: 'fromPrivateKeys obrigatorio' })
    return
  }

  const connection = getConnection()
  const destination = Keypair.fromSecretKey(session.privateKeyBytes).publicKey
  const TX_FEE_LAMPORTS = 5000
  const results: Array<{ publicKey: string; success: boolean; solSwept?: number; signature?: string; error?: string }> = []

  for (const pk of fromPrivateKeys) {
    let from: Keypair
    try {
      from = Keypair.fromSecretKey(bs58.decode(pk))
    } catch {
      results.push({ publicKey: 'invalida', success: false, error: 'Private key invalida' })
      continue
    }

    try {
      const balance = await connection.getBalance(from.publicKey, 'confirmed')
      const sendLamports = balance - TX_FEE_LAMPORTS
      if (sendLamports <= 0) {
        results.push({ publicKey: from.publicKey.toBase58(), success: false, error: 'Saldo insuficiente' })
        continue
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: from.publicKey,
          toPubkey: destination,
          lamports: sendLamports,
        })
      )
      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.feePayer = from.publicKey
      const sig = await sendAndConfirmTransaction(connection, tx, [from], { commitment: 'confirmed' })
      results.push({
        publicKey: from.publicKey.toBase58(),
        success: true,
        solSwept: sendLamports / LAMPORTS_PER_SOL,
        signature: sig,
      })
    } catch (err: unknown) {
      results.push({
        publicKey: from.publicKey.toBase58(),
        success: false,
        error: err instanceof Error ? err.message : 'Erro no sweep',
      })
    }
  }

  res.json({ results })
})
