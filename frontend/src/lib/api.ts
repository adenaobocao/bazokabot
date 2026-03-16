// Cliente HTTP centralizado — injeta auth token e session token automaticamente

const BASE_URL = '/api'

// Callbacks globais para 401
let onAuthExpired: (() => void) | null = null
let onSessionExpired: (() => void) | null = null

export function setAuthExpiredHandler(fn: () => void) {
  onAuthExpired = fn
}
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const authToken = sessionStorage.getItem('auth_token')
  if (authToken) headers['x-auth-token'] = authToken

  const sessionToken = sessionStorage.getItem('session_token')
  if (sessionToken) headers['x-session-token'] = sessionToken

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json()

  if (res.status === 401) {
    if (data.type === 'session') {
      // Wallet session expirou — limpa so a sessao de wallet
      sessionStorage.removeItem('session_token')
      sessionStorage.removeItem('session_pubkey')
      sessionStorage.removeItem('session_label')
      onSessionExpired?.()
    } else {
      // Auth expirou — logout completo
      sessionStorage.clear()
      onAuthExpired?.()
    }
    throw new Error(data.error || 'Nao autorizado')
  }

  if (!res.ok) {
    throw new Error(data.error || `Erro ${res.status}`)
  }

  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
