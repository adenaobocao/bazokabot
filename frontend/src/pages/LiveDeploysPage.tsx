import { useState, useEffect, useCallback, useContext, useRef } from 'react'
import { api } from '../lib/api'
import { SessionContext } from '../lib/SessionContext'
import { loadAuth } from '../lib/session'

// -------------------------------------------------------
// Tipos
// -------------------------------------------------------

interface TrackedSource {
  id: string
  source_value: string
  source_type: string
  is_active: boolean
  priority: number
  last_polled_at: string | null
}

interface SignalAnalysis {
  id: string
  score: number
  score_label: 'low' | 'medium' | 'high'
  extracted_name: string
  extracted_ticker_primary: string
  extracted_ticker_alt_1: string
  extracted_ticker_alt_2: string
  short_description: string
  confidence: number
}

interface PostAsset {
  id: string
  asset_type: string
  public_url: string
  storage_path: string
}

interface LaunchDraft {
  id: string
  name: string
  ticker: string
  description: string
  twitter_url: string
  image_url: string
  status: string
}

interface Signal {
  id: string
  external_post_id: string
  author_handle: string
  author_name: string
  author_avatar_url: string
  post_url: string
  text_raw: string
  posted_at: string
  metrics_json: { like_count: number; retweet_count: number; reply_count: number } | null
  has_media: boolean
  ingestion_status: string
  signal_analysis: SignalAnalysis[] | SignalAnalysis | null
  post_assets: PostAsset[] | null
  launch_drafts?: LaunchDraft[] | null
}

interface DeployForm {
  name: string
  ticker: string
  description: string
  twitterUrl: string
  imageUrl: string
  devBuySol: string
  feeLevel: 'fast' | 'turbo' | 'ultra'
  useJito: boolean
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function getAnalysis(signal: Signal): SignalAnalysis | null {
  if (!signal.signal_analysis) return null
  return Array.isArray(signal.signal_analysis) ? signal.signal_analysis[0] ?? null : signal.signal_analysis
}

function getPrimaryAsset(signal: Signal): PostAsset | null {
  if (!signal.post_assets?.length) return null
  return signal.post_assets.find(a => a.asset_type === 'original_media') ?? signal.post_assets[0]
}

function getDraft(signal: Signal): LaunchDraft | null {
  if (!signal.launch_drafts?.length) return null
  return signal.launch_drafts[0]
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'agora'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function scoreBadge(label: 'low' | 'medium' | 'high', score: number) {
  const cls = label === 'high'
    ? 'bg-green-900/60 text-green-300 border-green-700'
    : label === 'medium'
      ? 'bg-yellow-900/60 text-yellow-300 border-yellow-700'
      : 'bg-gray-800 text-gray-400 border-gray-700'
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${cls}`}>
      {score}
    </span>
  )
}

function statusDot(status: string) {
  const colors: Record<string, string> = {
    new: 'bg-blue-400',
    processing: 'bg-yellow-400 animate-pulse',
    ready: 'bg-green-400',
    reviewed: 'bg-purple-400',
    deployed: 'bg-brand',
    failed: 'bg-red-500',
    ignored: 'bg-gray-600',
  }
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${colors[status] ?? 'bg-gray-500'}`} />
}

async function urlToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      const [header, base64] = result.split(',')
      const mimeType = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
      resolve({ base64, mimeType })
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// -------------------------------------------------------
// Componente principal
// -------------------------------------------------------

export default function LiveDeploysPage() {
  const { session } = useContext(SessionContext)

  const [signals, setSignals] = useState<Signal[]>([])
  const [sources, setSources] = useState<TrackedSource[]>([])
  const [selected, setSelected] = useState<Signal | null>(null)
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [showWatchlist, setShowWatchlist] = useState(false)
  const [newHandle, setNewHandle] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterScore, setFilterScore] = useState('')
  const [filterMedia, setFilterMedia] = useState(false)

  // Deploy state
  const [deployForm, setDeployForm] = useState<DeployForm | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [draftForDeploy, setDraftForDeploy] = useState<LaunchDraft | null>(null)

  const wsRef = useRef<WebSocket | null>(null)

  // -------------------------------------------------------
  // Load data
  // -------------------------------------------------------

  const loadSignals = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (filterStatus) params.set('status', filterStatus)
      if (filterScore) params.set('score_label', filterScore)
      if (filterMedia) params.set('has_media', 'true')
      params.set('limit', '60')
      const data = await api.get<Signal[]>(`/live-deploys/signals?${params}`)
      setSignals(data)
      // Atualiza o sinal selecionado se ele mudou
      if (selected) {
        const updated = data.find(s => s.id === selected.id)
        if (updated) setSelected(updated)
      }
    } catch (err) {
      console.error('Erro ao carregar sinais:', err)
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterScore, filterMedia, selected?.id])

  const loadSources = useCallback(async () => {
    try {
      const data = await api.get<TrackedSource[]>('/live-deploys/sources')
      setSources(data)
    } catch (err) {
      console.error('Erro ao carregar fontes:', err)
    }
  }, [])

  useEffect(() => {
    loadSignals()
    loadSources()
  }, [filterStatus, filterScore, filterMedia])

  // Poll a cada 30s como fallback
  useEffect(() => {
    const t = setInterval(loadSignals, 30_000)
    return () => clearInterval(t)
  }, [loadSignals])

  // WebSocket para updates em tempo real
  useEffect(() => {
    const auth = loadAuth()
    if (!auth) return
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const ws = new WebSocket(`${proto}//${host}/ws?token=${auth.token}`)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'signal_new' || msg.type === 'signal_ready') {
          loadSignals()
        }
      } catch { /* ignora */ }
    }
    return () => ws.close()
  }, [])

  // -------------------------------------------------------
  // Acoes
  // -------------------------------------------------------

  async function handleAnalyze(signal: Signal) {
    setAnalyzing(true)
    try {
      await api.post(`/live-deploys/signals/${signal.id}/analyze`)
      await loadSignals()
    } catch (err: any) {
      alert('Erro na analise: ' + err.message)
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleIgnore(signal: Signal) {
    try {
      await api.post(`/live-deploys/signals/${signal.id}/ignore`)
      setSelected(null)
      await loadSignals()
    } catch (err: any) {
      alert('Erro: ' + err.message)
    }
  }

  async function handleCreateDraft(signal: Signal) {
    const analysis = getAnalysis(signal)
    const asset = getPrimaryAsset(signal)
    setCreatingDraft(true)
    try {
      const draft = await api.post<LaunchDraft>(`/live-deploys/signals/${signal.id}/create-draft`, {
        name: analysis?.extracted_name ?? signal.author_handle,
        ticker: analysis?.extracted_ticker_primary ?? signal.author_handle.toUpperCase().slice(0, 5),
        description: analysis?.short_description ?? signal.text_raw.slice(0, 100),
        twitter_url: signal.post_url,
        image_url: asset?.public_url ?? '',
      })
      await loadSignals()
      // Abre deploy form com o draft criado
      openDeployForm(draft)
    } catch (err: any) {
      alert('Erro ao criar draft: ' + err.message)
    } finally {
      setCreatingDraft(false)
    }
  }

  function openDeployForm(draft: LaunchDraft) {
    setDraftForDeploy(draft)
    setDeployForm({
      name: draft.name,
      ticker: draft.ticker,
      description: draft.description,
      twitterUrl: draft.twitter_url ?? '',
      imageUrl: draft.image_url ?? '',
      devBuySol: '0',
      feeLevel: 'fast',
      useJito: true,
    })
    setDeployResult(null)
  }

  async function handleDeploy() {
    if (!deployForm || !draftForDeploy) return
    if (!session) {
      alert('Ative uma wallet antes de fazer deploy.')
      return
    }

    setDeploying(true)
    setDeployResult(null)

    try {
      // 1. Converter imagem para base64
      let imageBase64 = ''
      let mimeType = 'image/jpeg'
      if (deployForm.imageUrl) {
        const b64 = await urlToBase64(deployForm.imageUrl)
        imageBase64 = b64.base64
        mimeType = b64.mimeType
      }

      if (!imageBase64) throw new Error('Imagem necessaria para o deploy')

      // 2. Upload metadata para pump.fun IPFS
      const { metadataUri } = await api.post<{ metadataUri: string }>('/token/upload-image', {
        imageBase64,
        mimeType,
        name: deployForm.name,
        symbol: deployForm.ticker,
        description: deployForm.description,
        twitter: deployForm.twitterUrl,
      })

      // 3. Deploy on-chain
      const result = await api.post<{ signature?: string; mint?: string; txHash?: string; error?: string }>(
        '/token/deploy',
        {
          metadataUri,
          name: deployForm.name,
          symbol: deployForm.ticker,
          devBuySol: parseFloat(deployForm.devBuySol) || 0,
          feeLevel: deployForm.feeLevel,
          useJito: deployForm.useJito,
          bundleWallets: [],
        }
      )

      const txHash = result.signature ?? result.txHash
      const mintAddress = result.mint

      // 4. Registrar deploy
      await api.post(`/live-deploys/drafts/${draftForDeploy.id}/deployed`, {
        tx_hash: txHash,
        mint_address: mintAddress,
        deploy_status: 'success',
      })

      setDeployResult({ ok: true, msg: `Deploy ok! TX: ${txHash?.slice(0, 16)}...` })
      await loadSignals()
    } catch (err: any) {
      setDeployResult({ ok: false, msg: err.message })
      // Registrar falha
      try {
        await api.post(`/live-deploys/drafts/${draftForDeploy.id}/deployed`, {
          deploy_status: 'failed',
          error_message: err.message,
        })
      } catch { /* ignora */ }
    } finally {
      setDeploying(false)
    }
  }

  async function handleAddSource() {
    if (!newHandle.trim()) return
    setAddingSource(true)
    try {
      await api.post('/live-deploys/sources', { source_value: newHandle.trim() })
      setNewHandle('')
      await loadSources()
    } catch (err: any) {
      alert('Erro: ' + err.message)
    } finally {
      setAddingSource(false)
    }
  }

  async function handleRemoveSource(id: string) {
    try {
      await (api as any).delete(`/live-deploys/sources/${id}`)
      await loadSources()
    } catch (err: any) {
      alert('Erro: ' + err.message)
    }
  }

  // -------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------

  const analysis = selected ? getAnalysis(selected) : null
  const asset = selected ? getPrimaryAsset(selected) : null
  const existingDraft = selected ? getDraft(selected) : null

  // -------------------------------------------------------
  // Layout 3 colunas
  // -------------------------------------------------------

  return (
    <div className="flex gap-4 h-[calc(100vh-120px)] -mx-2">

      {/* ---- Coluna esquerda: feed ---- */}
      <div className="w-72 flex flex-col gap-3 flex-shrink-0">

        {/* Header + watchlist toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
            Live Feed
          </span>
          <button
            onClick={() => setShowWatchlist(v => !v)}
            className="text-xs text-brand hover:underline"
          >
            {showWatchlist ? 'ver sinais' : `watchlist (${sources.length})`}
          </button>
        </div>

        {showWatchlist ? (
          /* ---- Watchlist panel ---- */
          <div className="flex-1 overflow-y-auto space-y-2">
            <div className="flex gap-2">
              <input
                className="input flex-1 text-xs py-1.5"
                placeholder="@handle"
                value={newHandle}
                onChange={e => setNewHandle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddSource()}
              />
              <button
                onClick={handleAddSource}
                disabled={addingSource}
                className="btn-primary text-xs px-3 py-1.5"
              >
                +
              </button>
            </div>
            {sources.length === 0 && (
              <p className="text-xs text-gray-500 text-center py-4">
                Nenhuma conta monitorada.
              </p>
            )}
            {sources.map(s => (
              <div key={s.id} className="flex items-center justify-between bg-surface-800 rounded px-3 py-2">
                <div>
                  <span className="text-xs font-medium text-white">@{s.source_value}</span>
                  {s.last_polled_at && (
                    <span className="text-xs text-gray-500 ml-2">
                      {timeAgo(s.last_polled_at)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleRemoveSource(s.id)}
                  className="text-xs text-gray-500 hover:text-danger"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        ) : (
          /* ---- Signal feed ---- */
          <>
            {/* Filtros */}
            <div className="flex flex-wrap gap-1.5">
              <select
                className="input text-xs py-1 flex-1 min-w-0"
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
              >
                <option value="">todos status</option>
                <option value="new">novo</option>
                <option value="processing">processando</option>
                <option value="ready">pronto</option>
                <option value="reviewed">revisado</option>
                <option value="deployed">deployado</option>
                <option value="ignored">ignorado</option>
              </select>
              <select
                className="input text-xs py-1 flex-1 min-w-0"
                value={filterScore}
                onChange={e => setFilterScore(e.target.value)}
              >
                <option value="">score</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
              <button
                onClick={() => setFilterMedia(v => !v)}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  filterMedia
                    ? 'border-brand/60 text-brand bg-brand/10'
                    : 'border-surface-500 text-gray-400'
                }`}
              >
                img
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1.5">
              {loading && (
                <p className="text-xs text-gray-500 text-center py-6">carregando...</p>
              )}
              {!loading && signals.length === 0 && (
                <p className="text-xs text-gray-500 text-center py-6">
                  Nenhum sinal ainda.{' '}
                  <button onClick={() => setShowWatchlist(true)} className="text-brand hover:underline">
                    Adicione contas na watchlist.
                  </button>
                </p>
              )}
              {signals.map(sig => {
                const a = getAnalysis(sig)
                const img = getPrimaryAsset(sig)
                const isSelected = selected?.id === sig.id
                return (
                  <button
                    key={sig.id}
                    onClick={() => setSelected(sig)}
                    className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors border ${
                      isSelected
                        ? 'bg-brand/10 border-brand/40'
                        : 'bg-surface-800 border-surface-700 hover:border-surface-500'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {img && (
                        <img
                          src={img.public_url}
                          alt=""
                          className="w-8 h-8 rounded object-cover flex-shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {statusDot(sig.ingestion_status)}
                          <span className="text-xs font-medium text-white truncate">
                            @{sig.author_handle}
                          </span>
                          <span className="text-xs text-gray-500 ml-auto flex-shrink-0">
                            {timeAgo(sig.posted_at)}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 truncate mt-0.5">
                          {sig.text_raw}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      {a && scoreBadge(a.score_label, a.score)}
                      {sig.has_media && (
                        <span className="text-xs text-gray-500 border border-surface-600 px-1 rounded">
                          img
                        </span>
                      )}
                      {a?.extracted_ticker_primary && (
                        <span className="text-xs text-brand font-mono">
                          ${a.extracted_ticker_primary}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* ---- Coluna central: detalhe ---- */}
      <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-gray-500 text-sm">Selecione um sinal para ver o detalhe</p>
          </div>
        ) : (
          <>
            {/* Post preview */}
            <div className="bg-surface-800 rounded-lg p-4 border border-surface-700">
              <div className="flex items-center gap-3 mb-3">
                {selected.author_avatar_url && (
                  <img
                    src={selected.author_avatar_url}
                    alt=""
                    className="w-9 h-9 rounded-full"
                  />
                )}
                <div>
                  <div className="text-sm font-medium text-white">{selected.author_name}</div>
                  <div className="text-xs text-gray-400">@{selected.author_handle}</div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {statusDot(selected.ingestion_status)}
                  <span className="text-xs text-gray-400 capitalize">{selected.ingestion_status}</span>
                  <a
                    href={selected.post_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-brand hover:underline"
                  >
                    ver post
                  </a>
                </div>
              </div>

              <p className="text-sm text-gray-200 leading-relaxed mb-3">{selected.text_raw}</p>

              {selected.metrics_json && (
                <div className="flex gap-4 text-xs text-gray-500">
                  <span>{selected.metrics_json.like_count} likes</span>
                  <span>{selected.metrics_json.retweet_count} RTs</span>
                  <span>{selected.metrics_json.reply_count} respostas</span>
                </div>
              )}
            </div>

            {/* Imagem */}
            {asset && (
              <div className="bg-surface-800 rounded-lg p-3 border border-surface-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400">Asset</span>
                  <span className="text-xs text-gray-600 font-mono">{asset.asset_type}</span>
                </div>
                <img
                  src={asset.public_url}
                  alt="Post media"
                  className="max-h-48 rounded object-contain w-full"
                />
              </div>
            )}

            {/* Analise */}
            {analysis ? (
              <div className="bg-surface-800 rounded-lg p-4 border border-surface-700 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                    Analise
                  </span>
                  <div className="flex items-center gap-2">
                    {scoreBadge(analysis.score_label, analysis.score)}
                    <span className="text-xs text-gray-500">
                      conf. {Math.round(analysis.confidence * 100)}%
                    </span>
                    <button
                      onClick={() => handleAnalyze(selected)}
                      disabled={analyzing}
                      className="text-xs text-gray-500 hover:text-white transition-colors"
                    >
                      {analyzing ? 'analisando...' : 're-analisar'}
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-xs text-gray-500 mb-1">Nome sugerido</div>
                  <div className="text-sm font-medium text-white">{analysis.extracted_name}</div>
                </div>

                <div>
                  <div className="text-xs text-gray-500 mb-1">Tickers sugeridos</div>
                  <div className="flex gap-2">
                    <span className="px-2 py-1 rounded bg-green-900/40 text-green-300 text-xs font-mono border border-green-800">
                      ${analysis.extracted_ticker_primary}
                    </span>
                    <span className="px-2 py-1 rounded bg-surface-700 text-gray-300 text-xs font-mono border border-surface-600">
                      ${analysis.extracted_ticker_alt_1}
                    </span>
                    <span className="px-2 py-1 rounded bg-surface-700 text-gray-300 text-xs font-mono border border-surface-600">
                      ${analysis.extracted_ticker_alt_2}
                    </span>
                  </div>
                </div>

                <div>
                  <div className="text-xs text-gray-500 mb-1">Descricao</div>
                  <div className="text-sm text-gray-300">{analysis.short_description}</div>
                </div>
              </div>
            ) : (
              <div className="bg-surface-800 rounded-lg p-4 border border-surface-700 flex items-center justify-between">
                <span className="text-sm text-gray-500">Sem analise</span>
                <button
                  onClick={() => handleAnalyze(selected)}
                  disabled={analyzing}
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  {analyzing ? 'analisando...' : 'analisar agora'}
                </button>
              </div>
            )}

            {/* Draft existente */}
            {existingDraft && (
              <div className="bg-surface-800 rounded-lg p-3 border border-purple-800/50">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-purple-400 font-medium">Draft criado</span>
                    <span className="text-xs text-gray-400 ml-2 font-mono">{existingDraft.name} / ${existingDraft.ticker}</span>
                  </div>
                  {existingDraft.status === 'pending' && (
                    <button
                      onClick={() => openDeployForm(existingDraft)}
                      className="btn-primary text-xs py-1 px-3"
                    >
                      Deploy
                    </button>
                  )}
                  {existingDraft.status === 'deployed' && (
                    <span className="text-xs text-brand">Deployado</span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- Coluna direita: acoes ---- */}
      <div className="w-52 flex-shrink-0 flex flex-col gap-3">

        {selected && (
          <>
            <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
              Acoes
            </span>

            {/* Deploy form */}
            {deployForm && draftForDeploy ? (
              <div className="bg-surface-800 rounded-lg p-3 border border-surface-700 space-y-2.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-white">Confirmar Deploy</span>
                  <button
                    onClick={() => { setDeployForm(null); setDraftForDeploy(null); setDeployResult(null) }}
                    className="text-xs text-gray-500 hover:text-white"
                  >
                    x
                  </button>
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Nome</label>
                  <input
                    className="input w-full text-xs py-1.5"
                    value={deployForm.name}
                    onChange={e => setDeployForm(f => f && ({ ...f, name: e.target.value }))}
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Ticker</label>
                  <input
                    className="input w-full text-xs py-1.5 uppercase"
                    value={deployForm.ticker}
                    onChange={e => setDeployForm(f => f && ({ ...f, ticker: e.target.value.toUpperCase() }))}
                    maxLength={6}
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Descricao</label>
                  <textarea
                    className="input w-full text-xs py-1.5 resize-none"
                    rows={2}
                    value={deployForm.description}
                    onChange={e => setDeployForm(f => f && ({ ...f, description: e.target.value }))}
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Dev Buy (SOL)</label>
                  <input
                    className="input w-full text-xs py-1.5"
                    type="number"
                    min="0"
                    step="0.1"
                    value={deployForm.devBuySol}
                    onChange={e => setDeployForm(f => f && ({ ...f, devBuySol: e.target.value }))}
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 block mb-1">Fee</label>
                  <select
                    className="input w-full text-xs py-1.5"
                    value={deployForm.feeLevel}
                    onChange={e => setDeployForm(f => f && ({ ...f, feeLevel: e.target.value as any }))}
                  >
                    <option value="fast">fast</option>
                    <option value="turbo">turbo</option>
                    <option value="ultra">ultra</option>
                  </select>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deployForm.useJito}
                    onChange={e => setDeployForm(f => f && ({ ...f, useJito: e.target.checked }))}
                    className="rounded"
                  />
                  <span className="text-xs text-gray-400">Usar Jito</span>
                </label>

                {!session && (
                  <p className="text-xs text-yellow-400">Ative uma wallet para fazer deploy.</p>
                )}

                {deployResult && (
                  <p className={`text-xs ${deployResult.ok ? 'text-green-400' : 'text-danger'}`}>
                    {deployResult.msg}
                  </p>
                )}

                <button
                  onClick={handleDeploy}
                  disabled={deploying || !session || deployResult?.ok}
                  className="btn-primary w-full text-xs py-2"
                >
                  {deploying ? 'deployando...' : deployResult?.ok ? 'feito!' : 'Confirmar Deploy'}
                </button>
              </div>
            ) : (
              /* Botoes de acao padrão */
              <div className="space-y-2">
                {/* Criar draft + abrir deploy */}
                {!existingDraft && analysis && (
                  <button
                    onClick={() => handleCreateDraft(selected)}
                    disabled={creatingDraft}
                    className="btn-primary w-full text-xs py-2"
                  >
                    {creatingDraft ? 'criando...' : 'Criar Draft + Deploy'}
                  </button>
                )}

                {/* Se ja tem draft */}
                {existingDraft?.status === 'pending' && (
                  <button
                    onClick={() => openDeployForm(existingDraft)}
                    className="btn-primary w-full text-xs py-2"
                  >
                    Abrir Deploy
                  </button>
                )}

                {/* Se nao tem analise ainda */}
                {!analysis && (
                  <button
                    onClick={() => handleAnalyze(selected)}
                    disabled={analyzing}
                    className="w-full btn-ghost text-xs py-2 border border-surface-600"
                  >
                    {analyzing ? 'analisando...' : 'Analisar Signal'}
                  </button>
                )}

                <button
                  onClick={() => handleIgnore(selected)}
                  className="w-full btn-ghost text-xs py-2 border border-surface-600 text-gray-500 hover:text-danger hover:border-danger/50"
                >
                  Ignorar
                </button>

                <a
                  href={selected.post_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block w-full text-center btn-ghost text-xs py-2 border border-surface-600"
                >
                  Ver no X
                </a>

                {selected.ingestion_status === 'deployed' && (
                  <div className="text-center text-xs text-brand py-1">Ja deployado</div>
                )}
              </div>
            )}
          </>
        )}

        {!selected && (
          <p className="text-xs text-gray-600 text-center mt-4">
            Selecione um sinal para ver as acoes
          </p>
        )}
      </div>
    </div>
  )
}
