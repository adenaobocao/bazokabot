import { useState, useEffect, useRef, useCallback } from 'react' // eslint-disable-line
import { loadPositions, removePosition, savePosition, calcPNL, Position } from '../lib/positions'
import { loadHistory, addToHistory, clearHistory, ClosedTrade } from '../lib/history'
import { loadSession } from '../lib/session'
import { api } from '../lib/api'
import SellSlider from '../components/SellSlider'

type Tab = 'positions' | 'history'
type FeeLevel = 'normal' | 'fast' | 'turbo' | 'mayhem'
type PriceMap = Record<string, number>

interface RecoverForm {
  mint: string
  name: string
  symbol: string
  devBuySol: string
  devWalletPrivateKey: string
  bundleKeys: string  // uma por linha
}

export default function MonitorPage() {
  const [tab, setTab] = useState<Tab>('positions')
  const [positions, setPositions] = useState<Position[]>([])
  const [prices, setPrices] = useState<PriceMap>({})
  const [history, setHistory] = useState<ClosedTrade[]>([])
  const [selling, setSelling] = useState<Record<string, boolean>>({})
  const [sellError, setSellError] = useState<Record<string, string>>({})
  const [unlockedKeys] = useState<Record<string, string>>({})
  const [showBwKey, setShowBwKey] = useState<Record<string, boolean>>({})
  const [copiedKey, setCopiedKey] = useState<Record<string, boolean>>({})
  const [feeLevel] = useState<FeeLevel>('fast')
  const [useJito, setUseJito] = useState(true)
  const [claimingFees, setClaimingFees] = useState<Record<string, boolean>>({})
  const [claimMsg, setClaimMsg] = useState<Record<string, string>>({})
  const [vaultBalances, setVaultBalances] = useState<Record<string, number>>({})
  const [showRecover, setShowRecover] = useState(false)
  const [recoverForm, setRecoverForm] = useState<RecoverForm>({
    mint: '', name: '', symbol: '', devBuySol: '0', devWalletPrivateKey: '', bundleKeys: ''
  })
  const [recoverLoading, setRecoverLoading] = useState(false)
  const [recoverError, setRecoverError] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const session = loadSession()

  const copyKey = useCallback((id: string, key: string) => {
    navigator.clipboard.writeText(key)
    setCopiedKey(prev => ({ ...prev, [id]: true }))
    setTimeout(() => setCopiedKey(prev => ({ ...prev, [id]: false })), 2000)
  }, [])

  useEffect(() => {
    const pos = loadPositions()
    setPositions(pos)
    setHistory(loadHistory())
    connectWS(pos)
    pos.forEach(p => {
      fetchVaultBalance(p)
      // Se tokenAmounts estao zerados (deploy recente), busca saldos reais da blockchain
      const hasZeroAmounts =
        (p.devTokenAmount === '0' || p.devTokenAmount === '') &&
        p.bundleWallets.every(bw => bw.tokenAmount === '0' || bw.tokenAmount === '')
      if (hasZeroAmounts) fetchTokenBalances(p)
    })
    return () => { wsRef.current?.close() }
  }, [])

  async function fetchVaultBalance(pos: Position) {
    try {
      const params = new URLSearchParams()
      if (pos.devWalletPrivateKey) {
        params.set('devWalletPrivateKey', pos.devWalletPrivateKey)
      } else if (pos.devWalletPublicKey) {
        params.set('creatorPubkey', pos.devWalletPublicKey)
      }
      const res = await api.get<{ balance: number }>(`/token/creator-vault-balance?${params}`)
      if (res.balance > 0) {
        setVaultBalances(prev => ({ ...prev, [pos.mint]: res.balance }))
      }
    } catch { /* silencioso */ }
  }

  async function fetchTokenBalances(pos: Position) {
    try {
      const updatedPos = { ...pos, bundleWallets: pos.bundleWallets.map(bw => ({ ...bw })) }

      // Coleta private keys disponíveis (fresh dev wallet + bundle wallets)
      const privKeys: string[] = []
      if (pos.devWalletPrivateKey && pos.devTokenAmount === '0') {
        privKeys.push(pos.devWalletPrivateKey)
      }
      pos.bundleWallets.forEach(bw => {
        if ((bw.tokenAmount === '0' || bw.tokenAmount === '') && bw.privateKeyBase58) {
          privKeys.push(bw.privateKeyBase58)
        }
      })

      if (privKeys.length > 0) {
        const { balances } = await api.post<{ balances: { publicKey: string; balance: string }[] }>(
          `/token/${pos.mint}/balance-bundle`, { walletKeys: privKeys }
        )
        const map: Record<string, string> = {}
        balances.forEach(b => { map[b.publicKey] = b.balance })

        if (pos.devWalletPrivateKey && pos.devWalletPublicKey && map[pos.devWalletPublicKey]) {
          updatedPos.devTokenAmount = map[pos.devWalletPublicKey]
        }
        updatedPos.bundleWallets = pos.bundleWallets.map(bw => ({
          ...bw,
          tokenAmount: (map[bw.publicKey] && (bw.tokenAmount === '0' || bw.tokenAmount === ''))
            ? map[bw.publicKey]
            : bw.tokenAmount,
        }))
      } else if (!pos.devWalletPrivateKey && pos.devTokenAmount === '0') {
        // Dev wallet é a wallet de sessão — usa endpoint /info
        const { balance } = await api.get<{ balance: string }>(`/token/${pos.mint}/info`)
        if (balance && balance !== '0') updatedPos.devTokenAmount = balance
      }

      const changed = updatedPos.devTokenAmount !== pos.devTokenAmount ||
        updatedPos.bundleWallets.some((bw, i) => bw.tokenAmount !== pos.bundleWallets[i].tokenAmount)
      if (changed) {
        savePosition(updatedPos)
        setPositions(loadPositions())
      }
    } catch { /* silencioso */ }
  }

  async function claimFees(pos: Position) {
    setClaimingFees(prev => ({ ...prev, [pos.mint]: true }))
    setClaimMsg(prev => ({ ...prev, [pos.mint]: '' }))
    try {
      const res = await api.post<{ success: boolean; signature?: string; error?: string }>(
        '/token/claim-fees',
        {
          devWalletPrivateKey: pos.devWalletPrivateKey,
          feeLevel,
        }
      )
      if (res.success) {
        setClaimMsg(prev => ({ ...prev, [pos.mint]: 'Fees recebidas!' }))
        setVaultBalances(prev => ({ ...prev, [pos.mint]: 0 }))
        setTimeout(() => setClaimMsg(prev => ({ ...prev, [pos.mint]: '' })), 4000)
      } else {
        setClaimMsg(prev => ({ ...prev, [pos.mint]: res.error || 'Erro' }))
      }
    } catch (err: unknown) {
      setClaimMsg(prev => ({
        ...prev, [pos.mint]: err instanceof Error ? err.message : 'Erro'
      }))
    } finally {
      setClaimingFees(prev => ({ ...prev, [pos.mint]: false }))
    }
  }

  function connectWS(pos: Position[]) {
    if (!session?.token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${session.token}`)
    wsRef.current = ws

    ws.onopen = () => {
      pos.forEach(p => api.post('/monitor/start', { mint: p.mint }).catch(() => {}))
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'price_update') {
          setPrices(prev => ({ ...prev, [msg.mint]: msg.price }))
        }
      } catch { /* ignora */ }
    }

    ws.onclose = () => setTimeout(() => connectWS(loadPositions()), 3000)
  }

  // Vende uma wallet individual
  async function sellWallet(mint: string, percentage: number, walletPrivateKey?: string) {
    const key = `${mint}-${walletPrivateKey ? walletPrivateKey.slice(0, 6) : 'dev'}`
    setSelling(prev => ({ ...prev, [key]: true }))
    setSellError(prev => ({ ...prev, [mint]: '' }))
    try {
      const res = await api.post<{ success: boolean; error?: string }>('/token/sell', {
        mint, percentage, walletPrivateKey, feeLevel,
      })
      if (!res.success) setSellError(prev => ({ ...prev, [mint]: res.error || 'Erro' }))
    } catch (err: unknown) {
      setSellError(prev => ({ ...prev, [mint]: err instanceof Error ? err.message : 'Erro' }))
    } finally {
      setSelling(prev => ({ ...prev, [key]: false }))
    }
  }

  // Vende TODAS as wallets de uma posicao ao mesmo tempo
  async function sellAll(pos: Position, percentage: number) {
    const key = `${pos.mint}-ALL`
    setSelling(prev => ({ ...prev, [key]: true }))
    setSellError(prev => ({ ...prev, [pos.mint]: '' }))

    // Snapshot do preco no momento do clique (antes do await)
    let priceSnapshot = prices[pos.mint] || 0

    try {
      // Monta lista de bundle wallets com keys disponiveis
      const bundleWalletsList = pos.bundleWallets
        .map(bw => {
          const pk = bw.privateKeyBase58 || unlockedKeys[bw.publicKey]
          return pk ? { privateKeyBase58: pk, label: bw.label } : null
        })
        .filter(Boolean) as Array<{ privateKeyBase58: string; label: string }>

      const res = await api.post<{
        success: boolean
        bundleId?: string
        results?: Array<{ label: string; success: boolean; error?: string }>
        error?: string
        canRetrySequential?: boolean
      }>('/token/sell-all', {
        mint: pos.mint,
        percentage,
        // Se dev usa fresh wallet, inclui ela na lista; senao usa sessao (includeDevWallet)
        wallets: [
          ...(pos.devWalletPrivateKey
            ? [{ privateKeyBase58: pos.devWalletPrivateKey, label: 'Dev wallet' }]
            : []),
          ...bundleWalletsList,
        ],
        includeDevWallet: !pos.devWalletPrivateKey,
        feeLevel,
        useJito,
      })

      if (!res.success && res.canRetrySequential) {
        setSellError(prev => ({
          ...prev,
          [pos.mint]: `Jito falhou. Tente desativar Jito e vender novamente.`,
        }))
        return
      }

      // Verifica se pelo menos uma venda teve sucesso antes de remover a posicao
      // No modo sequencial, res.success=true mesmo se vendas individuais falharam
      const anySuccess = res.bundleId != null ||
        (res.results != null && res.results.some(r => r.success))
      if (!anySuccess) {
        const firstErr = res.results?.find(r => !r.success)?.error || res.error || 'Venda falhou'
        setSellError(prev => ({ ...prev, [pos.mint]: firstErr }))
        return
      }

      if (percentage === 100) {
        // Se nao tinhamos preco no snapshot, tenta buscar do backend agora
        if (priceSnapshot === 0) {
          try {
            const info = await api.get<{ price: number }>(`/token/${pos.mint}/info`)
            priceSnapshot = info.price || 0
          } catch { /* continua com 0 */ }
        }

        const totalTokens =
          (Number(BigInt(pos.devTokenAmount || '0')) / 1e6) +
          pos.bundleWallets.reduce((s, bw) => s + (Number(BigInt(bw.tokenAmount || '0')) / 1e6), 0)

        const invested = pos.totalSolSpent
        // SOL recebido estimado: tokens vendidos * preco no momento da venda
        // (preco de bonding curve, nao spot — melhor estimativa disponivel sem query de tx)
        const received = priceSnapshot > 0 ? totalTokens * priceSnapshot : 0

        addToHistory({
          mint: pos.mint,
          name: pos.name,
          symbol: pos.symbol,
          openedAt: pos.openedAt,
          closedAt: Date.now(),
          totalSolInvested: invested,
          totalSolReceived: received,
          pnlSol: received - invested,
          pnlPct: invested > 0 ? ((received - invested) / invested) * 100 : 0,
          devWalletPrivateKey: pos.devWalletPrivateKey,
          wallets: [
            { label: 'Dev wallet', solInvested: pos.devBuySol, solReceived: 0 },
            ...pos.bundleWallets.map(bw => ({
              label: bw.label, solInvested: bw.buySol, solReceived: 0
            })),
          ],
        })
        removePosition(pos.mint)
        setPositions(loadPositions())
        setHistory(loadHistory())
        await api.post('/monitor/stop', { mint: pos.mint }).catch(() => {})
      }
    } catch (err: unknown) {
      setSellError(prev => ({
        ...prev, [pos.mint]: err instanceof Error ? err.message : 'Erro'
      }))
    } finally {
      setSelling(prev => ({ ...prev, [key]: false }))
    }
  }

  async function recoverPosition() {
    setRecoverError('')
    const mint = recoverForm.mint.trim()
    if (!mint) { setRecoverError('Mint obrigatorio'); return }

    setRecoverLoading(true)
    try {
      // Tenta buscar nome/symbol automaticamente
      let name = recoverForm.name.trim()
      let symbol = recoverForm.symbol.trim()
      if (!name || !symbol) {
        try {
          const meta = await api.get<{ name: string; symbol: string }>(`/token/${mint}/metadata`)
          name = name || meta.name || mint.slice(0, 6)
          symbol = symbol || meta.symbol || '???'
        } catch {
          name = name || mint.slice(0, 6)
          symbol = symbol || '???'
        }
      }

      // Monta bundle wallets a partir das private keys digitadas
      const bundleWallets: Position['bundleWallets'] = []
      const lines = recoverForm.bundleKeys.split('\n').map(l => l.trim()).filter(Boolean)
      for (let i = 0; i < lines.length; i++) {
        bundleWallets.push({
          publicKey: '',  // sera preenchido pelo backend ao vender
          privateKeyBase58: lines[i],
          label: `Bundle ${i + 1}`,
          buySol: 0,
          tokenAmount: '0',
          buyPriceSol: 0,
        })
      }

      const pos: Position = {
        mint,
        name,
        symbol,
        openedAt: Date.now(),
        devBuySol: parseFloat(recoverForm.devBuySol) || 0,
        devTokenAmount: '0',
        devBuyPriceSol: 0,
        devWalletPrivateKey: recoverForm.devWalletPrivateKey.trim() || undefined,
        bundleWallets,
        totalSolSpent: parseFloat(recoverForm.devBuySol) || 0,
      }

      savePosition(pos)
      setPositions(loadPositions())
      setShowRecover(false)
      setRecoverForm({ mint: '', name: '', symbol: '', devBuySol: '0', devWalletPrivateKey: '', bundleKeys: '' })
      // Inicia monitor
      api.post('/monitor/start', { mint }).catch(() => {})
    } catch (err: unknown) {
      setRecoverError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setRecoverLoading(false)
    }
  }

  function closePosition(pos: Position) {
    removePosition(pos.mint)
    setPositions(loadPositions())
    api.post('/monitor/stop', { mint: pos.mint }).catch(() => {})
  }

  // Calcula PNL total de uma posicao
  function totalPNL(pos: Position, price: number) {
    const allTokens = [
      { amount: pos.devTokenAmount, buyPrice: pos.devBuyPriceSol, invested: pos.devBuySol },
      ...pos.bundleWallets.map(bw => ({
        amount: bw.tokenAmount, buyPrice: bw.buyPriceSol, invested: bw.buySol
      })),
    ]
    const totalInvested = allTokens.reduce((s, t) => s + t.invested, 0)
    const totalCurrent = allTokens.reduce((s, t) => {
      if (t.amount === '0' || t.amount === '') return s
      return s + (Number(BigInt(t.amount)) / 1e6) * price
    }, 0)
    const pnlSol = totalCurrent - totalInvested
    const pnlPct = totalInvested > 0 ? (pnlSol / totalInvested) * 100 : 0
    return { pnlSol, pnlPct, totalInvested, totalCurrent }
  }

  // --- RENDER ---

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
      tab === t ? 'border-brand text-brand' : 'border-transparent text-gray-400 hover:text-white'
    }`

  if (positions.length === 0 && tab === 'positions') {
    return (
      <div className="space-y-4">
        <div className="flex border-b border-surface-600">
          <button className={tabClass('positions')} onClick={() => setTab('positions')}>Posicoes abertas</button>
          <button className={tabClass('history')} onClick={() => setTab('history')}>
            Historico {history.length > 0 && <span className="ml-1 badge-green">{history.length}</span>}
          </button>
        </div>
        {tab === 'positions' && (
          <div className="card text-center py-16 text-gray-400 text-sm">
            Nenhuma posicao aberta.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex items-center justify-between border-b border-surface-600">
        <div className="flex">
          <button className={tabClass('positions')} onClick={() => setTab('positions')}>
            Posicoes {positions.length > 0 && <span className="ml-1 text-xs text-gray-500">({positions.length})</span>}
          </button>
          <button className={tabClass('history')} onClick={() => setTab('history')}>
            Historico {history.length > 0 && <span className="ml-1 badge-green">{history.length}</span>}
          </button>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <button onClick={() => setShowRecover(v => !v)} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            recuperar
          </button>
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-400">
            <input type="checkbox" checked={useJito} onChange={e => setUseJito(e.target.checked)} className="accent-brand" />
            Jito
          </label>
        </div>
      </div>

      {/* Modal recuperar posicao */}
      {showRecover && (
        <div className="card border-warning/30 bg-surface-800 space-y-3">
          <p className="text-sm font-semibold text-warning">Recuperar posicao</p>
          <p className="text-xs text-gray-400">Use quando o token foi deployado mas nao apareceu no monitor.</p>
          <div>
            <label className="label">Mint address</label>
            <input
              value={recoverForm.mint}
              onChange={e => setRecoverForm(p => ({ ...p, mint: e.target.value }))}
              className="w-full font-mono text-xs"
              placeholder="Endereco do token (mint)"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Nome (opcional — busca automatico)</label>
              <input value={recoverForm.name} onChange={e => setRecoverForm(p => ({ ...p, name: e.target.value }))} className="w-full" placeholder="Ex: MyCoin" />
            </div>
            <div>
              <label className="label">Symbol</label>
              <input value={recoverForm.symbol} onChange={e => setRecoverForm(p => ({ ...p, symbol: e.target.value }))} className="w-full" placeholder="Ex: MYC" />
            </div>
          </div>
          <div>
            <label className="label">SOL gasto no dev buy</label>
            <input value={recoverForm.devBuySol} onChange={e => setRecoverForm(p => ({ ...p, devBuySol: e.target.value }))} className="w-full" placeholder="0" type="number" step="0.01" />
          </div>
          <div>
            <label className="label">Private key da dev wallet (se usou fresh wallet)</label>
            <input
              value={recoverForm.devWalletPrivateKey}
              onChange={e => setRecoverForm(p => ({ ...p, devWalletPrivateKey: e.target.value }))}
              className="w-full font-mono text-xs"
              placeholder="Deixe vazio se usou a wallet principal"
              type="password"
            />
          </div>
          <div>
            <label className="label">Private keys das bundle wallets (uma por linha)</label>
            <textarea
              value={recoverForm.bundleKeys}
              onChange={e => setRecoverForm(p => ({ ...p, bundleKeys: e.target.value }))}
              className="w-full font-mono text-xs h-24 bg-surface-700 border border-surface-600 rounded p-2"
              placeholder={"5Jxxx...\n4Kyyy...\n(uma por linha, deixe vazio se nao tem)"}
            />
          </div>
          {recoverError && <p className="text-danger text-xs">{recoverError}</p>}
          <div className="flex gap-2">
            <button onClick={recoverPosition} disabled={recoverLoading} className="btn-primary flex-1">
              {recoverLoading ? 'recuperando...' : 'recuperar posicao'}
            </button>
            <button onClick={() => setShowRecover(false)} className="btn-ghost px-4">cancelar</button>
          </div>
        </div>
      )}

      {/* POSICOES */}
      {tab === 'positions' && positions.map(pos => {
        const price = prices[pos.mint]
        const hasPNL = price != null && price > 0
        const pnl = hasPNL ? totalPNL(pos, price) : null
        const isSellingAll = selling[`${pos.mint}-ALL`]

        return (
          <div key={pos.mint} className="card space-y-4">
            {/* Token header */}
            <div className="flex items-start justify-between">
              <div>
                <span className="font-bold text-lg">{pos.name}</span>
                <span className="text-gray-400 ml-2">{pos.symbol}</span>
                <p className="text-xs text-gray-500 font-mono mt-0.5">
                  {pos.mint.slice(0, 8)}...{pos.mint.slice(-8)}
                </p>
              </div>
              <div className="text-right text-xs text-gray-500">
                {new Date(pos.openedAt).toLocaleTimeString('pt-BR')}
                <br />
                <a href={`https://pump.fun/coin/${pos.mint}`} target="_blank" rel="noopener noreferrer"
                  className="text-brand hover:underline">pump.fun</a>
              </div>
            </div>

            {/* Claim Fees — aparece so quando ha saldo no creator_vault */}
            {vaultBalances[pos.mint] > 0 && (
              <div className="flex items-center gap-3 bg-brand-dark/30 border border-brand/20 rounded-lg px-3 py-2">
                <div className="flex-1 text-xs text-gray-300">
                  <span className="text-brand font-semibold">Fees disponiveis:</span>{' '}
                  <span className="font-mono">{vaultBalances[pos.mint].toFixed(5)} SOL</span>
                </div>
                <button
                  onClick={() => claimFees(pos)}
                  disabled={claimingFees[pos.mint]}
                  className="btn-primary text-xs px-3 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {claimingFees[pos.mint] ? 'Enviando...' : 'Claim Fees'}
                </button>
              </div>
            )}
            {claimMsg[pos.mint] && (
              <p className={`text-xs ${claimMsg[pos.mint] === 'Fees recebidas!' ? 'text-brand' : 'text-danger'}`}>
                {claimMsg[pos.mint]}
              </p>
            )}

            {/* PNL GRANDE */}
            {pnl && (
              <div className={`rounded-xl p-4 text-center border ${
                pnl.pnlPct >= 0
                  ? 'bg-brand-dark/40 border-brand/30'
                  : 'bg-red-900/20 border-danger/30'
              }`}>
                <div className={`text-5xl font-black font-mono tracking-tight ${
                  pnl.pnlPct >= 0 ? 'text-brand' : 'text-danger'
                }`}>
                  {pnl.pnlPct >= 0 ? '+' : ''}{pnl.pnlPct.toFixed(1)}%
                </div>
                <div className={`text-lg font-bold font-mono mt-1 ${
                  pnl.pnlPct >= 0 ? 'text-brand/80' : 'text-danger/80'
                }`}>
                  {pnl.pnlSol >= 0 ? '+' : ''}{pnl.pnlSol.toFixed(4)} SOL
                </div>
                <div className="flex justify-center gap-6 mt-3 text-xs text-gray-400">
                  <div>
                    <span className="block text-gray-500">investido</span>
                    <span className="text-white font-mono">{pnl.totalInvested.toFixed(4)} SOL</span>
                  </div>
                  <div>
                    <span className="block text-gray-500">valor atual</span>
                    <span className="text-white font-mono">{pnl.totalCurrent.toFixed(4)} SOL</span>
                  </div>
                  <div>
                    <span className="block text-gray-500">preco</span>
                    <span className="text-white font-mono">{price.toExponential(3)}</span>
                  </div>
                </div>
              </div>
            )}

            {!hasPNL && (
              <div className="rounded-xl p-4 text-center border border-surface-600 bg-surface-700">
                <p className="text-gray-500 text-sm animate-pulse">aguardando preco...</p>
              </div>
            )}

            {/* Vender tudo de uma vez */}
            <div className="border border-surface-600 rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-gray-300">Vender TODAS as wallets</p>
              <SellSlider
                loading={isSellingAll}
                onSell={(pct) => sellAll(pos, pct)}
              />
            </div>

            {/* Dev wallet */}
            <div className="border border-surface-600 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-semibold text-gray-300">Dev wallet</p>
                  {pos.devWalletPublicKey && (
                    <span className="text-xs text-gray-600 font-mono">
                      {pos.devWalletPublicKey.slice(0, 6)}...{pos.devWalletPublicKey.slice(-4)}
                    </span>
                  )}
                  {/* Botao de key da fresh wallet */}
                  {pos.devWalletPrivateKey && (
                    <button
                      onClick={() => setShowBwKey(prev => ({ ...prev, [`dev-${pos.mint}`]: !prev[`dev-${pos.mint}`] }))}
                      className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
                        showBwKey[`dev-${pos.mint}`]
                          ? 'bg-warning/20 text-warning border border-warning/30'
                          : 'text-gray-600 hover:text-gray-300 hover:bg-surface-600'
                      }`}
                      title="Mostrar private key da dev wallet"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>
                      </svg>
                      key
                    </button>
                  )}
                </div>
                {hasPNL && pos.devTokenAmount !== '0' && (
                  <span className={`text-xs font-mono font-bold ${
                    calcPNL(pos.devTokenAmount, pos.devBuyPriceSol, price!).pnlPct >= 0
                      ? 'text-brand' : 'text-danger'
                  }`}>
                    {calcPNL(pos.devTokenAmount, pos.devBuyPriceSol, price!).pnlPct >= 0 ? '+' : ''}
                    {calcPNL(pos.devTokenAmount, pos.devBuyPriceSol, price!).pnlPct.toFixed(1)}%
                  </span>
                )}
              </div>

              {/* Key expandida da dev fresh wallet */}
              {showBwKey[`dev-${pos.mint}`] && pos.devWalletPrivateKey && (
                <div className="bg-surface-900 border border-warning/20 rounded p-2 space-y-1">
                  <p className="text-warning text-xs font-semibold">Private Key da Dev Wallet</p>
                  <p className="text-xs font-mono break-all text-gray-300 select-all">{pos.devWalletPrivateKey}</p>
                  <button
                    onClick={() => copyKey(`dev-${pos.mint}`, pos.devWalletPrivateKey!)}
                    className="text-xs text-brand hover:opacity-70 transition-opacity"
                  >
                    {copiedKey[`dev-${pos.mint}`] ? 'copiado!' : 'copiar'}
                  </button>
                </div>
              )}

              <SellSlider
                compact
                loading={!!selling[`${pos.mint}-dev`]}
                onSell={(pct) => sellWallet(pos.mint, pct, pos.devWalletPrivateKey)}
              />
            </div>

            {/* Bundle wallets */}
            {pos.bundleWallets.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-300">Bundle wallets</p>
                {pos.bundleWallets.map(bw => {
                  const bwKey = `${pos.mint}-${bw.publicKey.slice(0, 6)}`
                  const bwPk = bw.privateKeyBase58 || unlockedKeys[bw.publicKey]
                  const bwPnl = hasPNL && bw.tokenAmount !== '0'
                    ? calcPNL(bw.tokenAmount, bw.buyPriceSol, price!)
                    : null

                  return (
                    <div key={bw.publicKey} className="border border-surface-600 rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold">{bw.label}</span>
                          {/* Botao de chave — mostra PK se disponivel */}
                          {bwPk && (
                            <button
                              onClick={() => setShowBwKey(prev => ({ ...prev, [bw.publicKey]: !prev[bw.publicKey] }))}
                              className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors
                                ${showBwKey[bw.publicKey]
                                  ? 'bg-warning/20 text-warning border border-warning/30'
                                  : 'text-gray-600 hover:text-gray-300 hover:bg-surface-600'}`}
                              title="Mostrar private key"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>
                              </svg>
                              key
                            </button>
                          )}
                        </div>
                        {bwPnl && (
                          <span className={`text-xs font-mono font-bold ${bwPnl.pnlPct >= 0 ? 'text-brand' : 'text-danger'}`}>
                            {bwPnl.pnlPct >= 0 ? '+' : ''}{bwPnl.pnlPct.toFixed(1)}%
                          </span>
                        )}
                      </div>

                      {/* Key expandida */}
                      {showBwKey[bw.publicKey] && bwPk && (
                        <div className="bg-surface-900 border border-warning/20 rounded p-2 space-y-1">
                          <p className="text-warning text-xs font-semibold">Private Key</p>
                          <p className="text-xs font-mono break-all text-gray-300 select-all">{bwPk}</p>
                          <button
                            onClick={() => copyKey(bw.publicKey, bwPk)}
                            className="text-xs text-brand hover:opacity-70 transition-opacity"
                          >
                            {copiedKey[bw.publicKey] ? 'copiado!' : 'copiar'}
                          </button>
                        </div>
                      )}

                      {bwPk ? (
                        <SellSlider
                          compact
                          loading={!!selling[bwKey]}
                          onSell={(pct) => sellWallet(pos.mint, pct, bwPk)}
                        />
                      ) : (
                        <p className="text-gray-500 text-xs">
                          Chave nao disponivel nesta sessao.{' '}
                          <span className="text-gray-600">Reabra o deploy para recuperar.</span>
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {sellError[pos.mint] && (
              <p className="text-danger text-xs">{sellError[pos.mint]}</p>
            )}

            <button
              onClick={() => closePosition(pos)}
              className="text-gray-600 text-xs hover:text-gray-400 transition-colors"
            >
              fechar posicao (sem vender)
            </button>
          </div>
        )
      })}

      {/* HISTORICO */}
      {tab === 'history' && (
        <div className="space-y-3">
          {history.length === 0 && (
            <div className="card text-center py-16 text-gray-400 text-sm">
              Nenhuma operacao encerrada ainda.
            </div>
          )}

          {/* Resumo geral */}
          {history.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold">Resumo ({history.length} operacoes)</p>
                <button onClick={() => { clearHistory(); setHistory([]) }} className="text-xs text-gray-500 hover:text-danger transition-colors">
                  limpar
                </button>
              </div>
              <div className="grid grid-cols-3 gap-4 text-center">
                {(() => {
                  const totalInvested = history.reduce((s, h) => s + h.totalSolInvested, 0)
                  const totalReceived = history.reduce((s, h) => s + h.totalSolReceived, 0)
                  const totalPnl = totalReceived - totalInvested
                  const wins = history.filter(h => h.pnlPct > 0).length
                  return (
                    <>
                      <div>
                        <p className="label">Total PNL</p>
                        <p className={`text-xl font-black font-mono ${totalPnl >= 0 ? 'text-brand' : 'text-danger'}`}>
                          {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(3)} SOL
                        </p>
                      </div>
                      <div>
                        <p className="label">Win rate</p>
                        <p className="text-xl font-black font-mono text-white">
                          {history.length > 0 ? Math.round((wins / history.length) * 100) : 0}%
                        </p>
                      </div>
                      <div>
                        <p className="label">Investido</p>
                        <p className="text-xl font-black font-mono text-white">
                          {totalInvested.toFixed(3)} SOL
                        </p>
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>
          )}

          {/* Lista de trades */}
          {history.map(trade => (
            <div key={trade.id} className="card">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-semibold">{trade.name}</span>
                  <span className="text-gray-400 ml-2 text-sm">{trade.symbol}</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {new Date(trade.openedAt).toLocaleDateString('pt-BR')} •{' '}
                    {new Date(trade.closedAt).toLocaleTimeString('pt-BR')}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-2xl font-black font-mono ${trade.pnlPct >= 0 ? 'text-brand' : 'text-danger'}`}>
                    {trade.pnlPct >= 0 ? '+' : ''}{trade.pnlPct.toFixed(1)}%
                  </p>
                  <p className={`text-sm font-mono ${trade.pnlPct >= 0 ? 'text-brand/70' : 'text-danger/70'}`}>
                    {trade.pnlSol >= 0 ? '+' : ''}{trade.pnlSol.toFixed(4)} SOL
                  </p>
                </div>
              </div>
              <div className="flex gap-4 mt-2 text-xs text-gray-500">
                <span>investido: <span className="text-gray-300">{trade.totalSolInvested.toFixed(4)} SOL</span></span>
                <span>recebido: <span className="text-gray-300">{trade.totalSolReceived.toFixed(4)} SOL</span></span>
                <a
                  href={`https://pump.fun/coin/${trade.mint}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline ml-auto"
                >
                  pump.fun
                </a>
              </div>
              {/* Claim fees pos-fechamento */}
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => claimFees({ mint: trade.mint, devWalletPrivateKey: trade.devWalletPrivateKey } as any)}
                  disabled={claimingFees[trade.mint]}
                  className="px-3 py-1 text-xs rounded border border-brand/30 text-brand hover:bg-brand/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {claimingFees[trade.mint] ? 'enviando...' : 'claim fees'}
                </button>
                {claimMsg[trade.mint] && (
                  <span className={`text-xs ${claimMsg[trade.mint] === 'Fees recebidas!' ? 'text-brand' : 'text-danger'}`}>
                    {claimMsg[trade.mint]}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
