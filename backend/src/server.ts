import express from 'express'
import cors from 'cors'
import path from 'path'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import { healthRouter } from './routes/health'
import { walletRouter } from './routes/wallet'
import { tokenRouter } from './routes/token'
import { monitorRouter } from './routes/monitor'
import { sessionMiddleware } from './middleware/session'
import { authRouter, authMiddleware } from './routes/auth'

dotenv.config()

const app = express()
const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer })

// Armazena conexoes WebSocket ativas por session token
export const wsClients = new Map<string, InstanceType<typeof WebSocketServer>['clients'] extends Set<infer T> ? T : never>()

const isProd = process.env.NODE_ENV === 'production'

app.use(cors({
  origin: isProd ? false : 'http://localhost:5173',
  credentials: true,
}))

app.use(express.json({ limit: '10mb' }))

// Rotas publicas (sem autenticacao)
app.use('/api/health', healthRouter)
app.use('/api/auth', authRouter)

// Todas as outras rotas exigem auth primeiro, depois wallet session para operacoes
const AUTH_PUBLIC = ['/auth/login', '/auth/logout']
const WALLET_SESSION_PUBLIC = ['/wallet/session', '/wallet/generate']

app.use('/api', (req, res, next) => {
  const sub = req.path
  // Rotas publicas de auth e wallet nao precisam de nada
  if (AUTH_PUBLIC.some(p => sub === p || sub.startsWith(p + '/'))) return next()
  if (WALLET_SESSION_PUBLIC.some(p => sub === p || sub.startsWith(p + '/'))) return authMiddleware(req, res, next)
  // Demais rotas: auth + wallet session
  return authMiddleware(req, res, () => sessionMiddleware(req, res, next))
})

app.use('/api/wallet', walletRouter)
app.use('/api/token', tokenRouter)
app.use('/api/monitor', monitorRouter)

// WebSocket: associa conexao ao session token
wss.on('connection', (ws, req) => {
  const token = new URL(req.url || '', `http://localhost`).searchParams.get('token')
  if (!token) {
    ws.close(4001, 'Token required')
    return
  }

  wsClients.set(token, ws)

  ws.on('close', () => {
    wsClients.delete(token)
  })

  ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket conectado' }))
})

// Em producao: serve o frontend buildado (pasta public/ dentro do backend)
if (isProd) {
  const publicDir = path.join(__dirname, '..', 'public')
  app.use(express.static(publicDir))
  // SPA fallback: qualquer rota nao-API retorna o index.html
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      res.sendFile(path.join(publicDir, 'index.html'))
    }
  })
}

const PORT = process.env.PORT || 4000

httpServer.listen(PORT, () => {
  console.log(`Pump Launcher backend rodando na porta ${PORT}`)
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`)
})
