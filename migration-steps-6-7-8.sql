-- ============================================================
-- CommissionIQ – Migration: Approvals, Team Members, Users
-- Run in Supabase SQL Editor after initial schema
-- ============================================================

-- ── USERS TABLE (synced from auth.users) ─────────────────────────────────────
-- Supabase trigger: auto-create on first sign-in
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT UNIQUE NOT NULL,
  full_name   TEXT,
  role        TEXT NOT NULL DEFAULT 'Engineer'
              CHECK (role IN ('Admin','Engineer','Viewer')),
  company     TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-insert user on first sign-in
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO UPDATE SET last_login = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── PROJECT MEMBERS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'Engineer'
              CHECK (role IN ('Admin','CxA','Engineer','Viewer','Owner-Rep')),
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, user_id)
);

-- Auto-add project creator as Admin member
CREATE OR REPLACE FUNCTION add_creator_as_member()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO project_members (project_id, user_id, role)
  VALUES (NEW.id, NEW.owner_id, 'Admin')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_creator_member ON projects;
CREATE TRIGGER trg_project_creator_member
  AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION add_creator_as_member();

-- ── APPROVALS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cx_level              SMALLINT NOT NULL CHECK (cx_level BETWEEN 0 AND 6),
  requested_by          UUID REFERENCES users(id),
  requested_by_email    TEXT NOT NULL,
  note                  TEXT DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected')),
  responded_by_email    TEXT,
  responded_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_self"    ON users FOR ALL TO authenticated USING (auth.uid() = id OR auth.uid() IS NOT NULL);
CREATE POLICY "members_auth"  ON project_members FOR ALL TO authenticated USING (auth.uid() IS NOT NULL);
CREATE POLICY "approvals_auth" ON approvals FOR ALL TO authenticated USING (auth.uid() IS NOT NULL);

-- ── SUPABASE CRON: Check due punch items daily at 8am UTC ────────────────────
-- Requires pg_cron extension (enabled via Supabase Dashboard → Database → Extensions)
-- SELECT cron.schedule('punch-due-check', '0 8 * * *', $$
--   SELECT net.http_post(
--     url := current_setting('app.supabase_url') || '/functions/v1/commissioniq-notify',
--     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.supabase_anon_key')),
--     body := '{"type":"scheduled_punch_check"}'::jsonb
--   );
-- $$);
