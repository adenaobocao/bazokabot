-- =============================================================
-- Live Deploys — Supabase Schema
-- Rodar no SQL Editor do Supabase: https://app.supabase.com
-- =============================================================

-- Fontes monitoradas (contas do X)
CREATE TABLE tracked_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     TEXT NOT NULL DEFAULT 'account', -- 'account' | 'list' | 'rule'
  source_value    TEXT NOT NULL,                   -- @handle sem o @
  x_user_id       TEXT,                            -- preenchido automaticamente
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  priority        INT NOT NULL DEFAULT 5,
  last_tweet_id   TEXT,                            -- last_tweet_id para paginacao
  last_polled_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_value)
);

-- Posts ingeridos
CREATE TABLE source_posts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_post_id  TEXT NOT NULL UNIQUE,
  author_handle     TEXT NOT NULL,
  author_name       TEXT,
  author_avatar_url TEXT,
  post_url          TEXT,
  text_raw          TEXT NOT NULL,
  posted_at         TIMESTAMPTZ NOT NULL,
  metrics_json      JSONB,
  raw_payload_json  JSONB,
  has_media         BOOLEAN NOT NULL DEFAULT FALSE,
  ingestion_status  TEXT NOT NULL DEFAULT 'new',
  -- 'new' | 'processing' | 'ready' | 'reviewed' | 'deployed' | 'failed' | 'ignored'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Assets (imagens baixadas ou screenshots)
CREATE TABLE post_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id  UUID NOT NULL REFERENCES source_posts(id) ON DELETE CASCADE,
  asset_type      TEXT NOT NULL, -- 'original_media' | 'screenshot' | 'link_image'
  storage_path    TEXT NOT NULL,
  public_url      TEXT,
  mime_type       TEXT,
  width           INT,
  height          INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Analise e score gerados por IA
CREATE TABLE signal_analysis (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id           UUID NOT NULL UNIQUE REFERENCES source_posts(id) ON DELETE CASCADE,
  score                    INT NOT NULL,
  score_label              TEXT NOT NULL, -- 'low' | 'medium' | 'high'
  extracted_name           TEXT,
  extracted_ticker_primary TEXT,
  extracted_ticker_alt_1   TEXT,
  extracted_ticker_alt_2   TEXT,
  short_description        TEXT,
  confidence               FLOAT,
  analysis_json            JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drafts de launch
CREATE TABLE launch_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id  UUID NOT NULL REFERENCES source_posts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  description     TEXT,
  twitter_url     TEXT,
  image_asset_id  UUID REFERENCES post_assets(id),
  image_url       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'deployed' | 'failed'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Registro de deploys realizados
CREATE TABLE deploy_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  launch_draft_id  UUID NOT NULL REFERENCES launch_drafts(id) ON DELETE CASCADE,
  deploy_status    TEXT NOT NULL, -- 'success' | 'failed'
  tx_hash          TEXT,
  mint_address     TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- Indices
-- =============================================================
CREATE INDEX idx_source_posts_status   ON source_posts(ingestion_status);
CREATE INDEX idx_source_posts_posted   ON source_posts(posted_at DESC);
CREATE INDEX idx_signal_analysis_score ON signal_analysis(score DESC);
CREATE INDEX idx_launch_drafts_status  ON launch_drafts(status);

-- =============================================================
-- Storage bucket (rodar tambem)
-- =============================================================
-- No painel do Supabase: Storage > New Bucket
-- Nome: live-deploys
-- Public: SIM (para URLs publicas das imagens)
--
-- Ou via SQL:
INSERT INTO storage.buckets (id, name, public) VALUES ('live-deploys', 'live-deploys', TRUE)
ON CONFLICT DO NOTHING;
