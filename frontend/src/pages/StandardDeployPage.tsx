import { useState, useRef, useCallback, useEffect } from 'react'
import { api } from '../lib/api'
import { loadLpPositions, saveLpPosition, removeLpPosition, LpPosition } from '../lib/lp-positions'
import { loadBundleWallets } from '../lib/crypto'
import { useSession } from '../lib/SessionContext'

type Platform = 'raydium' | 'meteora'
type Step = 'form' | 'uploading' | 'creating-token' | 'adding-lp' | 'sniping' | 'done'

interface SnipeResult {
  results: Array<{ wallet: string; txId: string; type: string }>
  freshWalletKey?: string
}

const RAYDIUM_FEE_TIERS = ['0.01%', '0.05%', '0.25%', '0.30%', '0.50%', '1%']
const METEORA_FEE_TIERS = ['0.10%', '0.25%', '0.30%', '1%']

interface TokenResult {
  mint: string
  txId: string
  rawSupply: string
}

interface LpResult {
  poolId?: string     // raydium
  poolAddress?: string // meteora
  lpMint: string
  txId: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toLocalDatetimeInputValue(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StandardDeployPage() {
  const { session } = useSession()

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <p className="text-gray-300 font-medium">Nenhuma wallet ativa</p>
        <p className="text-gray-500 text-sm max-w-xs">
          Selecione uma wallet no canto superior direito antes de fazer deploy.
        </p>
      </div>
    )
  }

  // Token fields
  const [name, setName]           = useState('')
  const [symbol, setSymbol]       = useState('')
  const [description, setDesc]    = useState('')
  const [totalSupply, setSupply]  = useState('1000000000')
  const [decimals, setDecimals]   = useState<6 | 9>(6)
  const [revokeMint, setRevokeMint]     = useState(true)
  const [revokeFreeze, setRevokeFreeze] = useState(true)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  // LP fields
  const [platform, setPlatform] = useState<Platform>('raydium')
  const [lpPercent, setLpPercent] = useState(80)
  const [solAmount, setSolAmount] = useState('')
  const [feeTier, setFeeTier]     = useState('0.50%')
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('now')
  const [scheduledAt, setScheduledAt]   = useState(() =>
    toLocalDatetimeInputValue(Date.now() + 60 * 60 * 1000) // +1h
  )

  // Snipe fields
  const [snipeEnabled, setSnipeEnabled]     = useState(false)
  const [devBuySol, setDevBuySol]           = useState('1')
  const [useFreshWallet, setUseFreshWallet] = useState(false)
  const [slippageBps, setSlippageBps]       = useState(500)
  const [bundleEnabled, setBundleEnabled]   = useState(false)
  // bundle wallets carregados do localStorage (mesmos da pump page)
  const [bundleBuys, setBundleBuys] = useState<Record<string, string>>({}) // pubkey → buyAmountSol

  // State machine
  const [step, setStep]   = useState<Step>('form')
  const [error, setError] = useState('')

  // Results
  const [tokenResult, setTokenResult] = useState<TokenResult | null>(null)
  const [lpResult, setLpResult]       = useState<LpResult | null>(null)
  const [snipeResult, setSnipeResult] = useState<SnipeResult | null>(null)

  // LP positions from localStorage
  const [positions, setPositions] = useState<LpPosition[]>([])
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<Record<string, string>>({})

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setPositions(loadLpPositions())
  }, [])

  // Sync fee tier default when platform changes
  useEffect(() => {
    if (platform === 'raydium') setFeeTier('0.50%')
    else setFeeTier('0.25%')
  }, [platform])

  // ── Image handling ──────────────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    setImageFile(file)
    const reader = new FileReader()
    reader.onload = e => setImagePreview(e.target?.result as string)
    reader.readAsDataURL(file)
  }, [])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  // ── Computed values ─────────────────────────────────────────────────────────

  const rawSupply = BigInt(Math.round(Number(totalSupply || 0))) * BigInt(10 ** decimals)
  const tokenForLp = (rawSupply * BigInt(lpPercent)) / 100n

  function formatTokenAmount(raw: bigint): string {
    const divisor = BigInt(10 ** decimals)
    const whole = raw / divisor
    return Number(whole).toLocaleString('pt-BR')
  }

  // ── Deploy flow ─────────────────────────────────────────────────────────────

  async function handleDeploy() {
    setError('')

    if (!name || !symbol || !imageFile || !totalSupply || !solAmount) {
      setError('Preencha nome, símbolo, imagem, supply e SOL.')
      return
    }
    if (Number(solAmount) <= 0) {
      setError('SOL amount deve ser maior que zero.')
      return
    }

    try {
      // Step 1: upload metadata
      setStep('uploading')
      const base64 = await fileToBase64(imageFile)
      const { metadataUri } = await api.post<{ metadataUri: string; imageUri: string }>(
        '/standard/upload-metadata',
        { imageBase64: base64, mimeType: imageFile.type, name, symbol, description }
      )

      // Step 2: create token
      setStep('creating-token')
      const tokenRes = await api.post<TokenResult>('/standard/create-token', {
        name, symbol, metadataUri,
        totalSupply: Number(totalSupply),
        decimals,
        revokeMintAuthority: revokeMint,
        revokeFreezeAuthority: revokeFreeze,
      })
      setTokenResult(tokenRes)

      // Step 3: add liquidity
      setStep('adding-lp')
      const openTime = scheduleMode === 'later'
        ? Math.floor(new Date(scheduledAt).getTime() / 1000)
        : 0

      const rawTokenForLp = (BigInt(tokenRes.rawSupply) * BigInt(lpPercent)) / 100n

      const lpRes = await api.post<LpResult>('/standard/add-liquidity', {
        platform,
        tokenMint: tokenRes.mint,
        tokenDecimals: decimals,
        rawTokenAmount: rawTokenForLp.toString(),
        solAmount: Number(solAmount),
        feeTier,
        openTime,
      })
      setLpResult(lpRes)

      // Save LP position to localStorage
      const poolAddr = lpRes.poolId ?? lpRes.poolAddress ?? ''
      const pos: LpPosition = {
        id: tokenRes.mint,
        mint: tokenRes.mint,
        name,
        symbol,
        decimals,
        platform,
        poolAddress: poolAddr,
        lpMint: lpRes.lpMint,
        tokenAdded: rawTokenForLp.toString(),
        solAdded: Number(solAmount),
        feeTier,
        scheduledOpenTime: scheduleMode === 'later'
          ? Math.floor(new Date(scheduledAt).getTime() / 1000)
          : undefined,
        createdAt: Date.now(),
      }
      saveLpPosition(pos)
      setPositions(loadLpPositions())

      // Step 4: snipe (opcional)
      if (snipeEnabled && Number(devBuySol) > 0) {
        setStep('sniping')

        const bundleWalletsPayload = bundleEnabled
          ? loadBundleWallets(session!.publicKey)
              .filter(w => Number(bundleBuys[w.publicKey] ?? 0) > 0)
              .map(w => ({ privateKeyBase58: w.privateKeyBase58, buyAmountSol: Number(bundleBuys[w.publicKey]) }))
          : []

        const sr = await api.post<SnipeResult>('/standard/snipe', {
          tokenMint: tokenRes.mint,
          devBuySol: Number(devBuySol),
          useFreshWallet,
          bundleWallets: bundleWalletsPayload,
          slippageBps,
        })
        setSnipeResult(sr)
      }

      setStep('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido')
      setStep('form')
    }
  }

  // ── Remove liquidity ────────────────────────────────────────────────────────

  async function handleRemoveLiquidity(pos: LpPosition) {
    setRemovingId(pos.id)
    setRemoveError(prev => ({ ...prev, [pos.id]: '' }))
    try {
      await api.post('/standard/remove-liquidity', {
        platform: pos.platform,
        poolAddress: pos.poolAddress,
        lpMint: pos.lpMint,
      })
      removeLpPosition(pos.id)
      setPositions(loadLpPositions())
    } catch (err) {
      setRemoveError(prev => ({
        ...prev,
        [pos.id]: err instanceof Error ? err.message : 'Erro ao remover',
      }))
    } finally {
      setRemovingId(null)
    }
  }

  // ── Reset ───────────────────────────────────────────────────────────────────

  function handleReset() {
    setName(''); setSymbol(''); setDesc(''); setSupply('1000000000')
    setDecimals(6); setRevokeMint(true); setRevokeFreeze(true)
    setImageFile(null); setImagePreview(null)
    setLpPercent(80); setSolAmount(''); setFeeTier('0.50%')
    setScheduleMode('now')
    setTokenResult(null); setLpResult(null)
    setError('')
    setStep('form')
  }

  const busy = step !== 'form' && step !== 'done'

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-white">Standard Deploy</h1>
        <p className="text-xs text-gray-500 mt-0.5">SPL token + LP via Raydium CPMM ou Meteora DAMM v2</p>
      </div>

      {/* ── Resultado pós-deploy ─────────────────────────────────────────── */}
      {step === 'done' && tokenResult && lpResult && (
        <div className="rounded-lg border border-green-700/50 bg-green-900/20 p-4 space-y-3">
          <p className="text-green-400 font-semibold text-sm">Deploy concluído</p>
          <div className="space-y-1 text-xs font-mono">
            <Row label="Mint"     value={tokenResult.mint} />
            <Row label="Pool"     value={lpResult.poolId ?? lpResult.poolAddress ?? '—'} />
            <Row label="LP Mint"  value={lpResult.lpMint} />
            <Row label="Token TX" value={tokenResult.txId} />
            <Row label="LP TX"    value={lpResult.txId} />
          </div>

          {snipeResult && snipeResult.results.length > 0 && (
            <div className="border-t border-green-700/30 pt-3 space-y-2">
              <p className="text-green-400 text-xs font-semibold">Snipes executados</p>
              {snipeResult.results.map((r, i) => (
                <div key={i} className="text-xs font-mono space-y-0.5">
                  <p className="text-gray-400">
                    <span className="text-gray-600">[{r.type}]</span>{' '}
                    {r.wallet.slice(0, 8)}…{r.wallet.slice(-6)}
                  </p>
                  <p className="text-gray-500">TX: {r.txId}</p>
                </div>
              ))}
              {snipeResult.freshWalletKey && (
                <div className="rounded bg-yellow-900/30 border border-yellow-700/40 p-2 mt-2">
                  <p className="text-yellow-400 text-xs font-semibold mb-1">Fresh wallet — salve a private key agora</p>
                  <p className="text-yellow-200 text-xs font-mono break-all">{snipeResult.freshWalletKey}</p>
                </div>
              )}
            </div>
          )}

          <button onClick={handleReset} className="btn-ghost text-xs mt-1">
            Novo deploy
          </button>
        </div>
      )}

      {/* ── Progress ─────────────────────────────────────────────────────── */}
      {busy && (
        <div className="rounded-lg border border-brand/30 bg-brand/5 p-4">
          <p className="text-brand text-sm animate-pulse">
            {step === 'uploading'      && 'Fazendo upload da imagem e metadata para IPFS...'}
            {step === 'creating-token' && 'Criando token on-chain (SPL + Metaplex)...'}
            {step === 'adding-lp'      && `Criando pool de liquidez na ${platform === 'raydium' ? 'Raydium' : 'Meteora'}...`}
            {step === 'sniping'        && 'Sniping — aguardando Jupiter indexar a pool (pode levar ~60s)...'}
          </p>
          {(step === 'adding-lp' || step === 'sniping') && tokenResult && (
            <p className="text-xs text-gray-400 mt-1 font-mono">Mint: {tokenResult.mint}</p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded bg-danger/10 border border-danger/30 px-4 py-3 text-danger text-sm">
          {error}
        </div>
      )}

      {/* ── Formulário ───────────────────────────────────────────────────── */}
      {(step === 'form' || step === 'done') && step !== 'done' && (
        <div className="space-y-6">

          {/* Token */}
          <section className="card space-y-4">
            <h2 className="text-sm font-semibold text-gray-200 border-b border-surface-600 pb-2">
              Token
            </h2>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Nome">
                <input className="w-full" value={name} onChange={e => setName(e.target.value)} placeholder="My Token" />
              </Field>
              <Field label="Símbolo">
                <input className="w-full uppercase" value={symbol}
                  onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="MTK" />
              </Field>
            </div>

            <Field label="Descrição">
              <textarea className="w-full resize-none h-16 text-sm" value={description}
                onChange={e => setDesc(e.target.value)} placeholder="Descrição do token..." />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Supply total">
                <input className="w-full" type="number" value={totalSupply}
                  onChange={e => setSupply(e.target.value)} />
              </Field>
              <Field label="Decimals">
                <div className="flex gap-2">
                  {([6, 9] as const).map(d => (
                    <button key={d}
                      onClick={() => setDecimals(d)}
                      className={`flex-1 py-2 rounded text-sm border transition-colors ${
                        decimals === d
                          ? 'border-brand bg-brand/10 text-brand'
                          : 'border-surface-500 text-gray-400 hover:border-surface-400'
                      }`}
                    >{d}</button>
                  ))}
                </div>
              </Field>
            </div>

            {/* Imagem */}
            <Field label="Imagem">
              <div
                onDrop={onDrop}
                onDragOver={e => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-surface-500 rounded-lg p-4 cursor-pointer hover:border-brand/50 transition-colors flex items-center gap-4"
              >
                {imagePreview ? (
                  <>
                    <img src={imagePreview} className="w-14 h-14 rounded object-cover" alt="preview" />
                    <span className="text-xs text-gray-400">{imageFile?.name}</span>
                  </>
                ) : (
                  <span className="text-xs text-gray-500">Arraste a imagem ou clique para selecionar</span>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
            </Field>

            {/* Opções */}
            <div className="space-y-2">
              <p className="text-xs text-gray-500 font-medium">Opções de autoridade</p>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="checkbox" checked={revokeMint} onChange={e => setRevokeMint(e.target.checked)}
                  className="rounded" />
                <span className="text-gray-300">Revogar Mint Authority</span>
                <span className="text-gray-600 text-xs">(ninguém pode mintar mais tokens)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="checkbox" checked={revokeFreeze} onChange={e => setRevokeFreeze(e.target.checked)}
                  className="rounded" />
                <span className="text-gray-300">Revogar Freeze Authority</span>
                <span className="text-gray-600 text-xs">(ninguém pode congelar contas)</span>
              </label>
            </div>
          </section>

          {/* Liquidez */}
          <section className="card space-y-4">
            <h2 className="text-sm font-semibold text-gray-200 border-b border-surface-600 pb-2">
              Liquidez
            </h2>

            {/* Plataforma */}
            <Field label="Plataforma">
              <div className="flex gap-2">
                {(['raydium', 'meteora'] as Platform[]).map(p => (
                  <button key={p}
                    onClick={() => setPlatform(p)}
                    className={`flex-1 py-2 rounded text-sm border capitalize transition-colors ${
                      platform === p
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-surface-500 text-gray-400 hover:border-surface-400'
                    }`}
                  >
                    {p === 'raydium' ? 'Raydium CPMM' : 'Meteora DAMM v2'}
                  </button>
                ))}
              </div>
            </Field>

            {/* % do supply para LP */}
            <Field label={`% do supply para LP — ${lpPercent}%`}>
              <input type="range" min={1} max={100} value={lpPercent}
                onChange={e => setLpPercent(Number(e.target.value))}
                className="w-full accent-brand" />
              <div className="flex justify-between text-xs text-gray-600 mt-0.5">
                <span>1%</span>
                {totalSupply && (
                  <span className="text-gray-400">
                    {formatTokenAmount(tokenForLp)} {symbol || 'tokens'} → LP
                  </span>
                )}
                <span>100%</span>
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="SOL a adicionar">
                <input className="w-full" type="number" step="0.1" min="0"
                  value={solAmount} onChange={e => setSolAmount(e.target.value)}
                  placeholder="ex: 5.0" />
              </Field>
              <Field label="Fee tier">
                <select className="w-full" value={feeTier} onChange={e => setFeeTier(e.target.value)}>
                  {(platform === 'raydium' ? RAYDIUM_FEE_TIERS : METEORA_FEE_TIERS).map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>
            </div>

            {/* Abertura da pool */}
            <Field label="Abertura da pool">
              <div className="flex gap-2 mb-2">
                {(['now', 'later'] as const).map(m => (
                  <button key={m}
                    onClick={() => setScheduleMode(m)}
                    className={`px-4 py-1.5 rounded text-sm border transition-colors ${
                      scheduleMode === m
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-surface-500 text-gray-400 hover:border-surface-400'
                    }`}
                  >
                    {m === 'now' ? 'Agora' : 'Agendar'}
                  </button>
                ))}
              </div>
              {scheduleMode === 'later' && (
                <input type="datetime-local" className="w-full"
                  value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
              )}
            </Field>

            {/* Preview */}
            {solAmount && totalSupply && (
              <div className="rounded bg-surface-700 border border-surface-600 p-3 text-xs space-y-1">
                <p className="text-gray-400 font-medium">Resumo da pool</p>
                <p className="text-gray-300">
                  {formatTokenAmount(tokenForLp)} {symbol || '—'} + {solAmount} SOL
                </p>
                <p className="text-gray-500">
                  {platform === 'raydium' ? 'Raydium CPMM' : 'Meteora DAMM v2'} — fee {feeTier}
                  {scheduleMode === 'later' && ` — abre em ${new Date(scheduledAt).toLocaleString('pt-BR')}`}
                </p>
                <p className="text-yellow-500/80 text-xs mt-1">
                  Verifique o saldo da wallet antes de prosseguir.
                </p>
              </div>
            )}
          </section>

          {/* Snipe */}
          <section className="card space-y-4">
            <div className="flex items-center justify-between border-b border-surface-600 pb-2">
              <h2 className="text-sm font-semibold text-gray-200">Snipe após criar pool</h2>
              <button
                onClick={() => setSnipeEnabled(v => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
                  snipeEnabled ? 'bg-brand' : 'bg-surface-600'
                }`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  snipeEnabled ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {snipeEnabled && (
              <div className="space-y-4">
                <p className="text-xs text-gray-500">
                  Compra tokens via Jupiter logo após criar a pool. A pool pode demorar até ~60s para ser indexada — retries automáticos.
                </p>

                {/* Dev wallet */}
                <Field label="Dev wallet">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setUseFreshWallet(false)}
                      className={`flex-1 py-2 rounded text-sm border transition-colors ${
                        !useFreshWallet
                          ? 'border-brand bg-brand/10 text-brand'
                          : 'border-surface-500 text-gray-400 hover:border-surface-400'
                      }`}
                    >
                      Wallet principal
                    </button>
                    <button
                      onClick={() => setUseFreshWallet(true)}
                      className={`flex-1 py-2 rounded text-sm border transition-colors ${
                        useFreshWallet
                          ? 'border-brand bg-brand/10 text-brand'
                          : 'border-surface-500 text-gray-400 hover:border-surface-400'
                      }`}
                    >
                      Fresh wallet
                    </button>
                  </div>
                  {useFreshWallet && (
                    <p className="text-xs text-gray-500 mt-1">
                      Uma wallet nova será gerada e financiada pela wallet principal. A private key será mostrada ao final.
                    </p>
                  )}
                </Field>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Comprar (SOL)">
                    <input
                      className="w-full"
                      type="number"
                      step="0.1"
                      min="0"
                      value={devBuySol}
                      onChange={e => setDevBuySol(e.target.value)}
                      placeholder="ex: 1.0"
                    />
                  </Field>
                  <Field label="Slippage">
                    <select
                      className="w-full"
                      value={slippageBps}
                      onChange={e => setSlippageBps(Number(e.target.value))}
                    >
                      <option value={100}>1%</option>
                      <option value={300}>3%</option>
                      <option value={500}>5%</option>
                      <option value={1000}>10%</option>
                      <option value={2000}>20%</option>
                    </select>
                  </Field>
                </div>

                {/* Bundle wallets */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-400 font-medium">Bundle wallets</p>
                    <button
                      onClick={() => setBundleEnabled(v => !v)}
                      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
                        bundleEnabled ? 'bg-brand' : 'bg-surface-600'
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                        bundleEnabled ? 'translate-x-4' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>

                  {bundleEnabled && (() => {
                    const bws = loadBundleWallets(session!.publicKey)
                    if (bws.length === 0) {
                      return (
                        <p className="text-xs text-gray-500">
                          Nenhuma bundle wallet cadastrada. Adicione em Wallet Manager.
                        </p>
                      )
                    }
                    return (
                      <div className="space-y-2">
                        {bws.map(bw => (
                          <div key={bw.publicKey} className="flex items-center gap-3">
                            <span className="text-xs text-gray-400 font-mono truncate flex-1">
                              {bw.label || bw.publicKey.slice(0, 8) + '…' + bw.publicKey.slice(-6)}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                placeholder="0 SOL"
                                value={bundleBuys[bw.publicKey] ?? ''}
                                onChange={e => setBundleBuys(prev => ({
                                  ...prev,
                                  [bw.publicKey]: e.target.value,
                                }))}
                                className="w-24 text-xs"
                              />
                              <span className="text-xs text-gray-600">SOL</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              </div>
            )}
          </section>

          <button
            onClick={handleDeploy}
            disabled={busy}
            className="btn-primary w-full py-3 text-sm font-medium disabled:opacity-50"
          >
            Deploy + Criar Pool{snipeEnabled ? ' + Snipe' : ''}
          </button>
        </div>
      )}

      {/* ── Posições LP salvas ───────────────────────────────────────────── */}
      {positions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400">Posições de Liquidez</h2>
          {positions.map(pos => (
            <LpPositionCard
              key={pos.id}
              pos={pos}
              removing={removingId === pos.id}
              error={removeError[pos.id] || ''}
              onRemove={() => handleRemoveLiquidity(pos)}
              onDismissError={() => setRemoveError(prev => ({ ...prev, [pos.id]: '' }))}
            />
          ))}
        </section>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-500 font-medium">{label}</label>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-500 w-16 shrink-0">{label}:</span>
      <span className="text-gray-200 break-all">{value}</span>
    </div>
  )
}

function LpPositionCard({
  pos, removing, error, onRemove, onDismissError,
}: {
  pos: LpPosition
  removing: boolean
  error: string
  onRemove: () => void
  onDismissError: () => void
}) {
  const platformLabel = pos.platform === 'raydium' ? 'Raydium CPMM' : 'Meteora DAMM v2'
  const isScheduled = pos.scheduledOpenTime && pos.scheduledOpenTime > Date.now() / 1000

  return (
    <div className="card border border-surface-600 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-white font-medium text-sm">{pos.name}</span>
          <span className="text-gray-500 text-xs ml-2">{pos.symbol}</span>
          <span className="text-gray-600 text-xs ml-2">{platformLabel} — {pos.feeTier}</span>
        </div>
        <button
          onClick={onRemove}
          disabled={removing}
          className="btn-ghost text-xs text-danger border border-danger/30 px-3 py-1 hover:bg-danger/10 disabled:opacity-50"
        >
          {removing ? 'Removendo...' : 'Remover Liquidez'}
        </button>
      </div>

      <div className="text-xs text-gray-500 font-mono space-y-0.5">
        <p>Mint: <span className="text-gray-400">{pos.mint}</span></p>
        <p>Pool: <span className="text-gray-400">{pos.poolAddress || '—'}</span></p>
        <p>LP:   <span className="text-gray-400">{pos.lpMint}</span></p>
        <p className="text-gray-600">
          {pos.solAdded} SOL adicionados
          {isScheduled && (
            <span className="text-yellow-500/80 ml-2">
              abre {new Date(pos.scheduledOpenTime! * 1000).toLocaleString('pt-BR')}
            </span>
          )}
        </p>
      </div>

      {error && (
        <div className="text-danger text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={onDismissError} className="text-gray-500 hover:text-gray-300 ml-2">x</button>
        </div>
      )}
    </div>
  )
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Remove data URL prefix (e.g., "data:image/png;base64,")
      resolve(result.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
