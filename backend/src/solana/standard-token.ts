import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

export function deriveMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBytes(), mint.toBytes()],
    TOKEN_METADATA_PROGRAM_ID,
  )
  return pda
}

function buildCreateMetadataV3Ix(
  metadata: PublicKey,
  mint: PublicKey,
  mintAuthority: PublicKey,
  payer: PublicKey,
  updateAuthority: PublicKey,
  name: string,
  symbol: string,
  uri: string,
): TransactionInstruction {
  const nameBytes = Buffer.from(name, 'utf8')
  const symbolBytes = Buffer.from(symbol, 'utf8')
  const uriBytes = Buffer.from(uri, 'utf8')

  const size =
    1 +                        // instruction index (33)
    4 + nameBytes.length +
    4 + symbolBytes.length +
    4 + uriBytes.length +
    2 +                        // seller_fee_basis_points (u16)
    1 +                        // creators Option::None
    1 +                        // collection Option::None
    1 +                        // uses Option::None
    1 +                        // is_mutable (bool)
    1                          // collection_details Option::None

  const buf = Buffer.alloc(size)
  let off = 0

  buf[off++] = 33 // CreateMetadataAccountV3 instruction index

  buf.writeUInt32LE(nameBytes.length, off); off += 4
  nameBytes.copy(buf, off); off += nameBytes.length

  buf.writeUInt32LE(symbolBytes.length, off); off += 4
  symbolBytes.copy(buf, off); off += symbolBytes.length

  buf.writeUInt32LE(uriBytes.length, off); off += 4
  uriBytes.copy(buf, off); off += uriBytes.length

  buf.writeUInt16LE(0, off); off += 2 // seller_fee_basis_points = 0

  buf[off++] = 0 // creators: None
  buf[off++] = 0 // collection: None
  buf[off++] = 0 // uses: None
  buf[off++] = 1 // is_mutable = true
  buf[off++] = 0 // collection_details: None

  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata,        isSigner: false, isWritable: true  },
      { pubkey: mint,            isSigner: false, isWritable: false },
      { pubkey: mintAuthority,   isSigner: true,  isWritable: false },
      { pubkey: payer,           isSigner: true,  isWritable: true  },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: buf,
  })
}

export interface CreateTokenParams {
  connection: Connection
  payer: Keypair
  name: string
  symbol: string
  metadataUri: string
  totalSupply: bigint   // raw amount (already with decimals applied)
  decimals: number
  revokeMintAuthority: boolean
  revokeFreezeAuthority: boolean
}

export interface CreateTokenResult {
  mint: PublicKey
  ata: PublicKey
  txId: string
}

export async function createStandardToken(params: CreateTokenParams): Promise<CreateTokenResult> {
  const { connection, payer, name, symbol, metadataUri, totalSupply, decimals, revokeMintAuthority, revokeFreezeAuthority } = params

  const mintKeypair = Keypair.generate()
  const mint = mintKeypair.publicKey

  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
  const metadataPda = deriveMetadataPda(mint)
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID)

  // freeze authority: set to payer if user wants to keep it, null otherwise
  const freezeAuthority = revokeFreezeAuthority ? null : payer.publicKey

  const tx = new Transaction()

  // 1. Create mint account
  tx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint,
    space: MINT_SIZE,
    lamports: mintRent,
    programId: TOKEN_PROGRAM_ID,
  }))

  // 2. Initialize mint
  tx.add(createInitializeMintInstruction(
    mint,
    decimals,
    payer.publicKey,    // mint authority
    freezeAuthority,    // freeze authority (null = no freeze)
    TOKEN_PROGRAM_ID,
  ))

  // 3. Create ATA
  tx.add(createAssociatedTokenAccountInstruction(
    payer.publicKey,
    ata,
    payer.publicKey,
    mint,
    TOKEN_PROGRAM_ID,
  ))

  // 4. Mint supply
  tx.add(createMintToInstruction(
    mint,
    ata,
    payer.publicKey,
    totalSupply,
    [],
    TOKEN_PROGRAM_ID,
  ))

  // 5. Metaplex metadata
  tx.add(buildCreateMetadataV3Ix(
    metadataPda,
    mint,
    payer.publicKey,
    payer.publicKey,
    payer.publicKey,
    name,
    symbol,
    metadataUri,
  ))

  // 6. Revoke mint authority (after minting)
  if (revokeMintAuthority) {
    tx.add(createSetAuthorityInstruction(
      mint,
      payer.publicKey,
      AuthorityType.MintTokens,
      null,
      [],
      TOKEN_PROGRAM_ID,
    ))
  }

  const txId = await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair], {
    commitment: 'confirmed',
  })

  return { mint, ata, txId }
}
