// Gerencia o estado de sessao no browser
// Dois niveis: auth (quem e o usuario) e wallet (qual chave esta ativa)

// --- AUTH (login com usuario/senha) ---
export interface AuthState {
  token: string
  username: string
}

export function saveAuth(auth: AuthState): void {
  sessionStorage.setItem('auth_token', auth.token)
  sessionStorage.setItem('auth_username', auth.username)
}

export function loadAuth(): AuthState | null {
  const token = sessionStorage.getItem('auth_token')
  const username = sessionStorage.getItem('auth_username')
  if (!token || !username) return null
  return { token, username }
}

export function clearAuth(): void {
  sessionStorage.removeItem('auth_token')
  sessionStorage.removeItem('auth_username')
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
