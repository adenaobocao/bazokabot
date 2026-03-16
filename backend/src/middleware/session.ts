import { Request, Response, NextFunction } from 'express'

// Sessoes ativas em memoria: token → { walletPublicKey, privateKeyBuffer, createdAt }
// A private key NUNCA vai pro disco — fica so aqui em memoria RAM
export interface ActiveSession {
  token: string
  walletPublicKey: string
  privateKeyBytes: Uint8Array  // Descartado quando a sessao expira
  createdAt: number
}

export const sessions = new Map<string, ActiveSession>()

// Sessao expira em 2 horas de inatividade
const SESSION_TTL_MS = 2 * 60 * 60 * 1000

export function sessionMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['x-session-token'] as string | undefined

  if (!token) {
    res.status(401).json({ error: 'Wallet nao ativada', type: 'session' })
    return
  }

  const session = sessions.get(token)

  if (!session) {
    res.status(401).json({ error: 'Sessao de wallet invalida ou expirada', type: 'session' })
    return
  }

  // Verifica TTL
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    // Zera a key da memoria antes de deletar
    session.privateKeyBytes.fill(0)
    sessions.delete(token)
    res.status(401).json({ error: 'Sessao de wallet expirada, ative novamente', type: 'session' })
    return
  }

  // Renova o timestamp de atividade
  session.createdAt = Date.now()

  // Disponibiliza a sessao para os handlers
  ;(req as any).session = session

  next()
}

export function getSession(token: string): ActiveSession | undefined {
  return sessions.get(token)
}
