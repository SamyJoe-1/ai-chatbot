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
  drive_folder_id TEXT,
  sheet_id TEXT,
  sheet_name TEXT DEFAULT 'Catalog',
  welcome_en TEXT DEFAULT 'Welcome! How can I help you today?',
  welcome_ar TEXT DEFAULT 'أهلاً! كيف يمكنني مساعدتك اليوم؟',
  suggestions_en TEXT DEFAULT '[]',
  suggestions_ar TEXT DEFAULT '[]',
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

CREATE INDEX IF NOT EXISTS idx_orders_business_phone_status ON orders (business_id, guest_phone, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_unique_service_item ON order_items (order_id, service_item_id);

INSERT OR IGNORE INTO admins (id, username, password, role)
VALUES (1, 'admin', '$2a$10$kx69ZN/LvamVRScsPjB8aeDPF46oKClKAIsNFOXSw7bk6bSMle686', 'admin');
