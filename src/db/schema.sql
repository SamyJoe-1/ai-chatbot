CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  business_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  service_type TEXT NOT NULL DEFAULT 'cafe',
  name TEXT NOT NULL,
  name_ar TEXT,
  primary_color TEXT DEFAULT '#17443a',
  secondary_color TEXT DEFAULT '#f6efe4',
  logo_url TEXT,
  about_en TEXT,
  about_ar TEXT,
  phone TEXT,
  email TEXT,
  address_en TEXT,
  address_ar TEXT,
  working_hours_en TEXT,
  working_hours_ar TEXT,
  catalog_link TEXT,
  contact_link TEXT,
  drive_folder_id TEXT,
  sheet_id TEXT,
  sheet_name TEXT DEFAULT 'Catalog',
  welcome_en TEXT DEFAULT 'Welcome! How can I help you today?',
  welcome_ar TEXT DEFAULT 'أهلاً! كيف يمكنني مساعدتك اليوم؟',
  suggestions_en TEXT DEFAULT '[]',
  suggestions_ar TEXT DEFAULT '[]',
  faq_en TEXT DEFAULT '[]',
  faq_ar TEXT DEFAULT '[]',
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  franco_enabled INTEGER NOT NULL DEFAULT 1,
  sourcing_mode INTEGER NOT NULL DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS service_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL DEFAULT 'cafe',
  title_en TEXT NOT NULL,
  title_ar TEXT,
  category_en TEXT,
  category_ar TEXT,
  description_en TEXT,
  description_ar TEXT,
  price REAL,
  currency TEXT DEFAULT 'EGP',
  metadata TEXT DEFAULT '{}',
  available INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT UNIQUE NOT NULL,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  guest_name TEXT,
  guest_phone TEXT,
  automated INTEGER NOT NULL DEFAULT 1,
  language TEXT DEFAULT 'en',
  ip TEXT,
  phase TEXT DEFAULT 'collect_name',
  context TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  last_active TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  intent TEXT,
  thumbnail TEXT,
  ai_score INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  guest_name TEXT,
  guest_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  address TEXT,
  email TEXT,
  country TEXT,
  note TEXT,
  confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  service_item_id INTEGER REFERENCES service_items(id) ON DELETE SET NULL,
  title_en TEXT NOT NULL,
  title_ar TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL,
  currency TEXT DEFAULT 'EGP',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Per-IP / per-device AI usage log, used to rate-limit AI calls so abuse
-- cannot drain the AI balance. One row per AI classifier call.
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  identifier TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Rich per-call AI log for the "AI Usage" dashboard: one row per real AI call
-- (classify/answer), with latency, token counts and estimated cost.
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  session_id INTEGER,
  message TEXT,
  mode TEXT,                 -- classify | answer
  model TEXT,
  duration_ms INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,   -- prompt tokens served from the provider cache
  cost_usd REAL DEFAULT 0,
  from_cache INTEGER DEFAULT 0,
  full_input TEXT,                   -- the exact rendered prompt sent to the LLM
  full_output TEXT,                  -- the full untrimmed model response
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_business_time ON ai_calls (business_id, created_at);

-- One-time AI-generated "brand brain" per business: a compact JSON artifact
-- holding the brand identity summary + a concept->items keyword map (e.g.
-- "sea" -> Shrimp, Calamari) + per-item extra keywords. Generated ONCE when the
-- menu syncs (not per message) and consumed LOCALLY by the matcher, so it adds
-- zero tokens to live customer queries while letting "something from the sea"
-- resolve to real seafood items. source_hash lets us skip regeneration when the
-- inputs (business profile + catalog) have not changed.
CREATE TABLE IF NOT EXISTS brand_profiles (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT,
  model TEXT,
  generated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_business_phone_status ON orders (business_id, guest_phone, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_unique_service_item ON order_items (order_id, service_item_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_lookup ON ai_usage (business_id, scope, identifier, created_at);

INSERT OR IGNORE INTO admins (id, username, password, role)
VALUES (1, 'admin', '$2a$10$kx69ZN/LvamVRScsPjB8aeDPF46oKClKAIsNFOXSw7bk6bSMle686', 'admin');
