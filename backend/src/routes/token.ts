import { Router, Request, Response } from 'express'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  getSDK,
  getTokenBalance,
  getCurrentPrice,
  buildCreateTx,
  buildBuyTx,
  buildSellTx,
  buildWithdrawTx,
  getCreatorVaultBalance,
  deploySequential,
  sellByPercentage,
  uploadMetadataToPumpFun,
} from '../solana/pumpfun'
import { grindMintKeypair } from '../solana/grindKeypair'
import {
  sendJitoBundle,
  buildJitoTipTx,
  serializeTx,
  sendSequential,
  FeeLevel,
  SLIPPAGE,
  PRIORITY_FEES,
} from '../solana/jito'
import { getConnection } from '../solana/connection'
import { ActiveSession } from '../middleware/session'

export const tokenRouter = Router()

// POST /api/token/upload-image
// Recebe imagem base64 + metadata, faz upload pro pump.fun IPFS
tokenRouter.post('/upload-image', async (req: Request, res: Response) => {
  const { imageBase64, mimeType, name, symbol, description, twitter, telegram, website } = req.body

  if (!imageBase64 || !name || !symbol) {
    res.status(400).json({ error: 'imageBase64, name e symbol sao obrigatorios' })
    return
  }

  try {
    const imageBuffer = Buffer.from(imageBase64, 'base64')
    const metadataUri = await uploadMetadataToPumpFun({
      imageBuffer,
      mimeType: mimeType || 'image/png',
      name,
      symbol,
      description: description || '',
      twitter,
      telegram,
      website,
    })
    res.json({ metadataUri })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro no upload' })
  }
})

// POST /api/token/deploy
// Body: { metadataUri, name, symbol, devBuySol, feeLevel, mayhemMode, bundleWallets, useJito }
tokenRouter.post('/deploy', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const {
    metadataUri,
    name,
    symbol,
    devBuySol = 0,
    feeLevel = 'fast',
    bundleWallets = [],
    useJito = true,
    devWalletPrivateKey,   // opcional: se presente, usa fresh wallet como dev
    grindMint = false,     // se true, gera mint com sufixo "pump" (lento, usa CPU)
  } = req.body

  if (!metadataUri || !name || !symbol) {
    res.status(400).json({ error: 'metadataUri, name e symbol sao obrigatorios' })
    return
  }

  const connection = getConnection()

  // Se devWalletPrivateKey fornecida, o deploy e feito pela fresh wallet
  // O token e criado por ela e o dev buy tambem — desvincula da wallet principal
  let creator: Keypair
  if (devWalletPrivateKey) {
    try {
      creator = Keypair.fromSecretKey(bs58.decode(devWalletPrivateKey))
    } catch {
      res.status(400).json({ error: 'devWalletPrivateKey invalida' })
      return
    }
  } else {
    creator = Keypair.fromSecretKey(session.privateKeyBytes)
  }

  // Gera mint keypair — com sufixo "pump" (vanity, lento) ou aleatório (instantaneo)
  const mintKeypair = grindMint
    ? await grindMintKeypair('pump', 120_000)
    : Keypair.generate()
  console.log(`[deploy] Mint gerado: ${mintKeypair.publicKey.toBase58()} (grind=${grindMint})`)
  const fee = feeLevel as FeeLevel

  // Decodifica wallets de bundle (enviadas pelo frontend ja decriptadas)
  const bundleKeypairs: Array<{ keypair: Keypair; buySol: number }> = []
  for (const w of bundleWallets) {
    try {
      const kp = Keypair.fromSecretKey(bs58.decode(w.privateKeyBase58))
      bundleKeypairs.push({ keypair: kp, buySol: w.buySol || 0 })
    } catch {
      res.status(400).json({ error: `Wallet de bundle invalida` })
      return
    }
  }

  const mintAddress = mintKeypair.publicKey.toBase58()
  const devBuyLamports = BigInt(Math.floor(devBuySol * 1e9))

  // --- MODO JITO BUNDLE ---
  if (useJito && bundleKeypairs.length > 0 || (useJito && devBuyLamports > 0n)) {
    try {
      const txs: string[] = []

      // Tx 1: create token
      const createTx = await buildCreateTx(
        getSDK(creator), creator, mintKeypair,
        metadataUri, name, symbol, connection, fee
      )
      txs.push(serializeTx(createTx))

      // Tx 2: dev buy (se configurado) — forNewToken=true pois token ainda nao existe
      if (devBuyLamports > 0n) {
        const buyTx = await buildBuyTx(
          getSDK(creator), creator, mintKeypair.publicKey,
          devBuyLamports, connection, fee, true
        )
        txs.push(serializeTx(buyTx))
      }

      // Txs 3-N: wallets bundle — forNewToken=true, passa creator para derivar creator_vault
      for (const { keypair, buySol } of bundleKeypairs) {
        if (buySol <= 0) continue
        const buyTx = await buildBuyTx(
          getSDK(keypair), keypair, mintKeypair.publicKey,
          BigInt(Math.floor(buySol * 1e9)), connection, fee, true, creator.publicKey
        )
        txs.push(serializeTx(buyTx))
      }

      // Tx final: tip Jito
      const tipTx = await buildJitoTipTx(connection, creator, fee)
      txs.push(serializeTx(tipTx))

      const { bundleId } = await sendJitoBundle(txs)

      res.json({
        success: true,
        mint: mintAddress,
        bundleId,
        mode: 'jito',
      })
      return
    } catch (jitoErr: unknown) {
      // Jito falhou — retorna erro informando que user pode tentar fallback
      const jitoMsg = jitoErr instanceof Error ? jitoErr.message : 'Jito bundle falhou'
      res.json({
        success: false,
        mint: mintAddress,
        mode: 'jito',
        error: jitoMsg,
        canRetrySequential: true,
      })
      return
    }
  }

  // --- MODO SEQUENCIAL (sem Jito ou como fallback) ---
  try {
    const sdk = getSDK(creator)
    const fees = { unitLimit: PRIORITY_FEES[fee].unitLimit, unitPrice: PRIORITY_FEES[fee].unitPrice }
    const slippage = SLIPPAGE[fee]

    // Cria o token on-chain usando metadataUri ja uploadada (sem re-upload)
    const { signature: createSig } = await deploySequential(
      sdk, creator, mintKeypair, metadataUri, name, symbol,
      devBuyLamports, fee, connection
    )

    // Compras das wallets de bundle em sequencia (bonding curve ja existe)
    // Usamos buildBuyTx (que aplica patchBuyTx) em vez de sdk.buy() para garantir
    // que os accounts novos do pump.fun (global/user_volume_accumulator) sejam incluidos
    const { sendAndConfirmTransaction } = await import('@solana/web3.js')
    const bundleSigs: string[] = []
    for (const { keypair, buySol } of bundleKeypairs) {
      if (buySol <= 0) continue
      const bundleTx = await buildBuyTx(
        getSDK(keypair), keypair, mintKeypair.publicKey,
        BigInt(Math.floor(buySol * 1e9)), connection, fee, false
      )
      bundleTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
      bundleTx.feePayer = keypair.publicKey
      const sig = await sendAndConfirmTransaction(connection, bundleTx, [keypair], { commitment: 'confirmed' })
      bundleSigs.push(sig)
    }

    res.json({
      success: true,
      mint: mintAddress,
      signature: createSig,
      bundleSignatures: bundleSigs,
      mode: 'sequential',
    })
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Erro no deploy',
    })
  }
})

// POST /api/token/sell
// Body: { mint, percentage, walletKey (opcional — bundle wallet), feeLevel }
tokenRouter.post('/sell', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const { mint, percentage, walletPrivateKey, feeLevel = 'fast' } = req.body

  if (!mint || !percentage) {
    res.status(400).json({ error: 'mint e percentage sao obrigatorios' })
    return
  }

  if (percentage < 1 || percentage > 100) {
    res.status(400).json({ error: 'percentage deve ser entre 1 e 100' })
    return
  }

  try {
    // Se walletPrivateKey fornecida, usa a bundle wallet; senao usa a sessao
    let sellerKeypair: Keypair
    if (walletPrivateKey) {
      sellerKeypair = Keypair.fromSecretKey(bs58.decode(walletPrivateKey))
    } else {
      sellerKeypair = Keypair.fromSecretKey(session.privateKeyBytes)
    }

    const sdk = getSDK(sellerKeypair)
    const mintPubkey = new PublicKey(mint)
    const fee = feeLevel as FeeLevel

    const result = await sellByPercentage(sdk, sellerKeypair, mintPubkey, percentage, fee)

    res.json({
      success: result.success,
      signature: result.signature,
      error: result.error,
    })
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Erro ao vender',
    })
  }
})

// GET /api/token/:mint/info
// Retorna preco atual + saldo da sessao
tokenRouter.get('/:mint/info', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const { mint } = req.params

  try {
    const connection = getConnection()
    const mintPubkey = new PublicKey(mint)
    const owner = Keypair.fromSecretKey(session.privateKeyBytes)
    const sdk = getSDK(owner)

    const [price, balance] = await Promise.all([
      getCurrentPrice(sdk, mintPubkey),
      getTokenBalance(connection, owner.publicKey, mintPubkey),
    ])

    res.json({
      mint,
      price,
      balance: balance.toString(),
    })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro ao buscar info' })
  }
})

// POST /api/token/:mint/balance-bundle
// Retorna saldos de multiplas wallets bundle para um mint
tokenRouter.post('/:mint/balance-bundle', async (req: Request, res: Response) => {
  const { mint } = req.params
  const { walletKeys } = req.body  // string[] de private keys base58

  if (!Array.isArray(walletKeys)) {
    res.status(400).json({ error: 'walletKeys deve ser um array' })
    return
  }

  try {
    const connection = getConnection()
    const mintPubkey = new PublicKey(mint)

    const balances = await Promise.all(
      walletKeys.map(async (pk: string) => {
        try {
          const kp = Keypair.fromSecretKey(bs58.decode(pk))
          const balance = await getTokenBalance(connection, kp.publicKey, mintPubkey)
          return { publicKey: kp.publicKey.toBase58(), balance: balance.toString() }
        } catch {
          return { publicKey: 'invalid', balance: '0' }
        }
      })
    )

    res.json({ balances })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro' })
  }
})

// POST /api/token/sell-all
// Vende de multiplas wallets ao mesmo tempo (dev + bundle)
// Body: { mint, percentage, wallets: [{privateKeyBase58, label}], feeLevel, useJito }
tokenRouter.post('/sell-all', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const {
    mint,
    percentage,
    wallets = [],
    includeDevWallet = true,
    feeLevel = 'fast',
    useJito = true,
  } = req.body

  if (!mint || !percentage || percentage < 1 || percentage > 100) {
    res.status(400).json({ error: 'mint e percentage (1-100) sao obrigatorios' })
    return
  }

  const connection = getConnection()
  const mintPubkey = new PublicKey(mint)
  const fee = feeLevel as FeeLevel

  // Monta lista de keypairs para vender
  const sellers: Array<{ keypair: Keypair; label: string }> = []

  if (includeDevWallet) {
    sellers.push({
      keypair: Keypair.fromSecretKey(session.privateKeyBytes),
      label: 'Dev wallet',
    })
  }

  for (const w of wallets) {
    try {
      sellers.push({
        keypair: Keypair.fromSecretKey(bs58.decode(w.privateKeyBase58)),
        label: w.label || w.privateKeyBase58.slice(0, 6),
      })
    } catch {
      // ignora wallets invalidas
    }
  }

  if (sellers.length === 0) {
    res.status(400).json({ error: 'Nenhuma wallet valida fornecida' })
    return
  }

  // Modo Jito: monta todas as txs de sell em um bundle
  if (useJito) {
    try {
      const txs: string[] = []

      for (const { keypair } of sellers) {
        const balance = await getTokenBalance(connection, keypair.publicKey, mintPubkey)
        if (balance === 0n) continue

        const sellAmount = (balance * BigInt(percentage)) / 100n
        if (sellAmount === 0n) continue

        const sdk = getSDK(keypair)
        const tx = await buildSellTx(sdk, keypair, mintPubkey, sellAmount, fee)
        txs.push(serializeTx(tx))
      }

      if (txs.length === 0) {
        res.json({ success: true, results: [], message: 'Saldo zero em todas as wallets' })
        return
      }

      // Tip tx paga pelo dev wallet
      const devKeypair = Keypair.fromSecretKey(session.privateKeyBytes)
      const tipTx = await buildJitoTipTx(connection, devKeypair, fee)
      txs.push(serializeTx(tipTx))

      const { bundleId } = await sendJitoBundle(txs)
      res.json({ success: true, bundleId, mode: 'jito', walletsCount: txs.length - 1 })
      return
    } catch (jitoErr: unknown) {
      // Jito falhou, avisa para tentar sequencial
      res.json({
        success: false,
        error: jitoErr instanceof Error ? jitoErr.message : 'Jito falhou',
        canRetrySequential: true,
      })
      return
    }
  }

  // Modo sequencial: envia todas em paralelo via RPC
  const results = await Promise.all(
    sellers.map(async ({ keypair, label }) => {
      try {
        const sdk = getSDK(keypair)
        const result = await sellByPercentage(sdk, keypair, mintPubkey, percentage, fee)
        return { label, success: result.success, signature: result.signature }
      } catch (err: unknown) {
        return { label, success: false, error: err instanceof Error ? err.message : 'Erro' }
      }
    })
  )

  res.json({ success: true, results, mode: 'sequential' })
})

// GET /api/token/creator-vault-balance
// Retorna o saldo claimable do creator_vault de um criador
// Body via query: ?creatorPubkey=xxx  ou usa a sessao se nao fornecido
tokenRouter.get('/creator-vault-balance', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const { creatorPubkey, devWalletPrivateKey } = req.query as Record<string, string>

  try {
    const connection = getConnection()
    let creator: Keypair
    if (devWalletPrivateKey) {
      creator = Keypair.fromSecretKey(bs58.decode(devWalletPrivateKey))
    } else if (creatorPubkey) {
      // So precisa da pubkey para verificar o saldo — nao precisa da privkey
      const balance = await getCreatorVaultBalance(connection, new PublicKey(creatorPubkey))
      res.json({ balance })
      return
    } else {
      creator = Keypair.fromSecretKey(session.privateKeyBytes)
    }
    const balance = await getCreatorVaultBalance(connection, creator.publicKey)
    res.json({ balance })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro' })
  }
})

// POST /api/token/claim-fees
// Faz o withdraw do creator_vault de volta para o criador
// Body: { devWalletPrivateKey? (se foi fresh wallet), feeLevel? }
tokenRouter.post('/claim-fees', async (req: Request, res: Response) => {
  const session = (req as any).session as ActiveSession
  const { devWalletPrivateKey, feeLevel = 'fast' } = req.body

  try {
    const connection = getConnection()
    const fee = feeLevel as typeof import('../solana/jito').FeeLevel
    let creator: Keypair
    if (devWalletPrivateKey) {
      creator = Keypair.fromSecretKey(bs58.decode(devWalletPrivateKey))
    } else {
      creator = Keypair.fromSecretKey(session.privateKeyBytes)
    }

    const { sendAndConfirmTransaction } = await import('@solana/web3.js')
    const tx = await buildWithdrawTx(creator, connection, fee)
    const sig = await sendAndConfirmTransaction(connection, tx, [creator], { commitment: 'confirmed' })
    res.json({ success: true, signature: sig })
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Erro ao claim fees',
    })
  }
})
