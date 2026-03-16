import { supabase } from '../db/supabase'

export async function downloadAndStoreMedia(
  url: string,
  postId: string,
  assetType: 'original_media' | 'screenshot' | 'link_image' = 'original_media'
): Promise<{ storagePath: string; publicUrl: string; mimeType: string } | null> {
  if (!supabase) return null

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null

    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg'
    const buffer = await response.arrayBuffer()

    const fileName = `${assetType}/${postId}_${Date.now()}.${ext}`

    const { error } = await supabase.storage
      .from('live-deploys')
      .upload(fileName, buffer, { contentType, upsert: false })

    if (error) {
      console.error('[AssetService] Upload falhou:', error.message)
      return null
    }

    const { data: urlData } = supabase.storage.from('live-deploys').getPublicUrl(fileName)
    return { storagePath: fileName, publicUrl: urlData.publicUrl, mimeType: contentType }
  } catch (err) {
    console.error('[AssetService] Download falhou:', err)
    return null
  }
}
