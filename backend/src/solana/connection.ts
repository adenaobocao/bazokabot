import { Connection, Keypair } from '@solana/web3.js'
import { AnchorProvider } from '@coral-xyz/anchor'
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet'
import dotenv from 'dotenv'

dotenv.config()

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`

// Singleton connection — reutiliza pra evitar overhead de reconexao
let _connection: Connection | null = null

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: RPC_URL.replace('https://', 'wss://'),
    })
  }
  return _connection
}

// Cria um AnchorProvider para o SDK com o keypair da sessao
export function getProvider(keypair: Keypair): AnchorProvider {
  const connection = getConnection()
  const wallet = new NodeWallet(keypair)
  return new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })
}
