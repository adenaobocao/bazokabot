import { supabase } from '../db/supabase'
import { scoreSignal } from '../services/scoring'
import { extractSignalData } from '../services/extraction'
import { downloadAndStoreMedia } from '../services/asset-service'

// Callback injetado pelo server.ts para evitar dependencia circular
type BroadcastFn = (data: unknown) => void
let _broadcast: BroadcastFn = () => {}

export function setBroadcastFn(fn: BroadcastFn) {
  _broadcast = fn
}

const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutos
let pollingTimer: ReturnType<typeof setInterval> | null = null

// Cache em memoria para deduplicar na mesma sessao
const seenIds = new Set<string>()

// -------------------------------------------------------
// X API helpers
// -------------------------------------------------------

interface XTweet {
  id: string
  text: string
  author_id: string
  created_at: string
  attachments?: { media_keys?: string[] }
  public_metrics?: { like_count: number; retweet_count: number; reply_count: number }
}

interface XMedia {
  media_key: string
  type: string
  url?: string
  preview_image_url?: string
}

interface XUser {
  id: string
  name: string
  username: string
  profile_image_url?: string
}

async function xGet(path: string): Promise<Response> {
  return fetch(`https://api.twitter.com/2${path}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  })
}

async function resolveUserId(handle: string): Promise<string | null> {
  try {
    const res = await xGet(`/users/by/username/${handle}?user.fields=id`)
    if (!res.ok) {
      console.error(`[Ingestion] Nao encontrou usuario @${handle}: ${res.status}`)
      return null
    }
    const data = await res.json() as { data?: { id: string } }
    return data.data?.id ?? null
  } catch {
    return null
  }
}

async function fetchUserTimeline(
  userId: string,
  sinceId?: string
): Promise<{ tweets: XTweet[]; media: XMedia[]; users: XUser[] }> {
  const params = new URLSearchParams({
    max_results: '20',
    'tweet.fields': 'created_at,public_metrics,attachments',
    expansions: 'author_id,attachments.media_keys',
    'media.fields': 'url,preview_image_url,type',
    'user.fields': 'username,name,profile_image_url',
  })
  if (sinceId) params.set('since_id', sinceId)

  const res = await xGet(`/users/${userId}/tweets?${params}`)
  if (!res.ok) throw new Error(`X API ${res.status} para userId ${userId}`)

  const data = await res.json() as {
    data?: XTweet[]
    includes?: { media?: XMedia[]; users?: XUser[] }
  }
  return {
    tweets: data.data ?? [],
    media: data.includes?.media ?? [],
    users: data.includes?.users ?? [],
  }
}

// -------------------------------------------------------
// Processamento de um tweet
// -------------------------------------------------------

async function processTweet(
  tweet: XTweet,
  author: XUser,
  mediaItems: XMedia[],
  isWatched: boolean
): Promise<void> {
  if (!supabase) return
  if (seenIds.has(tweet.id)) return
  seenIds.add(tweet.id)

  // Dedupe no banco
  const { data: existing } = await supabase
    .from('source_posts')
    .select('id')
    .eq('external_post_id', tweet.id)
    .maybeSingle()
  if (existing) return

  const tweetMedia = mediaItems.filter(m => tweet.attachments?.media_keys?.includes(m.media_key))
  const hasMedia = tweetMedia.length > 0
  const postUrl = `https://x.com/${author.username}/status/${tweet.id}`
  const postedAt = new Date(tweet.created_at)
  const ageMinutes = (Date.now() - postedAt.getTime()) / 60_000
  const metrics = tweet.public_metrics ?? { like_count: 0, retweet_count: 0, reply_count: 0 }

  const { score, label } = scoreSignal({
    isWatched,
    ageMinutes,
    hasMedia,
    textLength: tweet.text.length,
    likeCount: metrics.like_count,
    retweetCount: metrics.retweet_count,
    replyCount: metrics.reply_count,
    textRaw: tweet.text,
  })

  // Salva o post
  const { data: post, error: insertErr } = await supabase
    .from('source_posts')
    .insert({
      external_post_id: tweet.id,
      author_handle: author.username,
      author_name: author.name,
      author_avatar_url: author.profile_image_url,
      post_url: postUrl,
      text_raw: tweet.text,
      posted_at: postedAt.toISOString(),
      metrics_json: metrics,
      has_media: hasMedia,
      ingestion_status: 'processing',
    })
    .select()
    .single()

  if (insertErr || !post) {
    console.error('[Ingestion] Erro ao salvar post:', insertErr?.message)
    return
  }

  _broadcast({ type: 'signal_new', postId: post.id, handle: author.username, score, label })

  // Download da midia
  let primaryAssetUrl: string | null = null
  if (hasMedia) {
    const mediaUrl = tweetMedia[0].url ?? tweetMedia[0].preview_image_url
    if (mediaUrl) {
      const stored = await downloadAndStoreMedia(mediaUrl, post.id)
      if (stored) {
        await supabase.from('post_assets').insert({
          source_post_id: post.id,
          asset_type: 'original_media',
          storage_path: stored.storagePath,
          public_url: stored.publicUrl,
          mime_type: stored.mimeType,
        })
        primaryAssetUrl = stored.publicUrl
      }
    }
  }

  // Extracao via IA
  let analysis = null
  try {
    const extracted = await extractSignalData(tweet.text, author.username, hasMedia)
    const { data: analysisRow } = await supabase
      .from('signal_analysis')
      .insert({
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
      })
      .select()
      .single()
    analysis = analysisRow
  } catch (err) {
    console.error(`[Ingestion] Extracao falhou para post ${post.id}:`, err)
  }

  await supabase
    .from('source_posts')
    .update({ ingestion_status: 'ready' })
    .eq('id', post.id)

  _broadcast({
    type: 'signal_ready',
    postId: post.id,
    score,
    label,
    primaryAssetUrl,
    analysis,
  })
}

// -------------------------------------------------------
// Poll principal
// -------------------------------------------------------

async function pollAllSources(): Promise<void> {
  if (!supabase) return

  const { data: sources } = await supabase
    .from('tracked_sources')
    .select('*')
    .eq('is_active', true)
    .eq('source_type', 'account')

  if (!sources?.length) return

  for (const source of sources) {
    try {
      let userId: string | null = source.x_user_id
      if (!userId) {
        userId = await resolveUserId(source.source_value)
        if (!userId) {
          console.warn(`[Ingestion] Nao encontrou userId para @${source.source_value}`)
          continue
        }
        await supabase
          .from('tracked_sources')
          .update({ x_user_id: userId })
          .eq('id', source.id)
      }

      const { tweets, media, users } = await fetchUserTimeline(userId, source.last_tweet_id ?? undefined)
      if (!tweets.length) continue

      // Processa do mais antigo para o mais recente
      for (const tweet of [...tweets].reverse()) {
        const author = users.find(u => u.id === tweet.author_id) ?? {
          id: userId!,
          username: source.source_value,
          name: source.source_value,
        }
        await processTweet(tweet, author as XUser, media, true)
      }

      // Atualiza cursor para o tweet mais recente
      await supabase
        .from('tracked_sources')
        .update({
          last_tweet_id: tweets[0].id,
          last_polled_at: new Date().toISOString(),
        })
        .eq('id', source.id)
    } catch (err) {
      console.error(`[Ingestion] Erro ao fazer poll de @${source.source_value}:`, err)
    }
  }
}

// -------------------------------------------------------
// Start / Stop
// -------------------------------------------------------

let isPolling = false
let lastPollAt: Date | null = null
let lastPollError: string | null = null

async function pollAllSourcesTracked(): Promise<void> {
  if (isPolling) return
  isPolling = true
  lastPollError = null
  try {
    await pollAllSources()
    lastPollAt = new Date()
  } catch (err) {
    lastPollError = err instanceof Error ? err.message : String(err)
  } finally {
    isPolling = false
  }
}

export function getWorkerStatus() {
  return {
    running: pollingTimer !== null,
    isPolling,
    lastPollAt: lastPollAt?.toISOString() ?? null,
    lastPollError,
    intervalMs: POLL_INTERVAL_MS,
    xConfigured: !!process.env.X_BEARER_TOKEN,
    supabaseConfigured: !!supabase,
  }
}

export async function triggerPollNow(): Promise<void> {
  await pollAllSourcesTracked()
}

export function startIngestionWorker(): void {
  if (!process.env.X_BEARER_TOKEN) {
    console.log('[Ingestion] X_BEARER_TOKEN nao configurado — worker desabilitado')
    return
  }
  if (!supabase) {
    console.log('[Ingestion] Supabase nao configurado — worker desabilitado')
    return
  }

  console.log('[Ingestion] Worker iniciado — poll a cada 5 minutos')
  pollAllSourcesTracked()
  pollingTimer = setInterval(pollAllSourcesTracked, POLL_INTERVAL_MS)
}

export function stopIngestionWorker(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}
