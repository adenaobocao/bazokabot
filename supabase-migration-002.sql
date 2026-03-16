-- Migration 002 — Isolamento por usuario em launch_drafts
-- Rodar no SQL Editor do Supabase

-- 1. Adiciona coluna username em launch_drafts
ALTER TABLE launch_drafts ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';

-- 2. Popula registros existentes com 'default' para nao ficarem vazios
UPDATE launch_drafts SET username = 'default' WHERE username = '';

-- 3. Indice para buscar por usuario
CREATE INDEX IF NOT EXISTS idx_launch_drafts_username ON launch_drafts(username);
