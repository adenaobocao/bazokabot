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
  is_active: boolean
  priority: number
  last_polled_at: string | null
  x_user_id: string | null
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

interface WorkerStatus {
  running: boolean
  isPolling: boolean
  lastPollAt: string | null
  lastPollError: string | null
  xConfigured: boolean
  supabaseConfigured: boolean
  intervalMinutes: number
  staggerMs: number
}

interface Stats {
  signals: { total: number; new: number; ready: number; deployed: number; ignored: number }
  drafts: { pending: number; deployed: number }
  deploys: { total: number; success: number }
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

interface DeployedToken {
  id: string
  tx_hash: string
  mint_address: string
  dev_buy_sol: number
  created_at: string
  launch_drafts: {
    id: string
    name: string
    ticker: string
    image_url: string
    twitter_url: string
    source_posts: { author_handle: string; post_url: string } | null
  } | null
}

interface TokenInfo {
  price: number
  balance: string
}

interface TokenAction {
  loading: boolean
  result: string | null
  error: string | null
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function getAnalysis(s: Signal): SignalAnalysis | null {
  if (!s.signal_analysis) return null
  return Array.isArray(s.signal_analysis) ? s.signal_analysis[0] ?? null : s.signal_analysis
}

function getPrimaryAsset(s: Signal): PostAsset | null {
  if (!s.post_assets?.length) return null
  return s.post_assets.find(a => a.asset_type === 'original_media') ?? s.post_assets[0]
}

function getDraft(s: Signal): LaunchDraft | null {
  if (!s.launch_drafts?.length) return null
  return s.launch_drafts[0]
}

function timeAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (m < 1) return 'agora'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function ScorePill({ label, score }: { label: 'low' | 'medium' | 'high'; score: number }) {
  const cls = label === 'high'
    ? 'bg-green-900/60 text-green-300 border-green-700'
    : label === 'medium'
      ? 'bg-yellow-900/50 text-yellow-300 border-yellow-700'
      : 'bg-gray-800 text-gray-400 border-gray-700'
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${cls}`}>
      {score}
    </span>
  )
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    new: 'bg-blue-400',
    processing: 'bg-yellow-400 animate-pulse',
    ready: 'bg-green-400',
    reviewed: 'bg-purple-400',
    deployed: 'bg-brand',
    failed: 'bg-red-500',
    ignored: 'bg-gray-600',
  }
  return <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${colors[status] ?? 'bg-gray-500'}`} />
}

async function urlToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      const [header, base64] = result.split(',')
      resolve({ base64, mimeType: header.match(/:(.*?);/)?.[1] ?? 'image/jpeg' })
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
  const [stats, setStats] = useState<Stats | null>(null)
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null)
  const [selected, setSelected] = useState<Signal | null>(null)
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [mainTab, setMainTab] = useState<'live' | 'deployed'>('live')
  const [tab, setTab] = useState<'feed' | 'watchlist'>('feed')
  const [deployed, setDeployed] = useState<DeployedToken[]>([])
  const [tokenInfos, setTokenInfos] = useState<Record<string, TokenInfo>>({})
  const [tokenActions, setTokenActions] = useState<Record<string, TokenAction>>({})
  const [newHandle, setNewHandle] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterScore, setFilterScore] = useState('')
  const [filterMedia, setFilterMedia] = useState(false)
  const [deployForm, setDeployForm] = useState<DeployForm | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [draftForDeploy, setDraftForDeploy] = useState<LaunchDraft | null>(null)

  const wsRef = useRef<WebSocket | null>(null)

  // -------------------------------------------------------
  // Load
  // -------------------------------------------------------

  const loadAll = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (filterStatus) params.set('status', filterStatus)
      if (filterScore) params.set('score_label', filterScore)
      if (filterMedia) params.set('has_media', 'true')
      params.set('limit', '80')

      const [sigs, srcs, st, ws, dep] = await Promise.all([
        api.get<Signal[]>(`/live-deploys/signals?${params}`),
        api.get<TrackedSource[]>('/live-deploys/sources'),
        api.get<Stats>('/live-deploys/stats'),
        api.get<WorkerStatus>('/live-deploys/worker-status'),
        api.get<DeployedToken[]>('/live-deploys/deployed'),
      ])
      setSignals(sigs)
      setSources(srcs)
      setStats(st)
      setWorkerStatus(ws)
      setDeployed(dep)
      if (selected) {
        const updated = sigs.find(s => s.id === selected.id)
        if (updated) setSelected(updated)
      }
    } catch (err) {
      console.error('Erro ao carregar:', err)
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterScore, filterMedia, selected?.id])

  const loadTokenInfo = useCallback(async (mint: string) => {
    if (!session) return
    try {
      const info = await api.get<TokenInfo>(`/token/${mint}/info`)
      setTokenInfos(prev => ({ ...prev, [mint]: info }))
    } catch { /* silencioso */ }
  }, [session])

  useEffect(() => {
    if (mainTab === 'deployed' && session && deployed.length > 0) {
      deployed.forEach(d => { if (d.mint_address) loadTokenInfo(d.mint_address) })
    }
  }, [mainTab, deployed.length, session])

  // Auto-refresh precos a cada 5s na aba Deployed
  useEffect(() => {
    if (mainTab !== 'deployed' || !session || deployed.length === 0) return
    const t = setInterval(() => {
      deployed.forEach(d => { if (d.mint_address) loadTokenInfo(d.mint_address) })
    }, 5_000)
    return () => clearInterval(t)
  }, [mainTab, session, deployed, loadTokenInfo])

  useEffect(() => { loadAll() }, [filterStatus, filterScore, filterMedia])

  // Refresh automatico: 10s se tem fontes, 30s se nao tem
  useEffect(() => {
    const interval = sources.length > 0 ? 10_000 : 30_000
    const t = setInterval(loadAll, interval)
    return () => clearInterval(t)
  }, [loadAll, sources.length])

  // WebSocket
  useEffect(() => {
    const auth = loadAuth()
    if (!auth) return
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${auth.token}`)
    wsRef.current = ws
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'signal_new' || msg.type === 'signal_ready') loadAll()
      } catch { /* ignora */ }
    }
    return () => ws.close()
  }, [])

  // -------------------------------------------------------
  // Acoes
  // -------------------------------------------------------

  function setAction(mint: string, patch: Partial<TokenAction>) {
    setTokenActions(prev => ({
      ...prev,
      [mint]: { ...{ loading: false, result: null, error: null }, ...prev[mint], ...patch },
    }))
  }

  async function handleSellAll(mint: string, percentage: number, feeLevel: string = 'fast') {
    if (!session) return alert('Ative uma wallet primeiro.')
    if (!mint || mint.length < 32) {
      return alert(`Mint address invalido: "${mint}". Verifique se o deploy foi registrado corretamente.`)
    }
    setAction(mint, { loading: true, result: null, error: null })
    try {
      const res = await api.post<{ success: boolean; bundleId?: string; signature?: string; results?: any[]; error?: string }>(
        '/token/sell-all',
        { mint, percentage, includeDevWallet: true, wallets: [], feeLevel, useJito: true }
      )
      if (res.success) {
        const id = res.bundleId ?? res.signature ?? res.results?.[0]?.signature
        setAction(mint, { loading: false, result: `Vendido! ${id ? id.slice(0, 16) + '...' : ''}` })
        setTimeout(() => loadTokenInfo(mint), 5000)
      } else {
        setAction(mint, { loading: false, error: res.error ?? 'Falhou' })
      }
    } catch (err: any) {
      setAction(mint, { loading: false, error: err.message })
    }
  }

  async function handleClaimFees(mint: string) {
    if (!session) return alert('Ative uma wallet primeiro.')
    setAction(mint, { loading: true, result: null, error: null })
    try {
      const res = await api.post<{ success: boolean; signature?: string; error?: string }>('/token/claim-fees', { feeLevel: 'fast' })
      if (res.success) {
        setAction(mint, { loading: false, result: `Fees claimed! ${res.signature?.slice(0, 16)}...` })
      } else {
        setAction(mint, { loading: false, error: res.error ?? 'Falhou' })
      }
    } catch (err: any) {
      setAction(mint, { loading: false, error: err.message })
    }
  }

  async function handlePollNow() {
    setPolling(true)
    try {
      await api.post('/live-deploys/poll-now')
      // Aguarda um pouco para o worker processar
      setTimeout(loadAll, 3000)
      setTimeout(loadAll, 8000)
    } catch (err: any) {
      alert('Erro: ' + err.message)
    } finally {
      setTimeout(() => setPolling(false), 3000)
    }
  }

  async function handleSeedWatchlist() {
    setSeeding(true)
    try {
      const res = await api.post<{ added: number }>('/live-deploys/seed-watchlist')
      await loadAll()
      setTab('watchlist')
      alert(`${(res as any).added} contas adicionadas a watchlist!`)
    } catch (err: any) {
      alert('Erro: ' + err.message)
    } finally {
      setSeeding(false)
    }
  }

  async function handleAddSource() {
    if (!newHandle.trim()) return
    setAddingSource(true)
    try {
      await api.post('/live-deploys/sources', { source_value: newHandle.trim() })
      setNewHandle('')
      await loadAll()
    } catch (err: any) {
      alert('Erro: ' + err.message)
    } finally {
      setAddingSource(false)
    }
  }

  async function handleRemoveSource(id: string) {
    try {
      await (api as any).delete(`/live-deploys/sources/${id}`)
      await loadAll()
    } catch (err: any) {
      alert('Erro: ' + err.message)
    }
  }

  async function handleAnalyze(signal: Signal) {
    setAnalyzing(true)
    try {
      await api.post(`/live-deploys/signals/${signal.id}/analyze`)
      await loadAll()
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
      await loadAll()
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
      await loadAll()
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
    if (!deployForm || !draftForDeploy || !session) return
    setDeploying(true)
    setDeployResult(null)
    try {
      let imageBase64 = ''
      let mimeType = 'image/jpeg'
      if (deployForm.imageUrl) {
        const b64 = await urlToBase64(deployForm.imageUrl)
        imageBase64 = b64.base64
        mimeType = b64.mimeType
      }
      if (!imageBase64) throw new Error('Imagem necessaria para o deploy')

      const { metadataUri } = await api.post<{ metadataUri: string }>('/token/upload-image', {
        imageBase64, mimeType,
        name: deployForm.name,
        symbol: deployForm.ticker,
        description: deployForm.description,
        twitter: deployForm.twitterUrl,
      })

      const result = await api.post<{ signature?: string; mint?: string; txHash?: string }>(
        '/token/deploy', {
          metadataUri,
          name: deployForm.name,
          symbol: deployForm.ticker,
          devBuySol: parseFloat(deployForm.devBuySol) || 0,
          feeLevel: deployForm.feeLevel,
          useJito: deployForm.useJito,
          bundleWallets: [],
        }
      )

      await api.post(`/live-deploys/drafts/${draftForDeploy.id}/deployed`, {
        tx_hash: result.signature ?? result.txHash,
        mint_address: result.mint,
        deploy_status: 'success',
        dev_buy_sol: parseFloat(deployForm.devBuySol) || 0,
      })

      setDeployResult({ ok: true, msg: `Deploy ok! TX: ${(result.signature ?? result.txHash ?? '').slice(0, 20)}...` })
      await loadAll()
    } catch (err: any) {
      setDeployResult({ ok: false, msg: err.message })
      try {
        await api.post(`/live-deploys/drafts/${draftForDeploy.id}/deployed`, {
          deploy_status: 'failed', error_message: err.message,
        })
      } catch { /* ignora */ }
    } finally {
      setDeploying(false)
    }
  }

  // -------------------------------------------------------
  // Derived
  // -------------------------------------------------------

  const analysis = selected ? getAnalysis(selected) : null
  const asset = selected ? getPrimaryAsset(selected) : null
  const existingDraft = selected ? getDraft(selected) : null

  const workerOk = workerStatus?.running && workerStatus.xConfigured && workerStatus.supabaseConfigured

  // -------------------------------------------------------
  // Render
  // -------------------------------------------------------

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-100px)] -mx-2">

      {/* ---- Main tabs ---- */}
      <div className="flex gap-2 items-center">
        <button
          onClick={() => setMainTab('live')}
          className={`text-sm px-4 py-1.5 rounded border transition-colors ${mainTab === 'live' ? 'border-brand/50 bg-brand/10 text-brand' : 'border-surface-600 text-gray-400 hover:text-white'}`}
        >
          Live Feed
        </button>
        <button
          onClick={() => setMainTab('deployed')}
          className={`text-sm px-4 py-1.5 rounded border transition-colors flex items-center gap-2 ${mainTab === 'deployed' ? 'border-brand/50 bg-brand/10 text-brand' : 'border-surface-600 text-gray-400 hover:text-white'}`}
        >
          Deployed
          {deployed.length > 0 && <span className="text-xs font-mono bg-brand/20 text-brand px-1.5 rounded">{deployed.length}</span>}
        </button>
      </div>

      {mainTab === 'deployed' ? (
        <>
          {session && deployed.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              precos atualizando a cada 5s
            </div>
          )}
          <DeployedPanel
            tokens={deployed}
            tokenInfos={tokenInfos}
            tokenActions={tokenActions}
            onSellAll={handleSellAll}
            onClaimFees={handleClaimFees}
            onRefreshInfo={loadTokenInfo}
            hasSession={!!session}
          />
        </>
      ) : (

      /* ---- Top bar ---- */
      <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center gap-3 flex-wrap">

        {/* Stats */}
        {stats && (
          <div className="flex gap-2 flex-wrap">
            <StatChip label="sinais" value={stats.signals.total} />
            <StatChip label="prontos" value={stats.signals.ready} color="green" />
            <StatChip label="drafts" value={stats.drafts.pending} color="purple" />
            <StatChip label="deployados" value={stats.signals.deployed} color="brand" />
          </div>
        )}

        <div className="flex-1" />

        {/* Worker status */}
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${workerOk ? 'bg-green-400' : 'bg-red-500'}`} />
          <span className="text-gray-400">
            {workerStatus?.isPolling
              ? 'buscando...'
              : workerStatus?.lastPollAt
                ? `poll ${timeAgo(workerStatus.lastPollAt)}`
                : 'aguardando'}
          </span>
          {workerStatus?.intervalMinutes && (
            <span className="text-gray-600">a cada {workerStatus.intervalMinutes}min</span>
          )}
          {sources.length > 0 && workerStatus?.intervalMinutes && (
            <span className="text-gray-600">
              (~{sources.length} req/{workerStatus.intervalMinutes}min)
            </span>
          )}
          {workerStatus?.lastPollError && (
            <span className="text-red-400 truncate max-w-40" title={workerStatus.lastPollError}>
              erro
            </span>
          )}
        </div>

        <button
          onClick={handlePollNow}
          disabled={polling || workerStatus?.isPolling}
          className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
        >
          {polling || workerStatus?.isPolling ? (
            <><span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />buscando...</>
          ) : 'Poll Agora'}
        </button>
      </div>

      {/* Config alert se nao configurado */}
      {workerStatus && (!workerStatus.xConfigured || !workerStatus.supabaseConfigured) && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-lg px-4 py-2 text-xs text-yellow-300">
          {!workerStatus.xConfigured && <span>X_BEARER_TOKEN nao configurado. </span>}
          {!workerStatus.supabaseConfigured && <span>Supabase nao configurado. </span>}
          <span>Adicione as env vars no Railway e faca redeploy.</span>
        </div>
      )}

      {/* ---- Layout 3 colunas ---- */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* ---- Coluna esquerda ---- */}
        <div className="w-72 flex flex-col gap-3 flex-shrink-0">

          {/* Tabs */}
          <div className="flex gap-1">
            <TabBtn active={tab === 'feed'} onClick={() => setTab('feed')}>
              Feed {signals.length > 0 && <span className="ml-1 text-gray-500">({signals.length})</span>}
            </TabBtn>
            <TabBtn active={tab === 'watchlist'} onClick={() => setTab('watchlist')}>
              Watchlist {sources.length > 0 && <span className="ml-1 text-gray-500">({sources.length})</span>}
            </TabBtn>
          </div>

          {tab === 'watchlist' ? (
            <WatchlistPanel
              sources={sources}
              newHandle={newHandle}
              setNewHandle={setNewHandle}
              onAdd={handleAddSource}
              onRemove={handleRemoveSource}
              adding={addingSource}
              onSeed={handleSeedWatchlist}
              seeding={seeding}
            />
          ) : (
            <FeedPanel
              signals={signals}
              loading={loading}
              selected={selected}
              onSelect={setSelected}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              filterScore={filterScore}
              setFilterScore={setFilterScore}
              filterMedia={filterMedia}
              setFilterMedia={setFilterMedia}
              onSeed={handleSeedWatchlist}
              seeding={seeding}
            />
          )}
        </div>

        {/* ---- Coluna central ---- */}
        <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-3">
          {!selected ? (
            <EmptyDetail />
          ) : (
            <SignalDetail
              signal={selected}
              analysis={analysis}
              asset={asset}
              existingDraft={existingDraft}
              analyzing={analyzing}
              onAnalyze={() => handleAnalyze(selected)}
              onOpenDeploy={openDeployForm}
            />
          )}
        </div>

        {/* ---- Coluna direita: acoes ---- */}
        <div className="w-52 flex-shrink-0 flex flex-col gap-3">
          {selected && (
            <>
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Acoes</span>

              {deployForm && draftForDeploy ? (
                <DeployPanel
                  form={deployForm}
                  setForm={setDeployForm}
                  onDeploy={handleDeploy}
                  onClose={() => { setDeployForm(null); setDraftForDeploy(null); setDeployResult(null) }}
                  deploying={deploying}
                  result={deployResult}
                  hasSession={!!session}
                />
              ) : (
                <ActionPanel
                  signal={selected}
                  analysis={analysis}
                  existingDraft={existingDraft}
                  creatingDraft={creatingDraft}
                  analyzing={analyzing}
                  onCreateDraft={() => handleCreateDraft(selected)}
                  onOpenDeploy={openDeployForm}
                  onAnalyze={() => handleAnalyze(selected)}
                  onIgnore={() => handleIgnore(selected)}
                  onGoDeployed={() => setMainTab('deployed')}
                />
              )}
            </>
          )}
        </div>
      </div>
      </div>
      )}
    </div>
  )
}

// -------------------------------------------------------
// Sub-componentes
// -------------------------------------------------------

function StatChip({ label, value, color }: { label: string; value: number; color?: string }) {
  const cls = color === 'green' ? 'text-green-400'
    : color === 'purple' ? 'text-purple-400'
      : color === 'brand' ? 'text-brand'
        : 'text-white'
  return (
    <div className="bg-surface-800 rounded px-2.5 py-1 border border-surface-700 text-xs flex items-center gap-1.5">
      <span className={`font-mono font-bold ${cls}`}>{value}</span>
      <span className="text-gray-500">{label}</span>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 text-xs py-1.5 rounded border transition-colors ${
        active
          ? 'border-brand/50 bg-brand/10 text-brand'
          : 'border-surface-600 text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function WatchlistPanel({
  sources, newHandle, setNewHandle, onAdd, onRemove, adding, onSeed, seeding
}: {
  sources: TrackedSource[]
  newHandle: string
  setNewHandle: (v: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  adding: boolean
  onSeed: () => void
  seeding: boolean
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          className="input flex-1 text-xs py-1.5"
          placeholder="@handle"
          value={newHandle}
          onChange={e => setNewHandle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onAdd()}
        />
        <button onClick={onAdd} disabled={adding} className="btn-primary text-xs px-3 py-1.5">+</button>
      </div>
      {sources.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-xs text-gray-500">Nenhuma conta monitorada.</p>
          <button onClick={onSeed} disabled={seeding} className="btn-primary text-xs py-1.5 px-4">
            {seeding ? 'adicionando...' : 'Seed Celebridades'}
          </button>
          <p className="text-xs text-gray-600">Adiciona Trump, Elon, CZ e +20 contas</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-1">
          {sources.map(s => (
            <div key={s.id} className="flex items-center justify-between bg-surface-800 rounded px-3 py-2 border border-surface-700">
              <div>
                <span className="text-xs font-medium text-white">@{s.source_value}</span>
                {s.last_polled_at
                  ? <span className="text-xs text-gray-500 ml-2">{timeAgo(s.last_polled_at)}</span>
                  : <span className="text-xs text-gray-600 ml-2">aguardando poll</span>
                }
              </div>
              <button onClick={() => onRemove(s.id)} className="text-xs text-gray-600 hover:text-danger ml-2">x</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FeedPanel({
  signals, loading, selected, onSelect,
  filterStatus, setFilterStatus, filterScore, setFilterScore, filterMedia, setFilterMedia,
  onSeed, seeding,
}: {
  signals: Signal[]
  loading: boolean
  selected: Signal | null
  onSelect: (s: Signal) => void
  filterStatus: string
  setFilterStatus: (v: string) => void
  filterScore: string
  setFilterScore: (v: string) => void
  filterMedia: boolean
  setFilterMedia: (v: boolean) => void
  onSeed: () => void
  seeding: boolean
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex gap-1.5">
        <select className="input text-xs py-1 flex-1" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">status</option>
          <option value="new">novo</option>
          <option value="ready">pronto</option>
          <option value="reviewed">revisado</option>
          <option value="deployed">deployado</option>
          <option value="ignored">ignorado</option>
        </select>
        <select className="input text-xs py-1 flex-1" value={filterScore} onChange={e => setFilterScore(e.target.value)}>
          <option value="">score</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
        <button
          onClick={() => setFilterMedia(!filterMedia)}
          className={`text-xs px-2 py-1 rounded border transition-colors ${filterMedia ? 'border-brand/60 text-brand' : 'border-surface-600 text-gray-500'}`}
        >
          img
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1.5">
        {loading && <p className="text-xs text-gray-500 text-center py-8">carregando...</p>}
        {!loading && signals.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-xs text-gray-500">Nenhum sinal ainda.</p>
            <button onClick={onSeed} disabled={seeding} className="btn-primary text-xs py-1.5 px-4">
              {seeding ? 'adicionando...' : '+ Seed Celebridades'}
            </button>
            <p className="text-xs text-gray-600">Depois clique em "Poll Agora"</p>
          </div>
        )}
        {signals.map(sig => {
          const a = getAnalysis(sig)
          const img = getPrimaryAsset(sig)
          const isSelected = selected?.id === sig.id
          return (
            <button
              key={sig.id}
              onClick={() => onSelect(sig)}
              className={`w-full text-left rounded-lg px-3 py-3 transition-colors border ${
                isSelected ? 'bg-brand/10 border-brand/40' : 'bg-surface-800 border-surface-700 hover:border-surface-500'
              }`}
            >
              {/* Header */}
              <div className="flex items-center gap-2 mb-2">
                {sig.author_avatar_url ? (
                  <img src={sig.author_avatar_url} alt="" className="w-7 h-7 rounded-full flex-shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-surface-700 flex-shrink-0 flex items-center justify-center text-gray-500 text-xs font-bold">
                    {sig.author_handle[0]?.toUpperCase()}
                  </div>
                )}
                <StatusDot status={sig.ingestion_status} />
                <span className="text-xs font-semibold text-white truncate">@{sig.author_handle}</span>
                <span className="text-xs text-gray-500 ml-auto flex-shrink-0">{timeAgo(sig.posted_at)}</span>
              </div>

              {/* Imagem se tiver */}
              {img && (
                <img src={img.public_url} alt="" className="w-full h-24 rounded object-cover mb-2" />
              )}

              {/* Texto */}
              <p className="text-xs text-gray-300 leading-relaxed line-clamp-3 mb-2">{sig.text_raw}</p>

              {/* Footer */}
              <div className="flex items-center gap-2 flex-wrap">
                {a && <ScorePill label={a.score_label} score={a.score} />}
                {a?.extracted_ticker_primary && (
                  <span className="text-xs text-brand font-mono font-bold">${a.extracted_ticker_primary}</span>
                )}
                {sig.metrics_json && (sig.metrics_json.like_count > 0 || sig.metrics_json.retweet_count > 0) && (
                  <span className="text-xs text-gray-600">
                    {sig.metrics_json.like_count > 0 && `${sig.metrics_json.like_count} likes`}
                    {sig.metrics_json.retweet_count > 0 && ` · ${sig.metrics_json.retweet_count} RTs`}
                  </span>
                )}
                {sig.ingestion_status === 'deployed' && (
                  <span className="ml-auto text-xs text-brand font-medium">deployado</span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function EmptyDetail() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-gray-600 text-sm">Selecione um sinal no feed</p>
    </div>
  )
}

function SignalDetail({ signal, analysis, asset, existingDraft, analyzing, onAnalyze, onOpenDeploy }: {
  signal: Signal
  analysis: SignalAnalysis | null
  asset: PostAsset | null
  existingDraft: LaunchDraft | null
  analyzing: boolean
  onAnalyze: () => void
  onOpenDeploy: (d: LaunchDraft) => void
}) {
  return (
    <>
      {/* Post */}
      <div className="bg-surface-800 rounded-lg p-4 border border-surface-700">
        <div className="flex items-start gap-3 mb-3">
          {signal.author_avatar_url
            ? <img src={signal.author_avatar_url} alt="" className="w-9 h-9 rounded-full flex-shrink-0" />
            : <div className="w-9 h-9 rounded-full bg-surface-600 flex-shrink-0 flex items-center justify-center text-sm font-bold text-gray-400">{signal.author_handle[0]?.toUpperCase()}</div>
          }
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-white">{signal.author_name}</span>
              <span className="text-xs text-gray-500">@{signal.author_handle}</span>
              <span className="text-xs text-gray-600">{timeAgo(signal.posted_at)}</span>
              <StatusDot status={signal.ingestion_status} />
              <span className="text-xs text-gray-600 capitalize">{signal.ingestion_status}</span>
            </div>
          </div>
          <a href={signal.post_url} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline flex-shrink-0">
            ver no X
          </a>
        </div>
        <p className="text-sm text-gray-200 leading-relaxed">{signal.text_raw}</p>
        {signal.metrics_json && (
          <div className="flex gap-4 text-xs text-gray-600 mt-3 pt-3 border-t border-surface-700">
            <span>{signal.metrics_json.like_count} likes</span>
            <span>{signal.metrics_json.retweet_count} RTs</span>
            <span>{signal.metrics_json.reply_count} replies</span>
          </div>
        )}
      </div>

      {/* Asset */}
      {asset && (
        <div className="bg-surface-800 rounded-lg overflow-hidden border border-surface-700">
          <img src={asset.public_url} alt="Media" className="w-full max-h-52 object-contain bg-black" />
        </div>
      )}

      {/* Analise */}
      {analysis ? (
        <div className="bg-surface-800 rounded-lg p-4 border border-surface-700 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Analise IA</span>
            <div className="flex items-center gap-2">
              <ScorePill label={analysis.score_label} score={analysis.score} />
              <span className="text-xs text-gray-600">{Math.round(analysis.confidence * 100)}% conf.</span>
              <button onClick={onAnalyze} disabled={analyzing} className="text-xs text-gray-500 hover:text-white">
                {analyzing ? 'analisando...' : 're-analisar'}
              </button>
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Nome sugerido</p>
            <p className="text-sm font-semibold text-white">{analysis.extracted_name}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-2">Tickers sugeridos</p>
            <div className="flex gap-2">
              <span className="px-2.5 py-1 rounded bg-green-900/40 text-green-300 text-sm font-mono font-bold border border-green-800">${analysis.extracted_ticker_primary}</span>
              <span className="px-2.5 py-1 rounded bg-surface-700 text-gray-300 text-sm font-mono border border-surface-600">${analysis.extracted_ticker_alt_1}</span>
              <span className="px-2.5 py-1 rounded bg-surface-700 text-gray-300 text-sm font-mono border border-surface-600">${analysis.extracted_ticker_alt_2}</span>
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Descricao</p>
            <p className="text-sm text-gray-300">{analysis.short_description}</p>
          </div>
        </div>
      ) : (
        <div className="bg-surface-800 rounded-lg p-4 border border-surface-700 flex items-center justify-between">
          <span className="text-sm text-gray-500">Sem analise ainda</span>
          <button onClick={onAnalyze} disabled={analyzing} className="btn-primary text-xs py-1.5 px-3">
            {analyzing ? 'analisando...' : 'Analisar'}
          </button>
        </div>
      )}

      {/* Draft existente */}
      {existingDraft && (
        <div className="bg-surface-800 rounded-lg p-3 border border-purple-800/60 flex items-center justify-between">
          <div>
            <span className="text-xs text-purple-400 font-medium">Draft criado</span>
            <span className="text-xs text-gray-400 ml-2 font-mono">{existingDraft.name} / ${existingDraft.ticker}</span>
          </div>
          {existingDraft.status === 'pending' && (
            <button onClick={() => onOpenDeploy(existingDraft)} className="btn-primary text-xs py-1 px-3">Deploy</button>
          )}
          {existingDraft.status === 'deployed' && <span className="text-xs text-brand">Deployado</span>}
        </div>
      )}
    </>
  )
}

function ActionPanel({ signal, analysis, existingDraft, creatingDraft, analyzing, onCreateDraft, onOpenDeploy, onAnalyze, onIgnore, onGoDeployed }: {
  signal: Signal
  analysis: SignalAnalysis | null
  existingDraft: LaunchDraft | null
  creatingDraft: boolean
  analyzing: boolean
  onCreateDraft: () => void
  onOpenDeploy: (d: LaunchDraft) => void
  onAnalyze: () => void
  onIgnore: () => void
  onGoDeployed: () => void
}) {
  return (
    <div className="space-y-2">
      {!analysis && signal.ingestion_status !== 'deployed' && (
        <button onClick={onAnalyze} disabled={analyzing} className="btn-primary w-full text-xs py-2">
          {analyzing ? 'analisando...' : 'Analisar Signal'}
        </button>
      )}
      {analysis && !existingDraft && signal.ingestion_status !== 'ignored' && signal.ingestion_status !== 'deployed' && (
        <button onClick={onCreateDraft} disabled={creatingDraft} className="btn-primary w-full text-xs py-2">
          {creatingDraft ? 'criando draft...' : 'Criar Draft + Deploy'}
        </button>
      )}
      {existingDraft?.status === 'pending' && (
        <button onClick={() => onOpenDeploy(existingDraft)} className="btn-primary w-full text-xs py-2">
          Abrir Deploy
        </button>
      )}
      {(existingDraft?.status === 'deployed' || signal.ingestion_status === 'deployed') && (
        <button onClick={onGoDeployed} className="btn-primary w-full text-xs py-2">
          Ver no Deployed
        </button>
      )}
      {signal.ingestion_status !== 'ignored' && signal.ingestion_status !== 'deployed' && (
        <button onClick={onIgnore} className="w-full text-xs py-2 rounded border border-surface-600 text-gray-500 hover:text-danger hover:border-danger/40 transition-colors">
          Ignorar
        </button>
      )}
      <a href={signal.post_url} target="_blank" rel="noreferrer"
        className="block w-full text-center text-xs py-2 rounded border border-surface-600 text-gray-400 hover:text-white hover:border-surface-400 transition-colors">
        Abrir no X
      </a>
    </div>
  )
}

function DeployPanel({ form, setForm, onDeploy, onClose, deploying, result, hasSession }: {
  form: DeployForm
  setForm: (f: DeployForm | null) => void
  onDeploy: () => void
  onClose: () => void
  deploying: boolean
  result: { ok: boolean; msg: string } | null
  hasSession: boolean
}) {
  function update(patch: Partial<DeployForm>) {
    setForm({ ...form, ...patch })
  }
  return (
    <div className="bg-surface-800 rounded-lg p-3 border border-surface-600 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-white">Confirmar Deploy</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white text-xs">x</button>
      </div>
      <Field label="Nome">
        <input className="input w-full text-xs py-1.5" value={form.name} onChange={e => update({ name: e.target.value })} />
      </Field>
      <Field label="Ticker">
        <input className="input w-full text-xs py-1.5 font-mono uppercase" value={form.ticker} maxLength={6}
          onChange={e => update({ ticker: e.target.value.toUpperCase() })} />
      </Field>
      <Field label="Descricao">
        <textarea className="input w-full text-xs py-1.5 resize-none" rows={2} value={form.description}
          onChange={e => update({ description: e.target.value })} />
      </Field>
      <Field label="Dev Buy SOL">
        <input className="input w-full text-xs py-1.5" type="number" min="0" step="0.1" value={form.devBuySol}
          onChange={e => update({ devBuySol: e.target.value })} />
      </Field>
      <Field label="Fee">
        <select className="input w-full text-xs py-1.5" value={form.feeLevel}
          onChange={e => update({ feeLevel: e.target.value as any })}>
          <option value="fast">fast</option>
          <option value="turbo">turbo</option>
          <option value="ultra">ultra</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={form.useJito} onChange={e => update({ useJito: e.target.checked })} className="rounded" />
        <span className="text-xs text-gray-400">Usar Jito</span>
      </label>
      {!hasSession && <p className="text-xs text-yellow-400">Ative uma wallet para deployar.</p>}
      {result && <p className={`text-xs ${result.ok ? 'text-green-400' : 'text-danger'}`}>{result.msg}</p>}
      <button onClick={onDeploy} disabled={deploying || !hasSession || result?.ok === true} className="btn-primary w-full text-xs py-2">
        {deploying ? 'deployando...' : result?.ok ? 'feito!' : 'Confirmar Deploy'}
      </button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-gray-500 block mb-1">{label}</label>
      {children}
    </div>
  )
}

// -------------------------------------------------------
// Aba Deployed — gerenciamento de tokens lançados
// -------------------------------------------------------

const SLIPPAGE_OPTIONS: { label: string; value: string }[] = [
  { label: '1% (fast)', value: 'fast' },
  { label: '3% (turbo)', value: 'turbo' },
  { label: '5%+ (ultra)', value: 'ultra' },
]

function DeployedPanel({ tokens, tokenInfos, tokenActions, onSellAll, onClaimFees, onRefreshInfo, hasSession }: {
  tokens: DeployedToken[]
  tokenInfos: Record<string, TokenInfo>
  tokenActions: Record<string, TokenAction>
  onSellAll: (mint: string, pct: number, feeLevel: string) => void
  onClaimFees: (mint: string) => void
  onRefreshInfo: (mint: string) => void
  hasSession: boolean
}) {
  const [sellPct, setSellPct] = useState<Record<string, number>>({})
  const [slippage, setSlippage] = useState<Record<string, string>>({})

  function getPct(mint: string) { return sellPct[mint] ?? 100 }
  function getSlippage(mint: string) { return slippage[mint] ?? 'fast' }

  if (tokens.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-600 text-sm">Nenhum token deployado ainda via Live Deploys.</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {tokens.map(token => {
          const draft = token.launch_drafts
          const mint = token.mint_address
          const info = tokenInfos[mint]
          const action = tokenActions[mint]
          const pct = getPct(mint)
          const slip = getSlippage(mint)
          const estimatedSol = info ? Number(info.balance) * (pct / 100) * info.price : null

          return (
            <div key={token.id} className="bg-surface-800 rounded-lg border border-surface-700 overflow-hidden">
              {/* Header com imagem */}
              <div className="flex items-center gap-3 p-3 border-b border-surface-700">
                {draft?.image_url ? (
                  <img src={draft.image_url} alt="" className="w-12 h-12 rounded object-cover flex-shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded bg-surface-700 flex-shrink-0 flex items-center justify-center text-gray-500 text-lg font-bold">
                    {draft?.ticker?.[0] ?? '?'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white text-sm">{draft?.name ?? 'Token'}</span>
                    <span className="text-xs text-brand font-mono">${draft?.ticker}</span>
                  </div>
                  {draft?.source_posts?.author_handle && (
                    <a href={draft.source_posts.post_url ?? '#'} target="_blank" rel="noreferrer"
                      className="text-xs text-gray-500 hover:text-brand">
                      @{draft.source_posts.author_handle}
                    </a>
                  )}
                  <div className="text-xs text-gray-600 mt-0.5">{timeAgo(token.created_at)}</div>
                </div>
                <button onClick={() => onRefreshInfo(mint)} className="text-xs text-gray-600 hover:text-white flex-shrink-0 px-1">
                  ↺
                </button>
              </div>

              {/* Info + PnL */}
              <div className="px-3 py-2 border-b border-surface-700 space-y-2">
                {/* Valor atual em destaque */}
                {info ? (() => {
                  const currentValueSol = Number(info.balance) * info.price
                  const pnlSol = token.dev_buy_sol > 0 ? currentValueSol - token.dev_buy_sol : null
                  const pnlPct = pnlSol !== null && token.dev_buy_sol > 0 ? (pnlSol / token.dev_buy_sol) * 100 : null
                  const isPos = pnlSol === null || pnlSol >= 0
                  return (
                    <div className={`rounded-lg px-3 py-2 ${pnlSol !== null ? (isPos ? 'bg-green-900/20 border border-green-800/40' : 'bg-red-900/20 border border-red-800/40') : 'bg-surface-700 border border-surface-600'}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs text-gray-500">Valor atual</div>
                          <div className="text-xl font-mono font-bold text-white">{currentValueSol.toFixed(4)}◎</div>
                          {token.dev_buy_sol > 0 && (
                            <div className="text-xs text-gray-500 mt-0.5">Entrada: {token.dev_buy_sol}◎</div>
                          )}
                        </div>
                        {pnlPct !== null && (
                          <div className="text-right">
                            <div className={`text-2xl font-bold font-mono ${isPos ? 'text-green-400' : 'text-red-400'}`}>
                              {isPos ? '+' : ''}{pnlPct.toFixed(1)}%
                            </div>
                            <div className={`text-sm font-mono ${isPos ? 'text-green-500' : 'text-red-500'}`}>
                              {isPos ? '+' : ''}{pnlSol!.toFixed(4)}◎
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })() : (
                  <div className="bg-surface-700 rounded px-3 py-2 flex items-center justify-between">
                    <span className="text-sm text-gray-500">Carregando preco...</span>
                    {token.dev_buy_sol > 0 && <span className="text-xs text-gray-600">Entrada: {token.dev_buy_sol}◎</span>}
                  </div>
                )}

                {/* Detalhes */}
                <div className="flex items-center gap-3 text-xs">
                  <div>
                    <span className="text-gray-500">Saldo: </span>
                    <span className="text-gray-300 font-mono">{info ? Number(info.balance).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Preco: </span>
                    <span className="text-gray-300 font-mono">{info ? `${info.price.toFixed(9)}◎` : '—'}</span>
                  </div>
                  <div className="ml-auto">
                    {mint ? (
                      <a href={`https://pump.fun/${mint}`} target="_blank" rel="noreferrer"
                        className="font-mono text-brand hover:underline">
                        {mint.slice(0, 6)}...{mint.slice(-4)}
                      </a>
                    ) : (
                      <span className="text-red-400 font-mono">nao salvo</span>
                    )}
                  </div>
                </div>
              </div>

              {/* TX */}
              <div className="px-3 py-1.5 border-b border-surface-700 flex items-center gap-2">
                <span className="text-xs text-gray-600">TX:</span>
                <a
                  href={`https://solscan.io/tx/${token.tx_hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-mono text-gray-400 hover:text-white"
                >
                  {token.tx_hash?.slice(0, 20)}...
                </a>
              </div>

              {/* Acoes */}
              <div className="p-3 space-y-2.5">
                {/* Sell slider */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-400">Vender</span>
                    <span className="text-xs font-mono text-white font-semibold">{pct}%</span>
                  </div>
                  <input
                    type="range"
                    min={1} max={100}
                    value={pct}
                    onChange={e => setSellPct(prev => ({ ...prev, [mint]: Number(e.target.value) }))}
                    className="w-full h-1.5 rounded accent-brand cursor-pointer"
                  />
                  <div className="flex gap-1 mt-1.5">
                    {[25, 50, 75, 100].map(v => (
                      <button
                        key={v}
                        onClick={() => setSellPct(prev => ({ ...prev, [mint]: v }))}
                        className={`flex-1 text-xs py-0.5 rounded border transition-colors ${pct === v ? 'border-brand/60 text-brand' : 'border-surface-600 text-gray-500 hover:text-white'}`}
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                </div>

                {/* Estimativa de recebimento */}
                {estimatedSol !== null && (
                  <div className="flex items-center justify-between bg-surface-700 rounded px-2.5 py-1.5">
                    <span className="text-xs text-gray-400">Voce recebera ~</span>
                    <span className="text-sm font-mono font-bold text-white">{estimatedSol.toFixed(4)}◎</span>
                  </div>
                )}

                {/* Slippage */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 flex-shrink-0">Slippage</span>
                  <div className="flex gap-1 flex-1">
                    {SLIPPAGE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setSlippage(prev => ({ ...prev, [mint]: opt.value }))}
                        className={`flex-1 text-xs py-0.5 rounded border transition-colors ${slip === opt.value ? 'border-brand/60 text-brand bg-brand/10' : 'border-surface-600 text-gray-500 hover:text-white'}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => onSellAll(mint, pct, slip)}
                    disabled={!hasSession || action?.loading}
                    className="flex-1 btn-primary text-xs py-2 font-semibold"
                  >
                    {action?.loading ? 'aguarde...' : `Sell ${pct}%`}
                  </button>
                  <button
                    onClick={() => onClaimFees(mint)}
                    disabled={!hasSession || action?.loading}
                    className="px-3 py-2 rounded border border-surface-600 text-xs text-gray-400 hover:text-white hover:border-surface-400 transition-colors"
                    title="Claim Fees"
                  >
                    Claim Fees
                  </button>
                </div>

                {action?.result && <p className="text-xs text-green-400">{action.result}</p>}
                {action?.error && <p className="text-xs text-danger">{action.error}</p>}
                {!hasSession && <p className="text-xs text-yellow-500">Ative uma wallet para operar.</p>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
