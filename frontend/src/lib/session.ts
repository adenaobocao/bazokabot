// Gerencia o estado de sessao no browser
// Dois niveis: auth (quem e o usuario) e wallet (qual chave esta ativa)

// --- AUTH (login com usuario/senha) ---
export interface AuthState {
  token: string
  username: string
}

export function saveAuth(auth: AuthState): void {
  localStorage.setItem('auth_token', auth.token)
  localStorage.setItem('auth_username', auth.username)
}

export function loadAuth(): AuthState | null {
  const token = localStorage.getItem('auth_token')
  const username = localStorage.getItem('auth_username')
  if (!token || !username) return null
  return { token, username }
}

export function clearAuth(): void {
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_username')
}

// --- WALLET SESSION (qual wallet esta ativa para assinar) ---
export interface SessionState {
  token: string
  publicKey: string
  walletLabel: string
}

export function saveSession(state: SessionState): void {
  sessionStorage.setItem('session_token', state.token)
  sessionStorage.setItem('session_pubkey', state.publicKey)
  sessionStorage.setItem('session_label', state.walletLabel)
}

export function loadSession(): SessionState | null {
  const token = sessionStorage.getItem('session_token')
  const publicKey = sessionStorage.getItem('session_pubkey')
  const walletLabel = sessionStorage.getItem('session_label')
  if (!token || !publicKey || !walletLabel) return null
  return { token, publicKey, walletLabel }
}

export function clearSession(): void {
  sessionStorage.removeItem('session_token')
  sessionStorage.removeItem('session_pubkey')
  sessionStorage.removeItem('session_label')
}

export function clearAll(): void {
  clearAuth()
  clearSession()
}

// Guarda qual wallet foi ativada por ultimo para auto-reconectar apos restart do servidor
export function saveLastWallet(publicKey: string): void {
  localStorage.setItem('last_wallet_pubkey', publicKey)
}

export function loadLastWalletPubkey(): string | null {
  return localStorage.getItem('last_wallet_pubkey')
}
