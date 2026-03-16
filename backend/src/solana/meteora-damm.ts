// @ts-nocheck
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'

// Values in basis points (bps): 0.25% = 25 bps
export const METEORA_FEE_TIERS: Record<string, number> = {
  '0.10%':  10,
  '0.25%':  25,
  '0.30%':  30,
  '1%':    100,
}

export interface CreateDammPoolParams {
  connection: Connection
  payer: Keypair
  tokenMint: PublicKey
  tokenDecimals: number
  tokenAmount: bigint
  solLamports: bigint
  feeTierLabel: string
  openTime: number  // unix timestamp, 0 = now
}

export interface DammPoolResult {
  poolAddress: string
  lpMint: string
  txId: string
}

export async function createDammPool(params: CreateDammPoolParams): Promise<DammPoolResult> {
  const AmmImpl = (await import('@meteora-ag/dynamic-amm-sdk')).default

  const { connection, payer, tokenMint, tokenAmount, solLamports, feeTierLabel } = params

  const feeBps = METEORA_FEE_TIERS[feeTierLabel] ?? METEORA_FEE_TIERS['0.25%']

  const tokenAMint = tokenMint
  const tokenBMint = NATIVE_MINT

  const tokenAAmount = new BN(tokenAmount.toString())
  const tokenBAmount = new BN(solLamports.toString())

  // createPermissionlessPool returns Transaction[]
  const transactions = await AmmImpl.createPermissionlessPool(
    connection,
    payer.publicKey,
    tokenAMint,
    tokenBMint,
    tokenAAmount,
    tokenBAmount,
    false,  // isStable = false → constant product (DAMM)
    { tradeFeeBps: new BN(feeBps) },
  )

  let lastTxId = ''
  for (const tx of Array.isArray(transactions) ? transactions : [transactions]) {
    lastTxId = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' })
  }

  // Resolve pool address via token pair query
  let poolAddress = 'pending'
  let lpMint = 'pending'
  try {
    const pools = await AmmImpl.getPools(connection, { tokenA: tokenAMint, tokenB: tokenBMint })
    if (pools && pools.length > 0) {
      const pool = pools[pools.length - 1]
      poolAddress = pool.address?.toBase58?.() ?? pool.publicKey?.toBase58?.() ?? 'pending'
      lpMint = pool.poolState?.lpMint?.toBase58?.() ?? pool.lpMint?.toBase58?.() ?? 'pending'
    }
  } catch {
    // Se getPools nao existir na versao do SDK, o address fica pending
    // O usuario pode encontrar o pool pelo txId no Solscan
  }

  return { poolAddress, lpMint, txId: lastTxId }
}

export interface RemoveDammLiquidityParams {
  connection: Connection
  payer: Keypair
  poolAddress: string
}

export async function removeDammLiquidity(params: RemoveDammLiquidityParams): Promise<string> {
  const AmmImpl = (await import('@meteora-ag/dynamic-amm-sdk')).default
  const { getAccount, getAssociatedTokenAddressSync } = await import('@solana/spl-token')

  const { connection, payer, poolAddress } = params

  const pool = await AmmImpl.create(connection, new PublicKey(poolAddress))
  const lpMint = pool.poolState?.lpMint ?? pool.lpMint

  const lpAta = getAssociatedTokenAddressSync(lpMint, payer.publicKey)
  const lpAccount = await getAccount(connection, lpAta)
  const lpAmount = new BN(lpAccount.amount.toString())

  const tx = await pool.removeLiquidity(
    payer.publicKey,
    lpAmount,
    new BN(0),
    new BN(0),
  )

  const txId = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' })
  return txId
}
