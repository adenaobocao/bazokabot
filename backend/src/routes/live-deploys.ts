import { Router } from 'express'
import { supabase } from '../db/supabase'
import { extractSignalData } from '../services/extraction'
import { scoreSignal } from '../services/scoring'
import { triggerPollNow, getWorkerStatus } from '../workers/ingestion'

export const liveDeploysRouter = Router()

function noDb(res: any) {
  return res.status(503).json({ error: 'Supabase nao configurado' })
}

// -------------------------------------------------------
// Fontes monitoradas
// -------------------------------------------------------

liveDeploysRouter.get('/sources', async (_req, res) => {
  if (!supabase) return noDb(res)
  const { data, error } = await supabase
    .from('tracked_sources')
    .select('*')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

liveDeploysRouter.post('/sources', async (req, res) => {
  if (!supabase) return noDb(res)
  const { source_value, source_type = 'account', priority = 5 } = req.body
  if (!source_value) return res.status(400).json({ error: 'source_value obrigatorio' })

  const clean = (source_value as string).replace('@', '').toLowerCase().trim()

  const { data, error } = await supabase
    .from('tracked_sources')
    .upsert({ source_type, source_value: clean, is_active: true, priority }, { onConflict: 'source_value' })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

liveDeploysRouter.delete('/sources/:id', async (req, res) => {
  if (!supabase) return noDb(res)
  const { error } = await supabase
    .from('tracked_sources')
    .update({ is_active: false })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// -------------------------------------------------------
// Sinais
// -------------------------------------------------------

liveDeploysRouter.get('/signals', async (req, res) => {
  if (!supabase) return noDb(res)

  const { status, score_label, has_media, limit = '50', offset = '0' } = req.query

  let query = supabase
    .from('source_posts')
    .select('*, signal_analysis(*), post_assets(*)')
    .order('posted_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (status) query = query.eq('ingestion_status', status as string)
  if (has_media === 'true') query = query.eq('has_media', true)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  // Filtro por score_label (nao tem FK direta para filtrar via supabase query)
  let result = data ?? []
  if (score_label) {
    result = result.filter((p: any) =>
      Array.isArray(p.signal_analysis)
        ? p.signal_analysis.some((a: any) => a.score_label === score_label)
        : p.signal_analysis?.score_label === score_label
    )
  }

  res.json(result)
})

liveDeploysRouter.get('/signals/:id', async (req, res) => {
  if (!supabase) return noDb(res)
  const { data, error } = await supabase
    .from('source_posts')
    .select('*, signal_analysis(*), post_assets(*), launch_drafts(*)')
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: 'Sinal nao encontrado' })
  res.json(data)
})

liveDeploysRouter.post('/signals/:id/analyze', async (req, res) => {
  if (!supabase) return noDb(res)

  const { data: post, error } = await supabase
    .from('source_posts')
    .select('*')
    .eq('id', req.params.id)
    .single()
  if (error || !post) return res.status(404).json({ error: 'Sinal nao encontrado' })

  try {
    const extracted = await extractSignalData(post.text_raw, post.author_handle, post.has_media)
    const ageMinutes = (Date.now() - new Date(post.posted_at).getTime()) / 60_000
    const metrics = post.metrics_json ?? {}
    const { score, label } = scoreSignal({
      isWatched: true,
      ageMinutes,
      hasMedia: post.has_media,
      textLength: post.text_raw.length,
      likeCount: metrics.like_count ?? 0,
      retweetCount: metrics.retweet_count ?? 0,
      replyCount: metrics.reply_count ?? 0,
      textRaw: post.text_raw,
    })

    const { data: analysis, error: upsertErr } = await supabase
      .from('signal_analysis')
      .upsert({
        source_post_id: post.id,
        score,
        score_label: label,
        extracted_name: extracted.suggested_name,
        extracted_ticker_primary: extracted.tickers[0],
        extracted_ticker_alt_1: extracted.tickers[1],
        extracted_ticker_alt_2: extracted.tickers[2],
        short_description: extracted.short_description,
        confidence: extracted.confidence,
        analysis_json: extracted,
      }, { onConflict: 'source_post_id' })
      .select()
      .single()
    if (upsertErr) throw upsertErr

    await supabase
      .from('source_posts')
      .update({ ingestion_status: 'ready' })
      .eq('id', post.id)

    res.json(analysis)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Extracao falhou' })
  }
})

liveDeploysRouter.post('/signals/:id/ignore', async (req, res) => {
  if (!supabase) return noDb(res)
  const { error } = await supabase
    .from('source_posts')
    .update({ ingestion_status: 'ignored' })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// -------------------------------------------------------
// Drafts
// -------------------------------------------------------

liveDeploysRouter.post('/signals/:id/create-draft', async (req, res) => {
  if (!supabase) return noDb(res)

  const source_post_id = req.params.id
  const { name, ticker, description, twitter_url, image_url } = req.body

  if (!name || !ticker) return res.status(400).json({ error: 'name e ticker obrigatorios' })

  // Previne draft duplicado
  const { data: existing } = await supabase
    .from('launch_drafts')
    .select('id, name, ticker, description, twitter_url, image_url, status')
    .eq('source_post_id', source_post_id)
    .eq('status', 'pending')
    .maybeSingle()
  if (existing) return res.json(existing)

  const { data, error } = await supabase
    .from('launch_drafts')
    .insert({ source_post_id, name, ticker, description, twitter_url, image_url })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  await supabase
    .from('source_posts')
    .update({ ingestion_status: 'reviewed' })
    .eq('id', source_post_id)

  res.json(data)
})

liveDeploysRouter.get('/drafts', async (_req, res) => {
  if (!supabase) return noDb(res)
  const { data, error } = await supabase
    .from('launch_drafts')
    .select('*, source_posts(author_handle, post_url, text_raw, author_avatar_url)')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

liveDeploysRouter.patch('/drafts/:id', async (req, res) => {
  if (!supabase) return noDb(res)
  const { name, ticker, description, twitter_url, image_url } = req.body
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (name !== undefined) update.name = name
  if (ticker !== undefined) update.ticker = ticker
  if (description !== undefined) update.description = description
  if (twitter_url !== undefined) update.twitter_url = twitter_url
  if (image_url !== undefined) update.image_url = image_url

  const { data, error } = await supabase
    .from('launch_drafts')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Registra resultado de deploy (chamado pelo frontend apos deploy bem-sucedido)
liveDeploysRouter.post('/drafts/:id/deployed', async (req, res) => {
  if (!supabase) return noDb(res)

  const { tx_hash, mint_address, error_message, deploy_status = 'success' } = req.body

  const { data: draft } = await supabase
    .from('launch_drafts')
    .select('id, source_post_id')
    .eq('id', req.params.id)
    .single()
  if (!draft) return res.status(404).json({ error: 'Draft nao encontrado' })

  // Previne deploy duplicado
  const { data: existingRun } = await supabase
    .from('deploy_runs')
    .select('id')
    .eq('launch_draft_id', draft.id)
    .eq('deploy_status', 'success')
    .maybeSingle()
  if (existingRun) return res.status(409).json({ error: 'Ja deployado' })

  const { data: run, error: runErr } = await supabase
    .from('deploy_runs')
    .insert({
      launch_draft_id: draft.id,
      deploy_status,
      tx_hash: tx_hash ?? null,
      mint_address: mint_address ?? null,
      error_message: error_message ?? null,
    })
    .select()
    .single()
  if (runErr) return res.status(500).json({ error: runErr.message })

  if (deploy_status === 'success') {
    await Promise.all([
      supabase.from('launch_drafts').update({ status: 'deployed' }).eq('id', draft.id),
      supabase.from('source_posts').update({ ingestion_status: 'deployed' }).eq('id', draft.source_post_id),
    ])
  }

  res.json(run)
})

// -------------------------------------------------------
// Worker: status e poll manual
// -------------------------------------------------------

liveDeploysRouter.get('/worker-status', (_req, res) => {
  res.json(getWorkerStatus())
})

liveDeploysRouter.post('/poll-now', async (_req, res) => {
  const status = getWorkerStatus()
  if (status.isPolling) return res.json({ ok: false, message: 'Poll ja em andamento' })
  triggerPollNow().catch(() => {}) // roda em background
  res.json({ ok: true, message: 'Poll iniciado' })
})

// Seed de contas populares para watchlist
const SEED_HANDLES = [
  // Cripto / traders
  'elonmusk', 'realDonaldTrump', 'saylor', 'cz_binance', 'justinsuntron',
  'brian_armstrong', 'VitalikButerin', 'balajis', 'RaoulGMI', 'chamath',
  'DavidSacks', 'naval', 'gainzy222',
  // Celebridades / meme culture
  'SnoopDogg', 'ParisHilton', 'KimKardashian', 'garyvee', 'mcuban',
  // Cripto native influencers
  'blknoiz06', 'CryptoKaleo', 'AltcoinGordon',
]

liveDeploysRouter.post('/seed-watchlist', async (_req, res) => {
  if (!supabase) return noDb(res)
  const results: { handle: string; ok: boolean }[] = []
  for (const handle of SEED_HANDLES) {
    try {
      await supabase.from('tracked_sources').upsert(
        { source_type: 'account', source_value: handle, is_active: true, priority: 5 },
        { onConflict: 'source_value' }
      )
      results.push({ handle, ok: true })
    } catch {
      results.push({ handle, ok: false })
    }
  }
  res.json({ added: results.filter(r => r.ok).length, results })
})

// -------------------------------------------------------
// Stats
// -------------------------------------------------------

liveDeploysRouter.get('/stats', async (_req, res) => {
  if (!supabase) return noDb(res)

  const [{ data: posts }, { data: drafts }, { data: runs }] = await Promise.all([
    supabase.from('source_posts').select('ingestion_status'),
    supabase.from('launch_drafts').select('status'),
    supabase.from('deploy_runs').select('deploy_status'),
  ])

  res.json({
    signals: {
      total: posts?.length ?? 0,
      new: posts?.filter(p => p.ingestion_status === 'new').length ?? 0,
      ready: posts?.filter(p => p.ingestion_status === 'ready').length ?? 0,
      deployed: posts?.filter(p => p.ingestion_status === 'deployed').length ?? 0,
      ignored: posts?.filter(p => p.ingestion_status === 'ignored').length ?? 0,
    },
    drafts: {
      pending: drafts?.filter(d => d.status === 'pending').length ?? 0,
      deployed: drafts?.filter(d => d.status === 'deployed').length ?? 0,
    },
    deploys: {
      total: runs?.length ?? 0,
      success: runs?.filter(r => r.deploy_status === 'success').length ?? 0,
    },
  })
})
