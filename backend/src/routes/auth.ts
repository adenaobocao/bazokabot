import { Router } from 'express'
import crypto from 'crypto'

export const authRouter = Router()

// Auth stateless: token = base64url(username) + "." + HMAC(username, password+salt)
// Nao precisa de estado no servidor — sobrevive a restarts e redeploys
const TOKEN_SALT = 'pump-launcher-auth-v1'

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

function makeToken(username: string, password: string): string {
  const user = username.toLowerCase()
  const hmac = crypto.createHmac('sha256', password + TOKEN_SALT).update(user).digest('hex')
  return Buffer.from(user).toString('base64url') + '.' + hmac
}

function validateToken(token: string): string | null {
  try {
    const dot = token.indexOf('.')
    if (dot < 0) return null
    const username = Buffer.from(token.slice(0, dot), 'base64url').toString()
    const hmac = token.slice(dot + 1)
    const users = parseUsers()
    const password = users.get(username)
    if (!password) return null
    const expected = crypto.createHmac('sha256', password + TOKEN_SALT).update(username).digest('hex')
    if (hmac.length !== expected.length) return null
    if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'))) return null
    return username
  } catch { return null }
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

  const token = makeToken(username as string, expected)
  res.json({ token, username: (username as string).toLowerCase() })
})

// DELETE /api/auth/logout — client descarta o token localmente
authRouter.delete('/logout', (_req, res) => {
  res.json({ ok: true })
})

// Middleware: valida auth token sem precisar de estado no servidor
export function authMiddleware(req: any, res: any, next: any) {
  const token = req.headers['x-auth-token'] as string | undefined
  if (!token) {
    res.status(401).json({ error: 'Auth token obrigatorio', type: 'auth' })
    return
  }
  const username = validateToken(token)
  if (!username) {
    res.status(401).json({ error: 'Nao autenticado', type: 'auth' })
    return
  }
  req.authUser = username
  next()
}
