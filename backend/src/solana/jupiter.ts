import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'

const QUOTE_API = 'https://quote-api.jup.ag/v6/quote'
const SWAP_API  = 'https://quote-api.jup.ag/v6/swap'
const SOL_MINT  = 'So11111111111111111111111111111111111111112'

async function jupiterSwap(
  connection: Connection,
  payer: Keypair,
  outputMint: string,
  lamports: number,
  slippageBps: number,
): Promise<string> {
  const quoteUrl = `${QUOTE_API}?inputMint=${SOL_MINT}&outputMint=${outputMint}&amount=${lamports}&slippageBps=${slippageBps}`
  const quoteRes = await fetch(quoteUrl)
  if (!quoteRes.ok) throw new Error(`Jupiter quote HTTP ${quoteRes.status}`)
  const quote = await quoteRes.json() as Record<string, unknown>
  if (quote.error) throw new Error(`Jupiter quote: ${quote.error}`)

  const swapRes = await fetch(SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: payer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  })
  if (!swapRes.ok) throw new Error(`Jupiter swap HTTP ${swapRes.status}`)
  const { swapTransaction } = await swapRes.json() as { swapTransaction: string }

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))
  tx.sign([payer])
  const txId = await connection.sendRawTransaction(tx.serialize())
  await connection.confirmTransaction(txId, 'confirmed')
  return txId
}

// Retry com delay — pool recem criada pode demorar ~30-60s pra Jupiter indexar
export async function jupiterSwapWithRetry(
  connection: Connection,
  payer: Keypair,
  outputMint: string,
  lamports: number,
  slippageBps: number = 500,
  maxRetries: number = 12,
  delayMs: number = 6000,
): Promise<string> {
  let lastErr: Error = new Error('unknown')
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await jupiterSwap(connection, payer, outputMint, lamports, slippageBps)
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const msg = lastErr.message.toLowerCase()
      const notIndexed = msg.includes('no routes') || msg.includes('route') ||
                         msg.includes('no market') || msg.includes('quote')
      if (i < maxRetries - 1 && notIndexed) {
        await new Promise(r => setTimeout(r, delayMs))
        continue
      }
      throw lastErr
    }
  }
  throw lastErr
}

// Transfere SOL para uma wallet e faz swap
export async function fundAndSwap(
  connection: Connection,
  funder: Keypair,
  target: Keypair,
  tokenMint: string,
  buyLamports: number,
  slippageBps: number,
): Promise<{ fundTxId: string; swapTxId: string }> {
  const feeBuffer = 15_000_000 // 0.015 SOL para fees + ATA creation
  const fundLamports = buyLamports + feeBuffer

  const { blockhash } = await connection.getLatestBlockhash()
  const fundTx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: funder.publicKey,
  }).add(SystemProgram.transfer({
    fromPubkey: funder.publicKey,
    toPubkey: target.publicKey,
    lamports: fundLamports,
  }))

  const fundTxId = await sendAndConfirmTransaction(connection, fundTx, [funder], {
    commitment: 'confirmed',
  })

  const swapTxId = await jupiterSwapWithRetry(connection, target, tokenMint, buyLamports, slippageBps)
  return { fundTxId, swapTxId }
}

export function generateFreshKeypair(): { keypair: Keypair; privateKeyBase58: string } {
  const keypair = Keypair.generate()
  return { keypair, privateKeyBase58: bs58.encode(keypair.secretKey) }
}
