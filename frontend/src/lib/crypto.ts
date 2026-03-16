// Limpa dados do sistema antigo (senhas por wallet, bundles globais)
// Chamado uma vez na inicializacao do app
export function clearLegacyStorage(): void {
  localStorage.removeItem('pump_wallets')       // wallets antigas com encryptedKey
  localStorage.removeItem('pump_bundle_wallets') // bundles antigas sem namespace
}

// Aceita private key em base58 ("5Jxxx...") OU array de bytes do Phantom ("[123,45,...]")
export async function parsePrivateKeyFull(raw: string): Promise<{ base58: string; publicKey: string }> {
  const { Keypair } = await import('@solana/web3.js')
  const { default: bs58 } = await import('bs58')
  const trimmed = raw.trim()

  let secretKey: Uint8Array

  if (trimmed.startsWith('[')) {
    let arr: number[]
    try {
      arr = JSON.parse(trimmed)
      if (!Array.isArray(arr) || arr.length !== 64) throw new Error()
    } catch {
      throw new Error('Formato invalido — esperado array de 64 numeros ex: [12,34,...]')
    }
    secretKey = Uint8Array.from(arr)
  } else {
    try {
      secretKey = bs58.decode(trimmed)
    } catch {
      throw new Error('Formato invalido — cole a base58 ou o array do Phantom/Solflare')
    }
  }

  try {
    const kp = Keypair.fromSecretKey(secretKey)
    return { base58: bs58.encode(secretKey), publicKey: kp.publicKey.toBase58() }
  } catch {
    throw new Error('Private key invalida')
  }
}

// --- MAIN WALLETS (plaintext — protegidas pelo login do app, nao por senha individual) ---

export interface StoredWallet {
  label: string
  publicKey: string
  privateKeyBase58: string
}

export function saveWallet(wallet: StoredWallet): void {
  const wallets = loadWallets()
  const idx = wallets.findIndex(w => w.publicKey === wallet.publicKey)
  if (idx >= 0) wallets[idx] = wallet
  else wallets.push(wallet)
  localStorage.setItem('pump_wallets_v2', JSON.stringify(wallets))
}

export function loadWallets(): StoredWallet[] {
  try {
    const raw: unknown[] = JSON.parse(localStorage.getItem('pump_wallets_v2') || '[]')
    return raw.filter((w): w is StoredWallet =>
      typeof w === 'object' && w !== null &&
      typeof (w as StoredWallet).privateKeyBase58 === 'string' &&
      typeof (w as StoredWallet).publicKey === 'string'
    )
  } catch { return [] }
}

export function removeWallet(publicKey: string): void {
  localStorage.setItem('pump_wallets_v2', JSON.stringify(loadWallets().filter(w => w.publicKey !== publicKey)))
}

// --- BUNDLE WALLETS (plaintext, por main wallet) ---

export interface BundleStoredWallet {
  label: string
  publicKey: string
  privateKeyBase58: string
}

function bundleKey(mainPubkey: string) {
  return `pump_bundle_wallets_${mainPubkey}`
}

export function saveBundleWallet(wallet: BundleStoredWallet, mainPubkey: string): void {
  const wallets = loadBundleWallets(mainPubkey)
  const idx = wallets.findIndex(w => w.publicKey === wallet.publicKey)
  if (idx >= 0) wallets[idx] = wallet
  else wallets.push(wallet)
  localStorage.setItem(bundleKey(mainPubkey), JSON.stringify(wallets))
}

export function loadBundleWallets(mainPubkey: string): BundleStoredWallet[] {
  try { return JSON.parse(localStorage.getItem(bundleKey(mainPubkey)) || '[]') }
  catch { return [] }
}

export function removeBundleWallet(publicKey: string, mainPubkey: string): void {
  localStorage.setItem(bundleKey(mainPubkey), JSON.stringify(
    loadBundleWallets(mainPubkey).filter(w => w.publicKey !== publicKey)
  ))
}
