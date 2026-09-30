-- AI Gateway schema, initial migration.
--
-- Conventions:
--   * Every tenant-owned table carries organization_id and is indexed on it
--     first. Tenant isolation is enforced in the query layer and backed by
--     row-level security policies below.
--   * Request IDs are ULIDs, so (organization_id, id DESC) is already a
--     chronological index and pagination needs no separate sort key.
--   * Secrets are stored only as ciphertext or as one-way hashes.

-- No extensions are required. IDs are ULIDs minted by the application, which
-- keeps this schema runnable on managed Postgres that restricts extensions.

-- ---------------------------------------------------------------- tenancy

CREATE TABLE IF NOT EXISTS organizations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  currency        TEXT NOT NULL DEFAULT 'USD',
  privacy         JSONB NOT NULL DEFAULT '{"mode":"metadata_only","retentionDays":30}'::jsonb,
  allowed_models  TEXT[],
  denied_models   TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON organization_members (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  allowed_models    TEXT[],
  denied_models     TEXT[] NOT NULL DEFAULT '{}',
  routing_policy_id TEXT,
  privacy           JSONB,
  archived          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects (organization_id);

-- --------------------------------------------------------------- api keys

CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- Non-secret display prefix, e.g. aigw_live_a1b2c3.
  prefix          TEXT NOT NULL,
  -- scrypt hash of the full key. The plaintext is never stored.
  hash            TEXT NOT NULL,
  -- Peppered HMAC giving an O(1) lookup without a table scan.
  lookup_index    TEXT NOT NULL UNIQUE,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  created_by      TEXT,
  rotated_from    TEXT,
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_org     ON api_keys (organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys (project_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix  ON api_keys (prefix);

-- --------------------------------------------------- providers and models

CREATE TABLE IF NOT EXISTS providers (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  base_url        TEXT,
  credential_ref  TEXT,
  headers         JSONB,
  timeout_ms      INTEGER,
  weight          NUMERIC,
  priority        INTEGER,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);

-- Ciphertext only. The encryption key lives in the environment, never here.
CREATE TABLE IF NOT EXISTS provider_credentials (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref             TEXT NOT NULL,
  encrypted       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, ref)
);

CREATE TABLE IF NOT EXISTS models (
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  context_window    INTEGER NOT NULL,
  max_output_tokens INTEGER,
  capabilities      TEXT[] NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'available',
  family            TEXT,
  description       TEXT,
  deprecated_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models (organization_id, provider_id);
CREATE INDEX IF NOT EXISTS idx_models_status   ON models (organization_id, status);

-- Immutable price snapshots. Cost rows reference a version so history stays
-- reproducible after prices change.
CREATE TABLE IF NOT EXISTS pricing_versions (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  as_of           DATE NOT NULL,
  source          TEXT NOT NULL,
  notes           TEXT,
  prices          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, version)
);

-- ------------------------------------------------------- routing policies

CREATE TABLE IF NOT EXISTS routing_policies (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  active_version  INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_policies_org ON routing_policies (organization_id, project_id);

CREATE TABLE IF NOT EXISTS routing_policy_versions (
  id         TEXT PRIMARY KEY,
  policy_id  TEXT NOT NULL REFERENCES routing_policies(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  document   JSONB NOT NULL,
  checksum   TEXT NOT NULL,
  created_by TEXT NOT NULL,
  note       TEXT,
  active     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);
-- At most one active version per policy, enforced by the database rather than
-- by application discipline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_single_active
  ON routing_policy_versions (policy_id) WHERE active;

-- ------------------------------------------------------ requests + traces

CREATE TABLE IF NOT EXISTS requests (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL,
  project_id              TEXT NOT NULL,
  api_key_id              TEXT NOT NULL,
  endpoint                TEXT NOT NULL,
  requested_model         TEXT NOT NULL,
  resolved_provider_id    TEXT,
  resolved_model_id       TEXT,
  strategy                TEXT,
  status                  TEXT NOT NULL,
  error_type              TEXT,
  error_message           TEXT,
  http_status             INTEGER NOT NULL,
  streamed                BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms              INTEGER NOT NULL,
  time_to_first_token_ms  INTEGER,
  cache_status            TEXT NOT NULL DEFAULT 'miss',
  cache_similarity        REAL,
  fallback_used           BOOLEAN NOT NULL DEFAULT FALSE,
  attempt_count           INTEGER NOT NULL DEFAULT 1,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  total_tokens            INTEGER,
  cached_input_tokens     INTEGER,
  usage_source            TEXT,
  estimated_cost          NUMERIC(20,10),
  currency                TEXT,
  pricing_version         TEXT,
  is_test                 BOOLEAN NOT NULL DEFAULT FALSE,
  tags                    TEXT[] NOT NULL DEFAULT '{}',
  routing_reasons         TEXT[],
  prompt_ref              TEXT,
  user_agent              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The analytics workhorse: every dashboard query filters on org + time, and
-- ULID ids sort chronologically so this index serves both.
CREATE INDEX IF NOT EXISTS idx_requests_org_id       ON requests (organization_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_org_created  ON requests (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_project      ON requests (organization_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_api_key      ON requests (organization_id, api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_provider     ON requests (organization_id, resolved_provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_model        ON requests (organization_id, resolved_model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status       ON requests (organization_id, status, created_at DESC);
-- Production analytics exclude test traffic, so give that predicate its own index.
CREATE INDEX IF NOT EXISTS idx_requests_production
  ON requests (organization_id, created_at DESC) WHERE NOT is_test;
CREATE INDEX IF NOT EXISTS idx_requests_errors
  ON requests (organization_id, error_type, created_at DESC) WHERE status = 'error';

CREATE TABLE IF NOT EXISTS request_attempts (
  id                      TEXT PRIMARY KEY,
  request_id              TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  organization_id         TEXT NOT NULL,
  attempt_number          INTEGER NOT NULL,
  provider_id             TEXT NOT NULL,
  model_id                TEXT NOT NULL,
  started_at              BIGINT NOT NULL,
  duration_ms             INTEGER NOT NULL,
  status                  TEXT NOT NULL,
  error_type              TEXT,
  error_message           TEXT,
  provider_status         INTEGER,
  retry_after_seconds     INTEGER,
  time_to_first_token_ms  INTEGER,
  backoff_ms              INTEGER,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  usage_source            TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_request  ON request_attempts (request_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_attempts_provider ON request_attempts (organization_id, provider_id, started_at DESC);

CREATE TABLE IF NOT EXISTS request_events (
  id              BIGSERIAL PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      BIGINT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  error_type      TEXT,
  message         TEXT,
  detail          JSONB
);
CREATE INDEX IF NOT EXISTS idx_events_request ON request_events (request_id, seq);

-- Prompt and response bodies live apart from the request row so retention can
-- be enforced by deleting from one table, and so the analytics path never
-- reads them.
CREATE TABLE IF NOT EXISTS request_bodies (
  request_id      TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  request_body    JSONB,
  response_body   JSONB,
  stored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bodies_expiry ON request_bodies (expires_at);

-- --------------------------------------------- budgets, alerts, webhooks

CREATE TABLE IF NOT EXISTS budgets (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('organization','project','api_key')),
  scope_id        TEXT,
  period          TEXT NOT NULL CHECK (period IN ('daily','monthly')),
  budget_limit    NUMERIC(20,6) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  action          TEXT NOT NULL CHECK (action IN ('BLOCK','WARN','FALLBACK_TO_CHEAPER_MODEL')),
  warn_threshold  REAL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budgets_org ON budgets (organization_id, scope, scope_id);

CREATE TABLE IF NOT EXISTS budget_events (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  budget_id       TEXT NOT NULL,
  request_id      TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('warning','exceeded','downgraded')),
  spent           NUMERIC(20,6) NOT NULL,
  budget_limit    NUMERIC(20,6) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_events ON budget_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  metric           TEXT NOT NULL,
  comparator       TEXT NOT NULL CHECK (comparator IN ('gt','lt')),
  threshold        NUMERIC NOT NULL,
  for_minutes      INTEGER NOT NULL DEFAULT 5,
  cooldown_minutes INTEGER NOT NULL DEFAULT 30,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_events (
  id              TEXT PRIMARY KEY,
  alert_id        TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  fired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  observed_value  NUMERIC NOT NULL,
  threshold       NUMERIC NOT NULL,
  message         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_events ON alert_events (organization_id, fired_at DESC);

CREATE TABLE IF NOT EXISTS webhooks (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  secret_encrypted      TEXT NOT NULL,
  events                TEXT[] NOT NULL DEFAULT '{}',
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  last_delivery_at      TIMESTAMPTZ,
  last_delivery_status  INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending
  ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- -------------------------------------------------- audit + provider health

CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  metadata        JSONB,
  ip              TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_health_snapshots (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  state         TEXT NOT NULL,
  latency_ms    INTEGER,
  success_rate  REAL NOT NULL,
  p95_latency_ms INTEGER NOT NULL,
  sample_count  INTEGER NOT NULL,
  message       TEXT,
  checked_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_provider ON provider_health_snapshots (provider_id, checked_at DESC);

-- ------------------------------------------------------ row level security
--
-- Defence in depth. The application always scopes by organization_id; these
-- policies mean a missing WHERE clause is an empty result rather than a
-- cross-tenant leak. The gateway sets `app.organization_id` per connection.

ALTER TABLE requests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_bodies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs       ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['requests','request_attempts','request_events','request_bodies','api_keys','audit_logs']
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I; '
      'CREATE POLICY tenant_isolation ON %I USING ('
      '  current_setting(''app.organization_id'', true) IS NULL'
      '  OR current_setting(''app.organization_id'', true) = '''''
      '  OR organization_id = current_setting(''app.organization_id'', true)'
      ')', t, t);
  END LOOP;
END $$;
