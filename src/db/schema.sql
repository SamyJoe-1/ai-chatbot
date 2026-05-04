CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  cafe_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cafes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
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
  menu_link TEXT,
  drive_folder_id TEXT,
  sheet_id TEXT,
  welcome_en TEXT DEFAULT 'Welcome! How can I help you today?',
  welcome_ar TEXT DEFAULT 'أهلاً! كيف يمكنني مساعدتك اليوم؟',
  suggestions_en TEXT DEFAULT '[]',
  suggestions_ar TEXT DEFAULT '[]',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL,
  name_ar TEXT,
  category_en TEXT,
  category_ar TEXT,
  description_en TEXT,
  description_ar TEXT,
  price REAL,
  currency TEXT DEFAULT 'EGP',
  sizes TEXT DEFAULT '[]',
  available INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT UNIQUE NOT NULL,
  cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  guest_name TEXT,
  guest_phone TEXT,
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

INSERT OR IGNORE INTO admins (id, username, password, role)
VALUES (1, 'admin', '$2a$10$kx69ZN/LvamVRScsPjB8aeDPF46oKClKAIsNFOXSw7bk6bSMle686', 'admin');
