import { Router } from 'express'
import crypto from 'crypto'

export const authRouter = Router()

// Tokens de auth (sem private key — so identidade)
// Separados das sessoes de wallet
export const authTokens = new Map<string, { username: string; createdAt: number }>()

const AUTH_TTL_MS = 12 * 60 * 60 * 1000 // 12 horas

function parseUsers(): Map<string, string> {
  const users = new Map<string, string>()
  const raw = process.env.APP_USERS || ''
  for (const entry of raw.split(',')) {
    const [username, ...passwordParts] = entry.trim().split(':')
    const password = passwordParts.join(':')
    if (username && password) {
      users.set(username.toLowerCase(), password)
    }
  }
  return users
}

// POST /api/auth/login
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    res.status(400).json({ error: 'Usuario e senha obrigatorios' })
    return
  }

  const users = parseUsers()
  const expected = users.get((username as string).toLowerCase())

  if (!expected || expected !== password) {
    res.status(401).json({ error: 'Usuario ou senha incorretos', type: 'auth' })
    return
  }

  const token = crypto.randomBytes(32).toString('hex')
  authTokens.set(token, { username: (username as string).toLowerCase(), createdAt: Date.now() })

  res.json({ token, username: (username as string).toLowerCase() })
})

// DELETE /api/auth/logout
authRouter.delete('/logout', (req, res) => {
  const token = req.headers['x-auth-token'] as string | undefined
  if (token) authTokens.delete(token)
  res.json({ ok: true })
})

// Middleware: valida auth token (nao wallet session)
export function authMiddleware(req: any, res: any, next: any) {
  const token = req.headers['x-auth-token'] as string | undefined
  if (!token) {
    res.status(401).json({ error: 'Auth token obrigatorio', type: 'auth' })
    return
  }
  const auth = authTokens.get(token)
  if (!auth) {
    res.status(401).json({ error: 'Nao autenticado', type: 'auth' })
    return
  }
  if (Date.now() - auth.createdAt > AUTH_TTL_MS) {
    authTokens.delete(token)
    res.status(401).json({ error: 'Sessao expirada, faca login novamente', type: 'auth' })
    return
  }
  auth.createdAt = Date.now()
  req.authUser = auth.username
  next()
}
