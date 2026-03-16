// @ts-nocheck
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'

// Raydium CPMM mainnet constants
const CPMM_PROGRAM_ID  = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
const CPMM_FEE_ACCOUNT = new PublicKey('G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2')

// Fee tier numerators (denominator = 1_000_000)
// 0.01% = 100, 0.05% = 500, 0.25% = 2500, 0.30% = 3000, 0.50% = 5000, 1% = 10000
export const RAYDIUM_FEE_TIERS: Record<string, number> = {
  '0.01%': 100,
  '0.05%': 500,
  '0.25%': 2500,
  '0.30%': 3000,
  '0.50%': 5000,
  '1%':    10000,
}

export interface CreateCpmmPoolParams {
  connection: Connection
  payer: Keypair
  tokenMint: PublicKey
  tokenDecimals: number
  tokenAmount: bigint     // raw token amount
  solLamports: bigint     // lamports
  feeTierLabel: string    // e.g. '0.50%'
  openTime: number        // unix timestamp, 0 = now
}

export interface CpmmPoolResult {
  poolId: string
  lpMint: string
  txId: string
}

export async function createCpmmPool(params: CreateCpmmPoolParams): Promise<CpmmPoolResult> {
  const { Raydium, TxVersion } = await import('@raydium-io/raydium-sdk-v2')

  const { connection, payer, tokenMint, tokenDecimals, tokenAmount, solLamports, feeTierLabel, openTime } = params

  const raydium = await Raydium.load({
    owner: payer,
    connection,
    cluster: 'mainnet',
    disableLoadToken: false,
  })

  // Fetch on-chain fee configs
  const { data: feeConfigs } = await raydium.api.fetchCpmmConfigs()
  const targetRate = RAYDIUM_FEE_TIERS[feeTierLabel] ?? RAYDIUM_FEE_TIERS['0.50%']

  // Find matching config, fallback to closest
  let feeConfig = feeConfigs.find((c: { tradeFeeRate: number }) => c.tradeFeeRate === targetRate)
  if (!feeConfig) {
    feeConfig = feeConfigs.reduce((best: { tradeFeeRate: number }, c: { tradeFeeRate: number }) =>
      Math.abs(c.tradeFeeRate - targetRate) < Math.abs(best.tradeFeeRate - targetRate) ? c : best
    )
  }

  const startTime = openTime > 0 ? openTime : Math.floor(Date.now() / 1000)

  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: CPMM_PROGRAM_ID,
    poolFeeAccount: CPMM_FEE_ACCOUNT,
    mintA: {
      address: tokenMint.toBase58(),
      decimals: tokenDecimals,
      programId: '11111111111111111111111111111111', // TOKEN_PROGRAM_ID string
    },
    mintB: {
      address: NATIVE_MINT.toBase58(),
      decimals: 9,
      programId: '11111111111111111111111111111111',
    },
    mintAAmount: new BN(tokenAmount.toString()),
    mintBAmount: new BN(solLamports.toString()),
    startTime: new BN(startTime),
    feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  })

  const { txId } = await execute({ sendAndConfirm: true })

  return {
    poolId: extInfo.address.poolId.toBase58(),
    lpMint: extInfo.address.lpMint.toBase58(),
    txId,
  }
}

export interface RemoveCpmmLiquidityParams {
  connection: Connection
  payer: Keypair
  poolId: string
  lpMint: string
}

export async function removeCpmmLiquidity(params: RemoveCpmmLiquidityParams): Promise<string> {
  const { Raydium, TxVersion } = await import('@raydium-io/raydium-sdk-v2')
  const { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID: SPL_TOKEN_PROGRAM } = await import('@solana/spl-token')

  const { connection, payer, poolId, lpMint } = params

  const raydium = await Raydium.load({
    owner: payer,
    connection,
    cluster: 'mainnet',
    disableLoadToken: false,
  })

  // Get user's LP token balance
  const lpMintPubkey = new PublicKey(lpMint)
  const lpAta = getAssociatedTokenAddressSync(lpMintPubkey, payer.publicKey, false, SPL_TOKEN_PROGRAM)
  const lpAccount = await getAccount(connection, lpAta)
  const lpAmount = new BN(lpAccount.amount.toString())

  const poolInfo = await raydium.cpmm.getRpcPoolInfo(poolId)

  const { execute } = await raydium.cpmm.removeLiquidity({
    poolInfo,
    poolKeys: undefined,
    lpAmount,
    slippage: 0.01,
    txVersion: TxVersion.V0,
  })

  const { txId } = await execute({ sendAndConfirm: true })
  return txId
}
