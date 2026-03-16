import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { savePosition } from '../lib/positions'
import { useSession } from '../lib/SessionContext'
import BundleManager, { BundleWallet } from '../components/BundleManager'
import DevWalletPicker, { DevWalletConfig } from '../components/DevWalletPicker'

type FeeLevel = 'normal' | 'fast' | 'turbo' | 'mayhem'

const FEE_LABELS: Record<FeeLevel, string> = {
  normal: 'Normal',
  fast: 'Fast',
  turbo: 'Turbo',
  mayhem: 'Mayhem',
}

export default function DeployPage() {
  const { session } = useSession()
  const navigate = useNavigate()

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <p className="text-gray-300 font-medium">Nenhuma wallet ativa</p>
        <p className="text-gray-500 text-sm max-w-xs">
          Clique em <span className="text-brand">selecionar wallet</span> no canto superior direito para ativar uma wallet antes de fazer deploy.
        </p>
      </div>
    )
  }

  // Metadata
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [website, setWebsite] = useState('')

  // Imagem
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  // Dev wallet
  const [devWallet, setDevWallet] = useState<DevWalletConfig>({ type: 'main', publicKey: session?.publicKey })

  // Deploy config
  const [devBuySol, setDevBuySol] = useState('2')
  const [feeLevel, setFeeLevel] = useState<FeeLevel>('fast')
  const [useJito, setUseJito] = useState(false)
  const [grindMint, setGrindMint] = useState(false)
  const [mayhemMode, setMayhemMode] = useState(false)

  // Bundle
  const [bundleEnabled, setBundleEnabled] = useState(false)
  const [bundleWallets, setBundleWallets] = useState<BundleWallet[]>([])

  // Saldos
  const [mainBalance, setMainBalance] = useState<number | undefined>(undefined)
  const [devBalance, setDevBalance] = useState<number | undefined>(undefined)

  // Estado da operacao
  const [step, setStep] = useState<'idle' | 'grinding' | 'uploading' | 'deploying' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<{
    mint?: string; bundleId?: string; signature?: string; error?: string
  } | null>(null)

  async function refreshMainBalance() {
    if (!session?.publicKey) return
    const res = await api.get<{ balances: Array<{ address: string; sol: number }> }>(
      `/wallet/balances?addresses=${session.publicKey}`
    )
    setMainBalance(res.balances[0]?.sol)
  }

  // Busca saldo da wallet principal ao montar
  useEffect(() => {
    refreshMainBalance().catch(() => {})
  }, [session?.publicKey])

  // Atualiza saldo da dev wallet quando ela muda
  useEffect(() => {
    if (!devWallet.publicKey || devWallet.type === 'main') {
      setDevBalance(undefined)
      return
    }
    api.get<{ balances: Array<{ address: string; sol: number }> }>(
      `/wallet/balances?addresses=${devWallet.publicKey}`
    ).then(res => setDevBalance(res.balances[0]?.sol)).catch(() => {})
  }, [devWallet.publicKey, devWallet.type])

  async function refreshDevBalance() {
    if (!devWallet.publicKey || devWallet.type === 'main') return
    const res = await api.get<{ balances: Array<{ address: string; sol: number }> }>(
      `/wallet/balances?addresses=${devWallet.publicKey}`
    )
    setDevBalance(res.balances[0]?.sol)
  }

  // Drag & Drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file?.type.startsWith('image/')) {
      setImageFile(file)
      setImagePreview(URL.createObjectURL(file))
    }
  }, [])

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setImageFile(file)
      setImagePreview(URL.createObjectURL(file))
    }
  }

  async function handleDeploy() {
    if (!name || !symbol || !imageFile) {
      setResult({ error: 'Nome, ticker e imagem sao obrigatorios' })
      setStep('error')
      return
    }

    // Valida fresh wallet
    if (devWallet.type === 'fresh' && !devWallet.privateKeyBase58) {
      setResult({ error: 'Fresh wallet nao foi criada corretamente' })
      setStep('error')
      return
    }

    // Valida bundle antes de comecar
    if (bundleEnabled && bundleWallets.length > 0) {
      const locked = bundleWallets.filter(w => !w.privateKeyBase58)
      if (locked.length > 0) {
        setResult({ error: `Desbloqueie as wallets: ${locked.map(w => w.label).join(', ')}` })
        setStep('error')
        return
      }
      const unfunded = bundleWallets.filter(w => w.solBalance < w.buySol && w.solBalance > 0)
      if (unfunded.length > 0) {
        setResult({ error: `Saldo insuficiente em: ${unfunded.map(w => w.label).join(', ')}` })
        setStep('error')
        return
      }
    }

    setStep('uploading')
    setResult(null)

    try {
      // 1. Upload imagem
      const imageBase64 = await fileToBase64(imageFile)
      setStep('uploading')
      const uploadRes = await api.post<{ metadataUri: string }>('/token/upload-image', {
        imageBase64,
        mimeType: imageFile.type,
        name, symbol, description,
        twitter: twitter || undefined,
        telegram: telegram || undefined,
        website: website || undefined,
      })

      setStep(grindMint ? 'grinding' : 'deploying')

      // 2. Monta lista de bundle wallets (com PKs ja decriptadas)
      const bundleList = bundleEnabled
        ? bundleWallets
            .filter(w => w.buySol > 0 && w.privateKeyBase58)
            .map(w => ({ privateKeyBase58: w.privateKeyBase58, buySol: w.buySol }))
        : []

      // 3. Deploy
      const deployRes = await api.post<{
        success: boolean
        mint?: string
        bundleId?: string
        signature?: string
        error?: string
        canRetrySequential?: boolean
      }>('/token/deploy', {
        metadataUri: uploadRes.metadataUri,
        name, symbol,
        devBuySol: parseFloat(devBuySol) || 0,
        feeLevel: mayhemMode ? 'mayhem' : feeLevel,
        bundleWallets: bundleList,
        useJito,
        grindMint,
        devWalletPrivateKey: devWallet.type === 'fresh' ? devWallet.privateKeyBase58 : undefined,
      })

      if (!deployRes.success && deployRes.canRetrySequential) {
        setResult({
          error: `Jito falhou: ${deployRes.error}. Desative Jito e tente novamente.`,
          mint: deployRes.mint,
        })
        setStep('error')
        return
      }

      if (!deployRes.success) {
        setResult({ error: deployRes.error })
        setStep('error')
        return
      }

      // 4. Salva posicao
      if (deployRes.mint && session) {
        savePosition({
          mint: deployRes.mint,
          name, symbol,
          openedAt: Date.now(),
          devBuySol: parseFloat(devBuySol) || 0,
          devTokenAmount: '0',
          devBuyPriceSol: 0,
          devWalletPublicKey: devWallet.type === 'fresh' ? devWallet.publicKey : undefined,
          devWalletPrivateKey: devWallet.type === 'fresh' ? devWallet.privateKeyBase58 : undefined,
          bundleWallets: bundleEnabled
            ? bundleWallets.map(w => ({
                publicKey: w.publicKey,
                privateKeyBase58: w.privateKeyBase58,
                label: w.label,
                buySol: w.buySol,
                tokenAmount: '0',
                buyPriceSol: 0,
              }))
            : [],
          totalSolSpent:
            (parseFloat(devBuySol) || 0) +
            bundleWallets.reduce((s, w) => s + w.buySol, 0),
          signature: deployRes.signature,
          bundleId: deployRes.bundleId,
        })
      }

      setResult({ mint: deployRes.mint, bundleId: deployRes.bundleId, signature: deployRes.signature })
      setStep('done')
      // Reset form
      setName('')
      setSymbol('')
      setDescription('')
      setTwitter('')
      setTelegram('')
      setWebsite('')
      setImageFile(null)
      setImagePreview('')
      setBundleWallets([])
      // Navega automaticamente para o monitor apos 1.5s
      setTimeout(() => navigate('/monitor'), 1500)
    } catch (err: unknown) {
      setResult({ error: err instanceof Error ? err.message : 'Erro desconhecido' })
      setStep('error')
    }
  }

  const isLoading = step === 'grinding' || step === 'uploading' || step === 'deploying'

  return (
    <div className="space-y-5 max-w-2xl">
      <h2 className="font-bold text-lg">Deploy de Token</h2>

      {/* Imagem */}
      <div
        ref={dropRef}
        onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById('fileInput')?.click()}
        className={`border-2 border-dashed rounded-lg flex items-center justify-center cursor-pointer transition-colors
          ${isDragging ? 'border-brand bg-brand-dark/30' : 'border-surface-600 hover:border-brand'}
          ${imagePreview ? 'h-36' : 'h-24'}`}
      >
        {imagePreview
          ? <img src={imagePreview} alt="preview" className="h-full w-auto rounded object-contain p-1" />
          : <span className="text-gray-400 text-sm">arraste a imagem aqui ou clique</span>
        }
        <input id="fileInput" type="file" accept="image/*" className="hidden" onChange={handleFileInput} />
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Nome *</label>
          <input value={name} onChange={e => setName(e.target.value)} className="w-full" placeholder="My Token" />
        </div>
        <div>
          <label className="label">Ticker *</label>
          <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} className="w-full" placeholder="MTK" maxLength={10} />
        </div>
      </div>

      <div>
        <label className="label">Descricao</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full h-16 resize-none" placeholder="Descricao..." />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Twitter</label>
          <input value={twitter} onChange={e => setTwitter(e.target.value)} className="w-full" placeholder="https://x.com/..." />
        </div>
        <div>
          <label className="label">Telegram</label>
          <input value={telegram} onChange={e => setTelegram(e.target.value)} className="w-full" placeholder="https://t.me/..." />
        </div>
        <div>
          <label className="label">Website</label>
          <input value={website} onChange={e => setWebsite(e.target.value)} className="w-full" placeholder="https://..." />
        </div>
      </div>

      {/* Dev buy + fees */}
      <div className="card space-y-3">
        <p className="text-sm font-semibold text-gray-300">Configuracao de compra</p>

        {/* Dev wallet selector */}
        <div>
          <label className="label">Dev wallet</label>
          <DevWalletPicker
            value={devWallet}
            onChange={setDevWallet}
            devBuySol={parseFloat(devBuySol) || 0}
            mainPublicKey={session?.publicKey}
            mainBalance={mainBalance}
            devBalance={devBalance}
            onDevBalanceRefresh={refreshDevBalance}
            onMainBalanceRefresh={refreshMainBalance}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Dev buy (SOL)</label>
            <div className="flex gap-1.5">
              <input
                type="number"
                value={devBuySol}
                onChange={e => setDevBuySol(e.target.value)}
                className="flex-1"
                min="0"
                step="0.5"
              />
              {[1, 2, 5].map(v => (
                <button
                  key={v}
                  onClick={() => setDevBuySol(String(v))}
                  className={`px-2 py-1 rounded text-xs transition-colors
                    ${devBuySol === String(v) ? 'bg-brand text-black' : 'bg-surface-700 text-gray-400 hover:text-white'}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label">Fee level</label>
            <div className="flex gap-1">
              {(Object.keys(FEE_LABELS) as FeeLevel[]).map(level => (
                <button
                  key={level}
                  onClick={() => { setFeeLevel(level); if (level === 'mayhem') setMayhemMode(true) }}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold transition-colors ${
                    feeLevel === level
                      ? level === 'mayhem' ? 'bg-danger text-white' : 'bg-brand text-black'
                      : 'bg-surface-700 text-gray-400 hover:text-white'
                  }`}
                >
                  {FEE_LABELS[level]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-4 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={useJito} onChange={e => { setUseJito(e.target.checked); if (e.target.checked) alert('Aviso: Jito esta com problemas e provavelmente vai falhar. Recomendado manter desativado.') }} className="accent-brand" />
            <span className="text-sm">Jito bundle</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer" title="Gera mint address terminando em 'pump'. Usa CPU por varios segundos.">
            <input type="checkbox" checked={grindMint} onChange={e => setGrindMint(e.target.checked)} className="accent-brand" />
            <span className="text-sm">Mint com sufixo pump</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={mayhemMode}
              onChange={e => { setMayhemMode(e.target.checked); if (e.target.checked) setFeeLevel('mayhem') }}
              className="accent-danger"
            />
            <span className="text-sm text-danger font-semibold">Mayhem mode</span>
          </label>
        </div>
      </div>

      {/* Bundle */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-300">Bundle wallets</p>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={bundleEnabled} onChange={e => setBundleEnabled(e.target.checked)} className="accent-brand" />
            <span className="text-sm">Ativar bundle</span>
          </label>
        </div>

        {bundleEnabled && (
          <BundleManager
            wallets={bundleWallets}
            onChange={setBundleWallets}
            mainPublicKey={session?.publicKey}
            mainBalance={mainBalance}
            devWalletPublicKey={devWallet.type === 'fresh' ? devWallet.publicKey : session?.publicKey}
            devWalletBalance={devWallet.type === 'fresh' ? devBalance : mainBalance}
            devWalletPrivateKey={devWallet.type === 'fresh' ? devWallet.privateKeyBase58 : undefined}
            onMainBalanceRefresh={refreshMainBalance}
          />
        )}
      </div>

      {/* Resultado */}
      {result?.error && step === 'error' && (
        <div className="bg-red-900/30 border border-danger/40 rounded p-3 text-danger text-sm">
          {result.error}
        </div>
      )}

      {step === 'done' && result?.mint && (
        <div className="bg-brand-dark/40 border border-brand/40 rounded-lg p-4 space-y-2">
          <p className="text-brand font-bold">Token deployado! Redirecionando para o monitor...</p>
          <p className="text-xs text-gray-300 font-mono break-all">Mint: {result.mint}</p>
          {result.bundleId && <p className="text-xs text-gray-400">Bundle ID: <span className="font-mono">{result.bundleId}</span></p>}
          <div className="flex gap-2 mt-2">
            <a href={`https://pump.fun/coin/${result.mint}`} target="_blank" rel="noopener noreferrer" className="btn-ghost text-xs">
              abrir no pump.fun
            </a>
            <button onClick={() => navigator.clipboard.writeText(result.mint!)} className="btn-ghost text-xs">
              copiar mint
            </button>
            <button onClick={() => navigate('/monitor')} className="btn-primary text-xs">
              ir para monitor agora
            </button>
          </div>
        </div>
      )}

      <button
        onClick={handleDeploy}
        disabled={isLoading}
        className="btn-primary w-full py-3 text-base font-bold"
      >
        {step === 'grinding'  && 'gerando mint pump... (pode demorar)'}
        {step === 'uploading' && 'fazendo upload...'}
        {step === 'deploying' && 'deployando...'}
        {(step === 'idle' || step === 'done' || step === 'error') && 'deploy'}
      </button>
    </div>
  )
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
