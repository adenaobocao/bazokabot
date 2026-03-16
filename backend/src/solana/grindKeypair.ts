import { Worker } from 'worker_threads'
import { Keypair } from '@solana/web3.js'

// Codigo do worker como string — evita dependencia de arquivo separado
// Roda em paralelo em multiplos threads para achar um keypair com o sufixo desejado
const WORKER_CODE = `
const { Keypair } = require('@solana/web3.js')
const { parentPort, workerData } = require('worker_threads')
const suffix = workerData.suffix
while (true) {
  const kp = Keypair.generate()
  if (kp.publicKey.toBase58().endsWith(suffix)) {
    parentPort.postMessage(Array.from(kp.secretKey))
    break
  }
}
`

export function grindMintKeypair(
  suffix = 'pump',
  timeoutMs = 120_000
): Promise<Keypair> {
  return new Promise((resolve) => {
    const cpuCount = require('os').cpus().length
    const numWorkers = Math.min(cpuCount, 8)
    let done = false
    const workers: Worker[] = []

    const cleanup = () => {
      workers.forEach(w => w.terminate().catch(() => {}))
    }

    // Timeout: se demorar demais, usa keypair aleatorio como fallback
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      console.warn(`[grind] Timeout apos ${timeoutMs}ms — usando keypair aleatorio`)
      resolve(Keypair.generate())
    }, timeoutMs)

    for (let i = 0; i < numWorkers; i++) {
      const w = new Worker(WORKER_CODE, {
        eval: true,
        workerData: { suffix },
      })
      workers.push(w)

      w.on('message', (arr: number[]) => {
        if (done) return
        done = true
        clearTimeout(timer)
        cleanup()
        resolve(Keypair.fromSecretKey(Uint8Array.from(arr)))
      })

      w.on('error', () => {
        // ignora erros individuais de worker
      })
    }
  })
}
