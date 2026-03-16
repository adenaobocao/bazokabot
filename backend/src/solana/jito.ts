import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'

// Tip accounts oficiais do Jito (mainnet)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvB6pVR3t5TMAkqgzpSmfDSsgkFpyAB4kFCw',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkYA',
  'ADaUMid9qdSGPFJTsm6MEHfHVHMdTUfnRckq4Bx7XLQX',
]

const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.labs.io/api/v1/bundles'

export type FeeLevel = 'normal' | 'fast' | 'turbo' | 'mayhem'

export const PRIORITY_FEES: Record<FeeLevel, { unitLimit: number; unitPrice: number }> = {
  normal:  { unitLimit: 200_000, unitPrice: 50_000 },
  fast:    { unitLimit: 200_000, unitPrice: 200_000 },
  turbo:   { unitLimit: 200_000, unitPrice: 1_000_000 },
  mayhem:  { unitLimit: 300_000, unitPrice: 5_000_000 },
}

export const JITO_TIPS: Record<FeeLevel, number> = {
  normal:  10_000,    // 0.00001 SOL
  fast:    100_000,   // 0.0001 SOL
  turbo:   500_000,   // 0.0005 SOL
  mayhem:  1_000_000, // 0.001 SOL
}

export const SLIPPAGE: Record<FeeLevel, bigint> = {
  normal:  100n,   // 1%
  fast:    500n,   // 5%
  turbo:   1000n,  // 10%
  mayhem:  5000n,  // 50%
}

// Randomiza o tip account pra distribuir carga
function randomTipAccount(): PublicKey {
  return new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
  )
}

// Cria transacao de tip para o Jito
export async function buildJitoTipTx(
  connection: Connection,
  payer: Keypair,
  feeLevel: FeeLevel
): Promise<Transaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction()
  tx.recentBlockhash = blockhash
  tx.feePayer = payer.publicKey
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: randomTipAccount(),
      lamports: JITO_TIPS[feeLevel],
    })
  )
  tx.sign(payer)
  return tx
}

// Submete bundle via Jito block engine
// Recebe transacoes ja assinadas em base64
export async function sendJitoBundle(
  serializedTxs: string[]
): Promise<{ bundleId: string }> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendBundle',
    params: [serializedTxs],
  }

  const res = await fetch(JITO_BLOCK_ENGINE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await res.json() as { result?: string; error?: { message: string } }

  if (data.error) {
    throw new Error(`Jito bundle error: ${data.error.message}`)
  }

  return { bundleId: data.result! }
}

// Serializa uma Transaction legada para base64
export function serializeTx(tx: Transaction): string {
  return tx.serialize().toString('base64')
}

// Serializa uma VersionedTransaction para base64
export function serializeVersionedTx(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64')
}

// Fallback: envia transacoes sequencialmente via RPC normal
export async function sendSequential(
  connection: Connection,
  transactions: Array<{ tx: Transaction; signers: Keypair[] }>
): Promise<string[]> {
  const signatures: string[] = []

  for (const { tx, signers } of transactions) {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: 'confirmed',
      maxRetries: 3,
    })
    signatures.push(sig)
  }

  return signatures
}
