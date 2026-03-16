import { GoogleGenerativeAI } from '@google/generative-ai'

export interface ExtractionResult {
  suggested_name: string
  tickers: [string, string, string]
  short_description: string
  confidence: number
  reasoning_summary: string
}

// Fallback heuristico quando Gemini nao esta configurado
function heuristicExtract(text: string, handle: string): ExtractionResult {
  // Tenta extrair palavra em maiusculas como ticker candidato
  const tickerMatch = text.match(/\b([A-Z]{2,6})\b/)
  const candidateTicker = tickerMatch?.[1] ?? handle.toUpperCase().slice(0, 5)

  // Nome: primeiras 4 palavras do texto, sem pontuacao
  const words = text.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
  const suggestedName = words.slice(0, 4).join(' ') || handle

  return {
    suggested_name: suggestedName,
    tickers: [
      candidateTicker.slice(0, 5),
      candidateTicker + 'AI',
      candidateTicker + 'X',
    ],
    short_description: text.slice(0, 100),
    confidence: 0.3,
    reasoning_summary: 'Extracao heuristica — configure GEMINI_API_KEY para analise com IA',
  }
}

export async function extractSignalData(
  text: string,
  authorHandle: string,
  _hasMedia: boolean
): Promise<ExtractionResult> {
  if (!process.env.GEMINI_API_KEY) {
    return heuristicExtract(text, authorHandle)
  }

  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' })

  const prompt = `You are a meme coin naming expert. Analyze this tweet and extract launch metadata.

Tweet from @${authorHandle}:
"${text}"

Return ONLY valid JSON, no markdown, no explanation:
{
  "suggested_name": "short brandable name (2-4 words, catchy, memorable)",
  "tickers": ["CONSERVATIVE", "MEMETIC", "AGGRESSIVE"],
  "short_description": "one catchy line for the token launch (max 100 chars)",
  "confidence": 0.85,
  "reasoning_summary": "brief explanation of choices (1-2 sentences)"
}

Ticker rules:
- 3-6 uppercase letters A-Z only
- conservative: safe abbreviation of the main concept
- memetic: fun, viral, internet-culture inspired
- aggressive: bold, short, punchy
- all 3 must be different`

  try {
    const result = await model.generateContent(prompt)
    const raw = result.response.text().trim()

    // Extrai o JSON da resposta
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('Gemini nao retornou JSON valido')

    const parsed = JSON.parse(match[0]) as ExtractionResult

    // Valida estrutura minima
    if (!parsed.suggested_name || !Array.isArray(parsed.tickers) || parsed.tickers.length < 3) {
      throw new Error('Estrutura JSON invalida')
    }

    return parsed
  } catch (err) {
    console.error('[Extraction] Gemini falhou, usando heuristica:', err)
    return heuristicExtract(text, authorHandle)
  }
}
