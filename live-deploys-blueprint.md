# Live Deploys — Blueprint / PRD Fase 2

## Objetivo
Criar uma nova aba chamada **Live Deploys** para monitorar tweets/posts do X em tempo quase real e transformar cada sinal em um **draft de deploy** pronto para revisão e lançamento com poucos cliques.

A meta da fase 2 **não** é fazer auto deploy cego. A meta é reduzir o fluxo para:

**detectar narrativa → enriquecer → revisar → deploy**

---

## Resultado esperado
Quando um post interessante aparecer no feed monitorado, o sistema deve:

1. ingerir o post
2. salvar metadados e mídia
3. sugerir automaticamente:
   - nome
   - ticker
   - descrição curta
   - link do X
   - imagem do token
4. se o post não tiver imagem, gerar um screenshot/render do post
5. criar um draft compatível com o pipeline atual de deploy
6. permitir **deploy com aprovação manual**

---

## Escopo da fase 2

### Dentro do escopo
- aba nova “Live Deploys”
- monitoramento de contas/listas/regras
- feed de sinais em tempo real
- score simples de oportunidade
- extração automática de nome/ticker/contexto
- captura de imagem original ou screenshot fallback
- criação de draft integrado ao deploy atual
- botão de deploy com confirmação manual
- histórico e status dos sinais

### Fora do escopo nesta fase
- auto deploy 100% sem revisão
- geração automática de website/telegram
- estratégia complexa de bundle/autobuy por sinal
- deduplicação semântica pesada com múltiplos modelos
- engine avançada de ranking baseada em performance histórica

---

## Princípios do produto
- **Poucos cliques**: operador deve decidir muito rápido
- **Reaproveitar o pipeline atual**: não duplicar lógica de deploy
- **Arquitetura preparada para automação futura**
- **Baixa fricção**: tudo pré-preenchido
- **Alta legibilidade visual**: feed rápido e painel de revisão claro

---

## UX recomendada

### Estrutura da tela

#### 1. Coluna esquerda — Feed de sinais
Lista de posts monitorados com:
- avatar
- @handle
- tempo do post
- preview do texto
- miniatura da mídia
- score
- badges (`image`, `text-only`, `fresh`, `watched`, `high-score`)
- status (`novo`, `pronto`, `usado`, `ignorado`, `falhou`)

#### 2. Coluna central — Painel de análise
Ao clicar em um sinal:
- preview maior do post
- imagem original ou screenshot
- nome sugerido
- 3 tickers sugeridos
- descrição curta sugerida
- confiança/score
- origem do asset (`original media` / `rendered screenshot`)

#### 3. Coluna direita — Ação
- botão **Criar Draft**
- botão **Abrir no Deploy**
- botão **Deploy Agora**
- botão **Ignorar**
- botão **Favoritar Conta**
- checkbox **confirmar antes de enviar**

---

## Fluxo funcional

### Fluxo 1 — ingestão
1. worker recebe posts novos via stream/polling
2. normaliza payload
3. salva no banco
4. calcula score inicial
5. emite evento realtime para UI

### Fluxo 2 — enriquecimento
1. sistema detecta se há mídia
2. se houver mídia: baixa e salva asset
3. se não houver mídia: gera screenshot/render do post
4. chama extractor para sugerir nome/ticker/descrição
5. salva draft candidate

### Fluxo 3 — revisão
1. operador abre o card
2. ajusta nome/ticker se quiser
3. escolhe asset final
4. cria draft ou envia deploy

### Fluxo 4 — deploy
1. draft é convertido para o mesmo formato já usado no formulário atual
2. pipeline atual de deploy é reutilizado
3. resultado é persistido e o card muda de status

---

## Estados do card
Cada sinal deve ter estado persistido:
- `new`
- `processing`
- `ready`
- `reviewed`
- `deployed`
- `failed`
- `ignored`

Opcionalmente incluir também:
- `duplicate`
- `blocked`

---

## Score de oportunidade
Implementar score simples de 0–100.

### Fatores positivos
- conta está em watchlist
- post é recente
- contém imagem forte/meme visual
- texto curto e marcante
- presença de palavra com cara de marca/ticker
- tema quente
- bom engajamento inicial

### Fatores negativos
- texto muito longo
- contexto confuso
- símbolo/ticker ruim
- ativo duplicado localmente
- baixa clareza de narrativa
- post irrelevante para deploy

### Saída
- nota numérica 0–100
- label visual: `low`, `medium`, `high`

---

## Regras de extração

### Nome sugerido
Ordem de prioridade:
1. frase central do post
2. entidade/meme principal
3. slogan curto e brandável
4. nome do autor apenas se fizer sentido narrativo

### Ticker sugerido
Gerar 3 opções:
- conservadora
- memética
- agressiva

#### Regras
- ideal entre 3 e 6 caracteres
- remover stopwords e lixo visual
- evitar colisão com tickers locais já usados
- priorizar sonoridade e memorabilidade
- normalizar para A–Z quando necessário

### Descrição sugerida
- 1 linha
- ligada ao post
- sem texto longo
- estilo rápido para launch

---

## Imagem / mídia

### Prioridade de asset
1. mídia original do post
2. imagem destacada do link, se existir e for boa
3. screenshot/render do post em layout padronizado

### Regras de screenshot
- layout consistente
- proporção padrão (1:1 ou 4:5)
- fundo limpo
- cabeçalho com avatar + handle + texto
- foco em legibilidade
- compressão razoável para upload rápido

---

## Integração com o deploy atual
O módulo de Live Deploys **não deve duplicar** a lógica do formulário principal.

Deve apenas:
- criar um objeto/draft no formato já aceito pela aba de deploy
- abrir o form pré-preenchido
- ou chamar a mesma action/server action/API route já existente

Campos mínimos do draft:
- `name`
- `ticker`
- `description`
- `twitterUrl`
- `websiteUrl` (opcional)
- `telegramUrl` (opcional)
- `imageAssetUrl`
- `sourcePostUrl`
- `sourceAuthorHandle`
- `sourcePostId`
- `signalScore`

---

## Banco de dados sugerido

### Tabelas principais

#### `tracked_sources`
- id
- source_type (`account`, `list`, `rule`)
- source_value
- is_active
- priority
- created_at

#### `source_posts`
- id
- external_post_id
- author_handle
- author_name
- post_url
- text_raw
- posted_at
- metrics_json
- raw_payload_json
- has_media
- ingestion_status
- created_at

#### `post_assets`
- id
- source_post_id
- asset_type (`original_media`, `screenshot`, `link_image`)
- storage_path
- mime_type
- width
- height
- created_at

#### `signal_analysis`
- id
- source_post_id
- score
- score_label
- extracted_name
- extracted_ticker_primary
- extracted_ticker_alt_1
- extracted_ticker_alt_2
- short_description
- confidence
- analysis_json
- created_at

#### `launch_drafts`
- id
- source_post_id
- name
- ticker
- description
- twitter_url
- image_asset_id
- status
- created_at
- updated_at

#### `deploy_runs`
- id
- launch_draft_id
- deploy_status
- tx_hash (nullable)
- error_message (nullable)
- created_at

---

## Filtros recomendados
- watched only
- high score
- com imagem
- text-only
- não usados
- já deployados
- por handle
- por palavra-chave
- por janela de tempo

Ordenação:
- mais recente
- score maior
- engajamento maior
- prioridade da watchlist

---

## Ferramentas / stack recomendada (atual)

### 1. Fonte de dados do X

#### Opção A — Oficial: X API
Usar quando o objetivo for robustez, previsibilidade e regras claras.

**Por que considerar**
- documentação oficial
- stream e busca suportados
- melhor para contas/regras bem definidas
- caminho mais limpo para produto sério

**Uso recomendado neste projeto**
- monitorar watchlists e regras específicas
- ingestão base da aba Live Deploys

#### Opção B — Pragmática: Apify Twitter/X Scraper
Usar como fallback/expansão quando precisar de coleta mais flexível.

**Por que considerar**
- rápido de integrar
- bom para scraping de timelines, buscas e perfis
- útil quando você quer experimentar rápido sem depender de toda a ergonomia do provider oficial

**Uso recomendado neste projeto**
- fallback para ingestão
- enriquecimento pontual
- coleta experimental enquanto valida produto

**Recomendação prática**
- arquitetura com provider abstrato `SocialSourceProvider`
- provider 1: `XOfficialProvider`
- provider 2: `ApifyXProvider`
- a UI e o pipeline não devem depender do provider

---

### 2. Screenshot / render de post

#### Melhor opção prática: Browserless + Playwright

**Por que considerar**
- API pronta para screenshot
- também aceita automação browser real
- ótimo para gerar assets padronizados
- útil tanto para renderização quanto para futura coleta visual

**Uso recomendado neste projeto**
- screenshot fallback de posts text-only
- geração de miniaturas padronizadas para o feed
- eventual recorte controlado de elementos

**Alternativa**
- rodar Playwright self-hosted no próprio backend, se quiser economizar vendor

---

### 3. Banco, storage e realtime

#### Melhor equilíbrio de velocidade: Supabase

**Por que considerar**
- Postgres + Storage + Realtime no mesmo stack
- ótimo para dashboard em tempo real
- fácil de manter MVP e crescer depois
- reduz tempo de infraestrutura

**Uso recomendado neste projeto**
- tabelas de sinais/drafts/deploys
- storage dos screenshots/imagens
- atualização realtime do feed de sinais

---

### 4. Extração de nome/ticker/contexto

#### Melhor opção atual para confiabilidade: OpenAI Responses API com Structured Outputs

**Por que considerar**
- extrai JSON validado por schema
- reduz erro de parse
- ótimo para gerar:
  - nome sugerido
  - 3 tickers
  - descrição
  - score textual explicável
  - flags como `needs_review`

**Uso recomendado neste projeto**
- análise do texto do post
- visão em imagem quando necessário
- retorno em JSON estrito

**Observação de arquitetura**
Crie um serviço `SignalExtractionService` que recebe:
- texto do post
- handle
- metadados
- opcionalmente imagem/screenshot

E retorna um schema fixo como:
- `suggested_name`
- `tickers[]`
- `short_description`
- `image_strategy`
- `confidence`
- `reasoning_summary`

---

### 5. Fila / jobs / retries

#### Recomendação
- simples e robusto: filas locais com BullMQ + Redis
- serverless/prático: Upstash Redis ou QStash

**Uso recomendado neste projeto**
Separar jobs de:
- ingestão
- download de mídia
- screenshot
- extração IA
- criação do draft
- deploy

Isso evita travar request HTTP em operações longas.

---

## Arquitetura sugerida

### Componentes
- `SocialSourceProvider` (X oficial / Apify)
- `IngestionWorker`
- `SignalScoringService`
- `AssetService`
- `ScreenshotService`
- `SignalExtractionService`
- `DraftService`
- `DeployGateway`
- `LiveFeedRealtime`

### Regra importante
A aba Live Deploys deve conversar com o pipeline de deploy por meio de uma interface estável, por exemplo:
- `createDraftFromSignal(signalId)`
- `deployDraft(draftId, options)`

---

## Contratos de API sugeridos

### `POST /api/live-deploys/sources`
Criar/editar fonte monitorada.

### `GET /api/live-deploys/signals`
Listar sinais com filtros.

### `GET /api/live-deploys/signals/:id`
Detalhes do sinal.

### `POST /api/live-deploys/signals/:id/analyze`
Rodar ou rerodar enriquecimento.

### `POST /api/live-deploys/signals/:id/create-draft`
Criar draft a partir do sinal.

### `POST /api/live-deploys/drafts/:id/deploy`
Enviar deploy usando pipeline atual.

### `POST /api/live-deploys/signals/:id/ignore`
Ignorar sinal.

---

## Segurança e controle
- confirmação manual obrigatória nesta fase
- log completo de quem clicou e quando
- prevenção de duplo deploy no mesmo sinal
- dedupe básico por `source_post_id`
- rate limiting para ações críticas
- feature flag para modo futuro semi-auto/auto

---

## Métricas de sucesso
- tempo médio entre post detectado e draft pronto
- tempo médio entre draft pronto e deploy
- taxa de sinais ignorados
- taxa de falha por etapa
- taxa de uso do screenshot fallback
- taxa de conversão de sinal → draft → deploy

---

## Roadmap recomendado

### Fase 2A — base funcional
- watchlist
- ingestão
- feed realtime
- análise simples
- draft manual

### Fase 2B — produtividade
- screenshot fallback
- múltiplos tickers
- filtros bons
- deploy com confirmação rápida

### Fase 2C — automação parcial
- regras por conta
- score melhor
- auto draft
- auto queue com revisão humana

### Fase 3 — automação avançada
- auto deploy condicionado por regras
- blacklist/whitelist
- heurísticas por performance histórica
- módulos de risco e limites

---

## Decisões que precisam ser definidas antes de implementar
1. vai monitorar contas específicas, listas, busca por keywords, ou tudo isso?
2. o feed deve priorizar qualidade ou volume?
3. o deploy será sempre revisado no painel ou pode existir “1-click deploy” com confirmação?
4. qual proporção padrão do asset gerado?
5. quais campos do deploy atual são obrigatórios para o draft automático?
6. haverá bloqueio por conta, por palavra ou por tema?

---

## Pedido resumido para o dev

Implementar uma aba chamada **Live Deploys** que monitora posts do X em tempo quase real e transforma cada post em um **draft de deploy** com poucos cliques. O sistema deve ingerir posts de fontes monitoradas, salvar metadados, calcular score inicial, capturar mídia original ou gerar screenshot quando não houver imagem, extrair nome/ticker/descrição automaticamente, criar um draft compatível com o pipeline atual de deploy e permitir lançamento com aprovação manual. A arquitetura deve ser preparada para futura automação, mas nesta fase a revisão humana continua obrigatória.

---

## Minha recomendação final
Para esta fase, o melhor equilíbrio é:

- **X API oficial** como fonte principal
- **Apify** como fallback/expansão rápida
- **Browserless + Playwright** para screenshot/render
- **Supabase** para banco + storage + realtime
- **OpenAI Responses API com Structured Outputs** para extração confiável
- **BullMQ + Redis** ou **Upstash/QStash** para filas

Isso te dá uma base sólida, rápida de implementar e preparada para evoluir para semi-auto e depois auto.

---

## Referências úteis
- X API docs: https://docs.x.com/
- X filtered stream: https://docs.x.com/x-api/posts/filtered-stream/introduction
- Apify Twitter/X scraper: https://apify.com/scrapers/twitter
- Browserless screenshot API: https://docs.browserless.io/rest-apis/screenshot-api
- Supabase Realtime: https://supabase.com/docs/guides/realtime
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs/
- OpenAI Responses API: https://developers.openai.com/api/docs/guides/migrate-to-responses/
- Upstash QStash: https://upstash.com/docs/qstash/overall/getstarted
