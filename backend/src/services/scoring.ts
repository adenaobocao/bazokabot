export interface ScoringInput {
  isWatched: boolean
  ageMinutes: number
  hasMedia: boolean
  textLength: number
  likeCount: number
  retweetCount: number
  replyCount: number
  textRaw: string
}

export function scoreSignal(input: ScoringInput): { score: number; label: 'low' | 'medium' | 'high' } {
  let score = 40 // base

  // +15 se conta esta na watchlist
  if (input.isWatched) score += 15

  // Frescor do post
  if (input.ageMinutes < 30) score += 15
  else if (input.ageMinutes < 120) score += 8
  else if (input.ageMinutes < 360) score += 2
  else score -= 8

  // Midia visual
  if (input.hasMedia) score += 10

  // Tamanho do texto — ideal curto e direto
  if (input.textLength <= 80) score += 8
  else if (input.textLength <= 160) score += 4
  else if (input.textLength > 300) score -= 8

  // Engajamento inicial
  const eng = input.likeCount + input.retweetCount * 2 + input.replyCount
  if (eng > 1000) score += 12
  else if (eng > 200) score += 7
  else if (eng > 50) score += 3
  else if (eng < 5) score -= 5

  // Palavra parecendo ticker (letras maiusculas 2-6 chars)
  if (/\b[A-Z]{2,6}\b/.test(input.textRaw)) score += 5

  // Penalidade: link sem contexto visual
  const hasLink = /https?:\/\//.test(input.textRaw)
  if (hasLink && !input.hasMedia) score -= 3

  score = Math.max(0, Math.min(100, score))
  const label: 'low' | 'medium' | 'high' = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
  return { score, label }
}
