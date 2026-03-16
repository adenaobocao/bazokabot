import { createHash } from 'crypto'
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token'
import { PumpFunSDK } from 'pumpdotfun-sdk'
import { getProvider } from './connection'
import { FeeLevel, PRIORITY_FEES, SLIPPAGE } from './jito'

// --- CONSTANTES DO PROGRAMA PUMP.FUN ---

export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')

// Programa de fees separado (adicionado em atualização recente)
const FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')

// Event authority — PDA seeds: ["__event_authority"] com PUMP_FUN_PROGRAM_ID
// Valor derivado: Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1 (bump 255)
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1')

// PDAs estaticas do programa principal
const [GLOBAL_ACCOUNT] = PublicKey.findProgramAddressSync(
  [Buffer.from('global')], PUMP_FUN_PROGRAM_ID
)
const [GLOBAL_VOLUME_ACCUMULATOR] = PublicKey.findProgramAddressSync(
  [Buffer.from('global_volume_accumulator')], PUMP_FUN_PROGRAM_ID
)

// fee_config é PDA do FEE_PROGRAM_ID, seeds: ["fee_config", pump_program_id]
// Endereço derivado: 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt
const [FEE_CONFIG] = PublicKey.findProgramAddressSync(
  [Buffer.from('fee_config'), PUMP_FUN_PROGRAM_ID.toBuffer()],
  FEE_PROGRAM_ID
)

function getBondingCurvePDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_FUN_PROGRAM_ID
  )[0]
}

function getUserVolumeAccumulatorPDA(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_FUN_PROGRAM_ID
  )[0]
}

// creator_vault: PDA seeds ["creator-vault", creator_pubkey] com PUMP_FUN_PROGRAM_ID
// O creator é lido do account data da bonding curve (campo adicionado na atualização do programa)
// bonding_curve_v2: adicionada em fevereiro/2026 — deve ser a ultima conta da instrucao
function getBondingCurveV2PDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBuffer()], PUMP_FUN_PROGRAM_ID
  )[0]
}

function getCreatorVaultPDA(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()], PUMP_FUN_PROGRAM_ID
  )[0]
}

// Lê o campo creator do BondingCurve account
// Layout Anchor: 8 (disc) + 5*8 (u64: vTokenRes, vSolRes, rTokenRes, rSolRes, totalSupply) + 1 (bool complete) = 49 bytes
async function getCreatorFromBondingCurve(
  connection: Connection,
  bondingCurvePDA: PublicKey,
  commitment: 'confirmed' | 'finalized' = 'confirmed'
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(bondingCurvePDA, commitment)
  if (!info) throw new Error('BondingCurve account nao encontrado')
  const creatorOffset = 8 + 5 * 8 + 1  // = 49
  return new PublicKey(info.data.slice(creatorOffset, creatorOffset + 32))
}

// Parametros iniciais fixos da bonding curve pump.fun (constantes do programa, nao mudam por token)
// initialVirtualSolReserves: 30 SOL
// initialVirtualTokenReserves: 1,073,000,191 tokens com 6 casas decimais
const INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_191_000_000n

// Calcula quantos tokens se obtem ao pagar solAmount em uma curva recem-criada
// Evita depender do SDK (GlobalAccount pode estar mal-parseado apos atualizacoes do programa)
function computeInitialBuyPrice(solAmount: bigint): bigint {
  const n = INITIAL_VIRTUAL_TOKEN_RESERVES * solAmount
  const d = INITIAL_VIRTUAL_SOL_RESERVES + solAmount
  return n / d + 1n
}

// Discriminadores Anchor: sha256("global:<instrucao>")[0:8]
const BUY_DISCRIMINATOR: Buffer = (() => {
  const hash = createHash('sha256').update('global:buy').digest()
  return Buffer.from(hash.slice(0, 8))
})()

const SELL_DISCRIMINATOR: Buffer = (() => {
  const hash = createHash('sha256').update('global:sell').digest()
  return Buffer.from(hash.slice(0, 8))
})()

const WITHDRAW_DISCRIMINATOR: Buffer = (() => {
  const hash = createHash('sha256').update('global:withdraw').digest()
  return Buffer.from(hash.slice(0, 8))
})()

// Escreve bigint como u64 little-endian em 8 bytes
function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt32LE(Number(value & 0xffffffffn), 0)
  buf.writeUInt32LE(Number(value >> 32n), 4)
  return buf
}

// --- INSTRUCAO DE BUY CONSTRUIDA MANUALMENTE ---
// 16 accounts na ordem exata do IDL atual (pump-fun/pump-public-docs)
//
// tokenCreator: quem criou o token (necessario para derivar creator_vault)
//   - Se undefined, busca do account data da bonding curve (token ja existe on-chain)
//   - Se fornecido, usa diretamente (token novo em bundle — bonding curve pode nao existir ainda)

async function buildBuyInstruction(
  buyer: PublicKey,
  mint: PublicKey,
  feeRecipient: PublicKey,
  tokenAmount: bigint,
  maxSolCost: bigint,
  connection: Connection,
  commitment: 'confirmed' | 'finalized' = 'confirmed',
  tokenCreator?: PublicKey
): Promise<{ instruction: TransactionInstruction; ataIx: TransactionInstruction | null }> {
  const bondingCurve = getBondingCurvePDA(mint)
  const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true)
  const associatedUser = await getAssociatedTokenAddress(mint, buyer, false)

  // Verifica se ATA do usuario ja existe
  let ataIx: TransactionInstruction | null = null
  try {
    await getAccount(connection, associatedUser, commitment)
  } catch {
    ataIx = createAssociatedTokenAccountInstruction(buyer, associatedUser, buyer, mint)
  }

  // Resolve creator para derivar creator_vault
  const creator = tokenCreator ?? await getCreatorFromBondingCurve(connection, bondingCurve, commitment)
  const creatorVault = getCreatorVaultPDA(creator)

  // Dados: discriminador + tokenAmount (u64 LE) + maxSolCost (u64 LE)
  const data = Buffer.concat([BUY_DISCRIMINATOR, u64LE(tokenAmount), u64LE(maxSolCost)])

  // 16 accounts na ordem exata do IDL (https://github.com/pump-fun/pump-public-docs)
  const instruction = new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_ACCOUNT,                        isSigner: false, isWritable: false }, // 0  global
      { pubkey: feeRecipient,                          isSigner: false, isWritable: true  }, // 1  fee_recipient
      { pubkey: mint,                                  isSigner: false, isWritable: false }, // 2  mint
      { pubkey: bondingCurve,                          isSigner: false, isWritable: true  }, // 3  bonding_curve
      { pubkey: associatedBondingCurve,                isSigner: false, isWritable: true  }, // 4  associated_bonding_curve
      { pubkey: associatedUser,                        isSigner: false, isWritable: true  }, // 5  associated_user
      { pubkey: buyer,                                 isSigner: true,  isWritable: true  }, // 6  user
      { pubkey: SystemProgram.programId,               isSigner: false, isWritable: false }, // 7  system_program
      { pubkey: TOKEN_PROGRAM_ID,                      isSigner: false, isWritable: false }, // 8  token_program
      { pubkey: creatorVault,                          isSigner: false, isWritable: true  }, // 9  creator_vault
      { pubkey: EVENT_AUTHORITY,                       isSigner: false, isWritable: false }, // 10 event_authority
      { pubkey: PUMP_FUN_PROGRAM_ID,                   isSigner: false, isWritable: false }, // 11 program
      { pubkey: GLOBAL_VOLUME_ACCUMULATOR,             isSigner: false, isWritable: false }, // 12 global_volume_accumulator
      { pubkey: getUserVolumeAccumulatorPDA(buyer),    isSigner: false, isWritable: true  }, // 13 user_volume_accumulator
      { pubkey: FEE_CONFIG,                            isSigner: false, isWritable: false }, // 14 fee_config
      { pubkey: FEE_PROGRAM_ID,                        isSigner: false, isWritable: false }, // 15 fee_program
      { pubkey: getBondingCurveV2PDA(mint),            isSigner: false, isWritable: true  }, // 16 bonding_curve_v2
    ],
    data,
  })

  return { instruction, ataIx }
}

// --- SDK (ainda usado para create, price queries, global account) ---

export function getSDK(keypair: Keypair): PumpFunSDK {
  return new PumpFunSDK(getProvider(keypair))
}

// --- UPLOAD METADATA ---

export async function uploadMetadataToPumpFun(params: {
  imageBuffer: Buffer
  mimeType: string
  name: string
  symbol: string
  description: string
  twitter?: string
  telegram?: string
  website?: string
}): Promise<string> {
  const blob = new Blob([params.imageBuffer], { type: params.mimeType })
  const form = new FormData()
  form.append('file', blob, `token.${params.mimeType.split('/')[1] || 'png'}`)
  form.append('name', params.name)
  form.append('symbol', params.symbol)
  form.append('description', params.description)
  form.append('showName', 'true')
  if (params.twitter) form.append('twitter', params.twitter)
  if (params.telegram) form.append('telegram', params.telegram)
  if (params.website) form.append('website', params.website)

  const res = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Erro no upload para pump.fun IPFS: ${res.status} ${res.statusText}`)
  const data = await res.json() as { metadataUri?: string }
  if (!data.metadataUri) throw new Error('Resposta invalida do pump.fun IPFS')
  return data.metadataUri
}

// --- QUERIES ---

export async function getTokenBalance(
  connection: Connection, owner: PublicKey, mint: PublicKey
): Promise<bigint> {
  try {
    const ata = await getAssociatedTokenAddress(mint, owner)
    const account = await getAccount(connection, ata, 'confirmed')
    return account.amount
  } catch { return 0n }
}

export async function getCurrentPrice(sdk: PumpFunSDK, mint: PublicKey): Promise<number | null> {
  try {
    const curve = await sdk.getBondingCurveAccount(mint, 'confirmed')
    if (!curve || curve.virtualTokenReserves === 0n) return null
    return Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves) / 1e9
  } catch { return null }
}

// --- BUILD CREATE TX (ainda usa SDK — create nao teve mudancas de accounts) ---

export async function buildCreateTx(
  sdk: PumpFunSDK,
  creator: Keypair,
  mint: Keypair,
  metadataUri: string,
  name: string,
  symbol: string,
  connection: Connection,
  feeLevel: FeeLevel
): Promise<Transaction> {
  const tx = await sdk.getCreateInstructions(creator.publicKey, name, symbol, metadataUri, mint)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = creator.publicKey
  const fees = PRIORITY_FEES[feeLevel]
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fees.unitPrice }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: fees.unitLimit })
  )
  tx.partialSign(creator, mint)
  return tx
}

// --- BUILD BUY TX (instrucao raw — sem SDK) ---
//
// tokenCreator: necessario quando forNewToken=true e buyer NAO e o criador do token
//   (ex: wallet de bundle comprando token recem criado por outro keypair)

export async function buildBuyTx(
  sdk: PumpFunSDK,
  buyer: Keypair,
  mint: PublicKey,
  buyAmountSol: bigint,
  connection: Connection,
  feeLevel: FeeLevel,
  forNewToken: boolean = false,
  tokenCreator?: PublicKey
): Promise<Transaction> {
  const slippage = SLIPPAGE[feeLevel]
  const globalAccount = await sdk.getGlobalAccount('confirmed')
  const feeRecipient = globalAccount.feeRecipient

  let tokenAmount: bigint
  let maxSolCost: bigint

  if (forNewToken) {
    // Usa constantes hardcoded — evita SDK misparse do GlobalAccount (struct mudou no programa)
    tokenAmount = computeInitialBuyPrice(buyAmountSol)
    maxSolCost = buyAmountSol + (buyAmountSol * slippage) / 10000n
  } else {
    const curve = await sdk.getBondingCurveAccount(mint, 'confirmed')
    if (!curve) throw new Error(`Bonding curve nao encontrada: ${mint.toBase58()}`)
    tokenAmount = curve.getBuyPrice(buyAmountSol)
    maxSolCost = buyAmountSol + (buyAmountSol * slippage) / 10000n
  }

  // Para token novo, creator e o buyer (dev buy) ou tokenCreator (bundle wallets)
  const creator = forNewToken ? (tokenCreator ?? buyer.publicKey) : undefined

  const { instruction, ataIx } = await buildBuyInstruction(
    buyer.publicKey, mint, feeRecipient, tokenAmount, maxSolCost, connection,
    'confirmed', creator
  )

  const tx = new Transaction()
  const fees = PRIORITY_FEES[feeLevel]
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fees.unitPrice }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: fees.unitLimit })
  )
  if (ataIx) tx.add(ataIx)
  tx.add(instruction)

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = buyer.publicKey
  tx.sign(buyer)
  return tx
}

// --- DEPLOY SEQUENCIAL ---

export async function deploySequential(
  sdk: PumpFunSDK,
  creator: Keypair,
  mint: Keypair,
  metadataUri: string,
  name: string,
  symbol: string,
  devBuyAmountSol: bigint,
  feeLevel: FeeLevel,
  connection: Connection
): Promise<{ signature: string }> {
  const fees = PRIORITY_FEES[feeLevel]

  // 1. Create token on-chain
  const createTx = await sdk.getCreateInstructions(creator.publicKey, name, symbol, metadataUri, mint)
  const { blockhash: bh1 } = await connection.getLatestBlockhash('confirmed')
  createTx.recentBlockhash = bh1
  createTx.feePayer = creator.publicKey
  createTx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fees.unitPrice }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: fees.unitLimit })
  )
  const createSig = await sendAndConfirmTransaction(connection, createTx, [creator, mint], { commitment: 'confirmed' })

  // 2. Dev buy — bonding curve ja existe on-chain apos o create
  if (devBuyAmountSol > 0n) {
    const slippage = SLIPPAGE[feeLevel]

    // Usa o estado real da curva (evita SDK misparse do GlobalAccount)
    // Espera inicial de 3s: mesmo com commitment 'confirmed', o RPC pode demorar
    // a indexar o account imediatamente apos sendAndConfirmTransaction retornar
    await new Promise(r => setTimeout(r, 3000))
    let curve = await sdk.getBondingCurveAccount(mint.publicKey, 'confirmed')
    if (!curve) {
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 2000))
        curve = await sdk.getBondingCurveAccount(mint.publicKey, 'confirmed')
        if (curve) break
      }
    }
    if (!curve) throw new Error('BondingCurve nao encontrada apos create (timeout 19s)')

    const globalAccount = await sdk.getGlobalAccount('confirmed')

    const tokenAmount = curve.getBuyPrice(devBuyAmountSol)
    const maxSolCost = devBuyAmountSol + (devBuyAmountSol * slippage) / 10000n

    // Passa creator diretamente — evita round-trip pra buscar da bonding curve
    const { instruction, ataIx } = await buildBuyInstruction(
      creator.publicKey, mint.publicKey, globalAccount.feeRecipient,
      tokenAmount, maxSolCost, connection, 'confirmed', creator.publicKey
    )

    const buyTx = new Transaction()
    buyTx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fees.unitPrice }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: fees.unitLimit })
    )
    if (ataIx) buyTx.add(ataIx)
    buyTx.add(instruction)

    const { blockhash: bh2 } = await connection.getLatestBlockhash('confirmed')
    buyTx.recentBlockhash = bh2
    buyTx.feePayer = creator.publicKey
    await sendAndConfirmTransaction(connection, buyTx, [creator], { commitment: 'confirmed' })
  }

  return { signature: createSig }
}

// --- INSTRUCAO DE SELL CONSTRUIDA MANUALMENTE ---
// Mesmo layout que buy, substituindo buy-specific por sell-specific
// Accounts: identical order to buy instruction (IDL pump-fun/pump-public-docs)

async function buildSellInstruction(
  seller: PublicKey,
  mint: PublicKey,
  feeRecipient: PublicKey,
  tokenAmount: bigint,
  minSolOutput: bigint,
  connection: Connection,
  commitment: 'confirmed' | 'finalized' = 'confirmed'
): Promise<TransactionInstruction> {
  const bondingCurve = getBondingCurvePDA(mint)
  const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true)
  const associatedUser = await getAssociatedTokenAddress(mint, seller, false)

  const creator = await getCreatorFromBondingCurve(connection, bondingCurve, commitment)
  const creatorVault = getCreatorVaultPDA(creator)

  const data = Buffer.concat([SELL_DISCRIMINATOR, u64LE(tokenAmount), u64LE(minSolOutput)])

  // Sell: 15 accounts confirmados por transacao real on-chain (fev/2026)
  // SEM global_volume_accumulator e user_volume_accumulator (ao contrario do buy)
  // creator_vault (8) e token_program (9) invertidos vs buy
  // bonding_curve_v2 (14) nao e writable no sell (diferente do buy)
  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_ACCOUNT,                        isSigner: false, isWritable: false }, // 0  global
      { pubkey: feeRecipient,                          isSigner: false, isWritable: true  }, // 1  fee_recipient
      { pubkey: mint,                                  isSigner: false, isWritable: false }, // 2  mint
      { pubkey: bondingCurve,                          isSigner: false, isWritable: true  }, // 3  bonding_curve
      { pubkey: associatedBondingCurve,                isSigner: false, isWritable: true  }, // 4  associated_bonding_curve
      { pubkey: associatedUser,                        isSigner: false, isWritable: true  }, // 5  associated_user
      { pubkey: seller,                                isSigner: true,  isWritable: true  }, // 6  user
      { pubkey: SystemProgram.programId,               isSigner: false, isWritable: false }, // 7  system_program
      { pubkey: creatorVault,                          isSigner: false, isWritable: true  }, // 8  creator_vault
      { pubkey: TOKEN_PROGRAM_ID,                      isSigner: false, isWritable: false }, // 9  token_program
      { pubkey: EVENT_AUTHORITY,                       isSigner: false, isWritable: false }, // 10 event_authority
      { pubkey: PUMP_FUN_PROGRAM_ID,                   isSigner: false, isWritable: false }, // 11 program
      { pubkey: FEE_CONFIG,                            isSigner: false, isWritable: false }, // 12 fee_config
      { pubkey: FEE_PROGRAM_ID,                        isSigner: false, isWritable: false }, // 13 fee_program
      { pubkey: getBondingCurveV2PDA(mint),            isSigner: false, isWritable: false }, // 14 bonding_curve_v2
    ],
    data,
  })
}

// Calcula o minSolOutput para um sell
// Usa formula manual com reservas reais da bonding curve — evita SDK misparse do GlobalAccount
// feeBasisPoints: pump.fun cobra 1% (100 bps) — valor fixo do programa, nao lemos do global
async function calcSellMinOutput(
  sdk: PumpFunSDK,
  mint: PublicKey,
  tokenAmount: bigint,
  slippage: bigint
): Promise<{ minSolOutput: bigint; feeRecipient: PublicKey }> {
  const [curve, globalAccount] = await Promise.all([
    sdk.getBondingCurveAccount(mint, 'confirmed'),
    sdk.getGlobalAccount('confirmed'),
  ])
  if (!curve) throw new Error(`Bonding curve nao encontrada: ${mint.toBase58()}`)

  // Formula da bonding curve: quanto SOL o vendedor recebe por tokenAmount tokens
  // newVirtualTokenReserves = virtualTokenReserves + tokenAmount
  // grossSol = virtualSolReserves - (virtualSolReserves * virtualTokenReserves) / newVirtualTokenReserves
  const newVirtualTokenReserves = curve.virtualTokenReserves + tokenAmount
  const grossSol = curve.virtualSolReserves -
    (curve.virtualSolReserves * curve.virtualTokenReserves) / newVirtualTokenReserves

  // 1% de fee do programa (100 bps hardcoded — nao depende do SDK)
  const FEE_BPS = 100n
  const netSol = grossSol - (grossSol * FEE_BPS) / 10000n

  // Aplica slippage do usuario
  const minSolOutput = netSol - (netSol * slippage) / 10000n

  return { minSolOutput, feeRecipient: globalAccount.feeRecipient }
}

// Exportado para uso no sell-all do token.ts (Jito + sequencial)
export async function buildSellTx(
  sdk: PumpFunSDK,
  seller: Keypair,
  mint: PublicKey,
  tokenAmount: bigint,
  feeLevel: FeeLevel
): Promise<Transaction> {
  const connection = sdk.connection
  const slippage = SLIPPAGE[feeLevel]
  const fees = PRIORITY_FEES[feeLevel]

  const { minSolOutput, feeRecipient } = await calcSellMinOutput(sdk, mint, tokenAmount, slippage)

  const sellIx = await buildSellInstruction(
    seller.publicKey, mint, feeRecipient, tokenAmount, minSolOutput, connection
  )

  const tx = new Transaction()
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fees.unitPrice }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: fees.unitLimit })
  )
  tx.add(sellIx)

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = seller.publicKey
  tx.sign(seller)
  return tx
}

// --- CLAIM CREATOR VAULT FEES ---
//
// Instrucao "withdraw": retira SOL acumulado no creator_vault de volta pro criador
// O creator_vault acumula as fees de cashback que o programa repassa ao criador a cada trade
//
// Accounts (ordem confirmada pelo IDL pump.fun global:withdraw):
//   0: global          (readonly)
//   1: creator         (signer, writable) — recebe o SOL
//   2: creator_vault   (writable)         — fonte do SOL
//   3: system_program  (readonly)
//   4: event_authority (readonly)
//   5: pump_fun_program (readonly)

export async function getCreatorVaultBalance(
  connection: Connection,
  creator: PublicKey
): Promise<number> {
  try {
    const vault = getCreatorVaultPDA(creator)
    const info = await connection.getAccountInfo(vault, 'confirmed')
    if (!info) return 0
    // Descontamos o rent-exempt minimo (~0.00089 SOL para conta vazia de 0 bytes)
    const rentExempt = await connection.getMinimumBalanceForRentExemption(0)
    const claimable = Math.max(0, info.lamports - rentExempt)
    return claimable / 1e9
  } catch { return 0 }
}

export async function buildWithdrawTx(
  creator: Keypair,
  connection: Connection,
  feeLevel: FeeLevel
): Promise<Transaction> {
  const creatorVault = getCreatorVaultPDA(creator.publicKey)

  const data = Buffer.from(WITHDRAW_DISCRIMINATOR)

  const ix = new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_ACCOUNT,      isSigner: false, isWritable: false }, // 0 global
      { pubkey: creator.publicKey,   isSigner: true,  isWritable: true  }, // 1 creator
      { pubkey: creatorVault,        isSigner: false, isWritable: true  }, // 2 creator_vault
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 3 system_program
      { pubkey: EVENT_AUTHORITY,     isSigner: false, isWritable: false }, // 4 event_authority
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }, // 5 program
    ],
    data,
  })

  const fees = PRIORITY_FEES[feeLevel]
  const tx = new Transaction()
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fees.unitPrice }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: fees.unitLimit })
  )
  tx.add(ix)

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = creator.publicKey
  tx.sign(creator)
  return tx
}

// --- SELL POR PERCENTAGEM ---

export async function sellByPercentage(
  sdk: PumpFunSDK,
  seller: Keypair,
  mint: PublicKey,
  percentage: number,
  feeLevel: FeeLevel
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const connection = sdk.connection
  const balance = await getTokenBalance(connection, seller.publicKey, mint)
  if (balance === 0n) throw new Error('Saldo de tokens zerado')
  const sellAmount = (balance * BigInt(percentage)) / 100n
  if (sellAmount === 0n) throw new Error('Quantidade a vender e zero')

  const tx = await buildSellTx(sdk, seller, mint, sellAmount, feeLevel)
  const sig = await sendAndConfirmTransaction(connection, tx, [seller], { commitment: 'confirmed' })
  return { success: true, signature: sig }
}
