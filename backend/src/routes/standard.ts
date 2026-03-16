import { Router, Request, Response } from 'express'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import FormData from 'form-data'
import { getConnection } from '../solana/connection'
import { ActiveSession } from '../middleware/session'
import { createStandardToken } from '../solana/standard-token'
import { createCpmmPool, removeCpmmLiquidity } from '../solana/raydium-cpmm'
import { createDammPool, removeDammLiquidity } from '../solana/meteora-damm'
import { jupiterSwapWithRetry, fundAndSwap, generateFreshKeypair } from '../solana/jupiter'

export const standardRouter = Router()

function keypairFromSession(req: Request): Keypair {
  const session = (req as any).session as ActiveSession
  return Keypair.fromSecretKey(Uint8Array.from(session.privateKeyBytes))
}

// ── Upload imagem + metadata para Pinata IPFS ─────────────────────────────────
// Nao requer session de wallet — so auth

standardRouter.post('/upload-metadata', async (req: Request, res: Response) => {
  try {
    const { imageBase64, mimeType, name, symbol, description } = req.body as {
      imageBase64: string
      mimeType: string
      name: string
      symbol: string
      description: string
    }

    if (!imageBase64 || !name || !symbol) {
      res.status(400).json({ error: 'imageBase64, name e symbol sao obrigatorios' })
      return
    }

    const jwt = process.env.PINATA_JWT
    if (!jwt) {
      res.status(500).json({ error: 'PINATA_JWT nao configurado. Adicione no Railway.' })
      return
    }

    const imageBuffer = Buffer.from(imageBase64, 'base64')

    // 1. Upload da imagem
    const imgForm = new FormData()
    imgForm.append('file', imageBuffer, {
      filename: `${symbol.toLowerCase()}.png`,
      contentType: mimeType || 'image/png',
    })
    imgForm.append('pinataMetadata', JSON.stringify({ name: `${symbol}-image` }))

    const imgRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...imgForm.getHeaders(),
      },
      // @ts-ignore — node-fetch aceita Buffer como body
      body: imgForm.getBuffer(),
    })

    if (!imgRes.ok) {
      const errText = await imgRes.text()
      throw new Error(`Pinata image upload falhou: ${errText}`)
    }

    const imgData = await imgRes.json() as { IpfsHash: string }
    const imageUri = `https://ipfs.io/ipfs/${imgData.IpfsHash}`

    // 2. Upload do metadata JSON
    const metadata = { name, symbol, description: description || '', image: imageUri }
    const metaRes = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pinataContent: metadata,
        pinataMetadata: { name: `${symbol}-metadata` },
      }),
    })

    if (!metaRes.ok) {
      const errText = await metaRes.text()
      throw new Error(`Pinata metadata upload falhou: ${errText}`)
    }

    const metaData = await metaRes.json() as { IpfsHash: string }
    const metadataUri = `https://ipfs.io/ipfs/${metaData.IpfsHash}`

    res.json({ metadataUri, imageUri })
  } catch (err) {
    console.error('[standard/upload-metadata]', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro desconhecido' })
  }
})

// ── Criar token SPL + metadata Metaplex ───────────────────────────────────────

standardRouter.post('/create-token', async (req: Request, res: Response) => {
  try {
    const keypair = keypairFromSession(req)
    const connection = getConnection()

    const {
      name,
      symbol,
      metadataUri,
      totalSupply,
      decimals,
      revokeMintAuthority,
      revokeFreezeAuthority,
    } = req.body as {
      name: string
      symbol: string
      metadataUri: string
      totalSupply: number
      decimals: number
      revokeMintAuthority: boolean
      revokeFreezeAuthority: boolean
    }

    const rawSupply = BigInt(Math.round(totalSupply)) * BigInt(10 ** decimals)

    const result = await createStandardToken({
      connection,
      payer: keypair,
      name,
      symbol,
      metadataUri,
      totalSupply: rawSupply,
      decimals,
      revokeMintAuthority,
      revokeFreezeAuthority,
    })

    res.json({
      mint: result.mint.toBase58(),
      ata: result.ata.toBase58(),
      txId: result.txId,
      rawSupply: rawSupply.toString(),
    })
  } catch (err) {
    console.error('[standard/create-token]', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro desconhecido' })
  }
})

// ── Criar pool de liquidez ────────────────────────────────────────────────────

standardRouter.post('/add-liquidity', async (req: Request, res: Response) => {
  try {
    const keypair = keypairFromSession(req)
    const connection = getConnection()

    const {
      platform,
      tokenMint,
      tokenDecimals,
      rawTokenAmount,
      solAmount,
      feeTier,
      openTime,
    } = req.body as {
      platform: 'raydium' | 'meteora'
      tokenMint: string
      tokenDecimals: number
      rawTokenAmount: string
      solAmount: number
      feeTier: string
      openTime: number
    }

    const mint = new PublicKey(tokenMint)
    const solLamports = BigInt(Math.round(solAmount * 1e9))
    const tokenAmountBig = BigInt(rawTokenAmount)

    if (platform === 'raydium') {
      const result = await createCpmmPool({
        connection,
        payer: keypair,
        tokenMint: mint,
        tokenDecimals,
        tokenAmount: tokenAmountBig,
        solLamports,
        feeTierLabel: feeTier,
        openTime,
      })
      res.json(result)
    } else {
      const result = await createDammPool({
        connection,
        payer: keypair,
        tokenMint: mint,
        tokenDecimals,
        tokenAmount: tokenAmountBig,
        solLamports,
        feeTierLabel: feeTier,
        openTime,
      })
      res.json(result)
    }
  } catch (err) {
    console.error('[standard/add-liquidity]', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro desconhecido' })
  }
})

// ── Remover liquidez ──────────────────────────────────────────────────────────

standardRouter.post('/remove-liquidity', async (req: Request, res: Response) => {
  try {
    const keypair = keypairFromSession(req)
    const connection = getConnection()

    const { platform, poolAddress, lpMint } = req.body as {
      platform: 'raydium' | 'meteora'
      poolAddress: string
      lpMint: string
    }

    let txId: string

    if (platform === 'raydium') {
      txId = await removeCpmmLiquidity({ connection, payer: keypair, poolId: poolAddress, lpMint })
    } else {
      txId = await removeDammLiquidity({ connection, payer: keypair, poolAddress })
    }

    res.json({ txId })
  } catch (err) {
    console.error('[standard/remove-liquidity]', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro desconhecido' })
  }
})

// ── Snipe — swap SOL → token logo após criar a pool ──────────────────────────
// Dev wallet (main ou fresh) + até 5 bundle wallets
// Usa Jupiter com retry automático (pool pode demorar ~30-60s pra indexar)

standardRouter.post('/snipe', async (req: Request, res: Response) => {
  try {
    const keypair = keypairFromSession(req)
    const connection = getConnection()

    const {
      tokenMint,
      devBuySol,       // número — 0 = sem compra na dev wallet
      useFreshWallet,  // boolean
      bundleWallets,   // Array<{ privateKeyBase58: string; buyAmountSol: number }>
      slippageBps,     // número, default 500 (5%)
    } = req.body as {
      tokenMint: string
      devBuySol: number
      useFreshWallet: boolean
      bundleWallets: Array<{ privateKeyBase58: string; buyAmountSol: number }>
      slippageBps: number
    }

    const slippage = slippageBps ?? 500
    const results: Array<{ wallet: string; txId: string; type: string }> = []
    let freshWalletKey: string | undefined

    // Dev buy
    if (devBuySol > 0) {
      const buyLamports = Math.round(devBuySol * 1e9)

      if (useFreshWallet) {
        const { keypair: fresh, privateKeyBase58 } = generateFreshKeypair()
        freshWalletKey = privateKeyBase58
        const { fundTxId, swapTxId } = await fundAndSwap(
          connection, keypair, fresh, tokenMint, buyLamports, slippage,
        )
        console.log(`[snipe] fresh wallet funded: ${fundTxId}, swapped: ${swapTxId}`)
        results.push({ wallet: fresh.publicKey.toBase58(), txId: swapTxId, type: 'dev-fresh' })
      } else {
        const txId = await jupiterSwapWithRetry(connection, keypair, tokenMint, buyLamports, slippage)
        results.push({ wallet: keypair.publicKey.toBase58(), txId, type: 'dev-main' })
      }
    }

    // Bundle buys
    for (const bw of bundleWallets ?? []) {
      if (!bw.buyAmountSol || bw.buyAmountSol <= 0) continue
      const bwKeypair = Keypair.fromSecretKey(bs58.decode(bw.privateKeyBase58))
      const buyLamports = Math.round(bw.buyAmountSol * 1e9)
      const { fundTxId, swapTxId } = await fundAndSwap(
        connection, keypair, bwKeypair, tokenMint, buyLamports, slippage,
      )
      console.log(`[snipe] bundle ${bwKeypair.publicKey.toBase58()} funded: ${fundTxId}, swapped: ${swapTxId}`)
      results.push({ wallet: bwKeypair.publicKey.toBase58(), txId: swapTxId, type: 'bundle' })
    }

    res.json({ results, freshWalletKey })
  } catch (err) {
    console.error('[standard/snipe]', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro desconhecido' })
  }
})
