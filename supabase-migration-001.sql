-- Migration 001 — Per-user watchlist + PnL tracking
-- Rodar no SQL Editor do Supabase

-- 1. Adiciona coluna username em tracked_sources
ALTER TABLE tracked_sources ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';

-- 2. Atualiza registros existentes para nao ficarem com username vazio
UPDATE tracked_sources SET username = 'admin' WHERE username = '';

-- 3. Remove unique constraint antiga (apenas source_value)
ALTER TABLE tracked_sources DROP CONSTRAINT IF EXISTS tracked_sources_source_value_key;

-- 4. Nova unique constraint: por usuario + handle
ALTER TABLE tracked_sources
  ADD CONSTRAINT tracked_sources_username_source_value_key
  UNIQUE (username, source_value);

-- 5. Adiciona dev_buy_sol em deploy_runs para calculo de PnL
ALTER TABLE deploy_runs ADD COLUMN IF NOT EXISTS dev_buy_sol FLOAT DEFAULT 0;

-- 6. Indice para buscar por usuario
CREATE INDEX IF NOT EXISTS idx_tracked_sources_username ON tracked_sources(username);
