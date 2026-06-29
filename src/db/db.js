'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.env.DB_PATH || path.join(process.cwd(), 'data', 'chatbot.db'));
const dataDir = path.dirname(dbPath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const rawDb = new DatabaseSync(dbPath);
rawDb.exec('PRAGMA journal_mode = WAL;');
rawDb.exec('PRAGMA synchronous = NORMAL;');
rawDb.exec('PRAGMA foreign_keys = ON;');

const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
rawDb.exec(schema);

function tableExists(tableName) {
  const row = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
}

function getColumns(tableName) {
  if (!tableExists(tableName)) return [];
  return rawDb.prepare(`PRAGMA table_info(${tableName})`).all();
}

function hasColumn(tableName, columnName) {
  return getColumns(tableName).some((column) => column.name === columnName);
}

function ensureColumn(tableName, columnName, definitionSql) {
  if (!tableExists(tableName)) return;
  if (!hasColumn(tableName, columnName)) {
    rawDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function migrateLegacyCafeData() {
  ensureColumn('admins', 'business_id', 'business_id INTEGER');
  ensureColumn('sessions', 'business_id', 'business_id INTEGER');
  ensureColumn('messages', 'thumbnail', 'thumbnail TEXT');
  ensureColumn('messages', 'ai_score', 'ai_score INTEGER');
  ensureColumn('businesses', 'ai_enabled', 'ai_enabled INTEGER NOT NULL DEFAULT 0');
  // Franco/Arabizi phonetic recovery is ON by default (preserves existing
  // behavior); owners can disable it per business when it over-matches.
  ensureColumn('businesses', 'franco_enabled', 'franco_enabled INTEGER NOT NULL DEFAULT 1');
  ensureColumn('businesses', 'faq_en', "faq_en TEXT DEFAULT '[]'");
  ensureColumn('businesses', 'faq_ar', "faq_ar TEXT DEFAULT '[]'");
  // Editable "Contact us" button target (whatsapp / mailto / any URL). Falls
  // back to phone/email in the brain when empty.
  ensureColumn('businesses', 'contact_link', 'contact_link TEXT');
  // Sourcing mode (e-commerce): prices are private (push to a quote) and an
  // unavailable product is answered as "we'll source it" instead of "out of
  // stock". Off by default so a normal store keeps showing prices/stock.
  ensureColumn('businesses', 'sourcing_mode', 'sourcing_mode INTEGER NOT NULL DEFAULT 0');

  // AI Usage diagnosis: keep the full rendered prompt + full model output and
  // the cached-token count so any call can be inspected after the fact.
  ensureColumn('ai_calls', 'cached_tokens', 'cached_tokens INTEGER DEFAULT 0');
  ensureColumn('ai_calls', 'full_input', 'full_input TEXT');
  ensureColumn('ai_calls', 'full_output', 'full_output TEXT');

  if (tableExists('admins') && hasColumn('admins', 'cafe_id')) {
    rawDb.prepare('UPDATE admins SET business_id = COALESCE(business_id, cafe_id) WHERE business_id IS NULL').run();
    try { rawDb.exec('ALTER TABLE admins DROP COLUMN cafe_id'); } catch (e) { console.warn('Could not drop cafe_id from admins:', e.message); }
  }

  if (tableExists('sessions') && hasColumn('sessions', 'cafe_id')) {
    rawDb.prepare('UPDATE sessions SET business_id = COALESCE(business_id, cafe_id) WHERE business_id IS NULL').run();
    try { rawDb.exec('ALTER TABLE sessions DROP COLUMN cafe_id'); } catch (e) { console.warn('Could not drop cafe_id from sessions:', e.message); }
  }

  // The legacy data copy below (cafes -> businesses, menu_items -> service_items)
  // must run AT MOST ONCE. It re-inserts legacy rows with their original IDs via
  // INSERT OR IGNORE; if it runs on every boot it keeps resurrecting stale
  // thumbnail-less menu rows that a Google-Sheet resync had already replaced,
  // shadowing the freshly synced items (the matcher dedupes by title and keeps
  // the lowest/legacy id). Gate it behind PRAGMA user_version so it happens once.
  const legacyMigrationDone = rawDb.prepare('PRAGMA user_version').get().user_version >= 1;
  if (legacyMigrationDone) {
    return;
  }

  if (tableExists('cafes')) {
    const legacyBusinesses = rawDb.prepare('SELECT * FROM cafes').all();
    const insertBusiness = rawDb.prepare(`
      INSERT OR IGNORE INTO businesses (
        id, token, service_type, name, name_ar, primary_color, secondary_color, logo_url,
        about_en, about_ar, phone, email, address_en, address_ar,
        working_hours_en, working_hours_ar, catalog_link, drive_folder_id, sheet_id, sheet_name,
        welcome_en, welcome_ar, suggestions_en, suggestions_ar, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    legacyBusinesses.forEach((business) => {
      insertBusiness.run(
        business.id,
        business.token,
        'cafe',
        business.name,
        business.name_ar || '',
        business.primary_color || '#17443a',
        business.secondary_color || '#f6efe4',
        business.logo_url || '',
        business.about_en || '',
        business.about_ar || '',
        business.phone || '',
        business.email || '',
        business.address_en || '',
        business.address_ar || '',
        business.working_hours_en || '',
        business.working_hours_ar || '',
        business.menu_link || '',
        business.drive_folder_id || '',
        business.sheet_id || '',
        'Menu',
        business.welcome_en || 'Welcome! How can I help you today?',
        business.welcome_ar || 'أهلاً! كيف يمكنني مساعدتك اليوم؟',
        business.suggestions_en || '[]',
        business.suggestions_ar || '[]',
        business.active === 0 ? 0 : 1,
        business.created_at || null
      );
    });
  }

  if (tableExists('menu_items')) {
    const legacyItems = rawDb.prepare('SELECT * FROM menu_items').all();
    const insertItem = rawDb.prepare(`
      INSERT OR IGNORE INTO service_items (
        id, business_id, service_type, title_en, title_ar, category_en, category_ar,
        description_en, description_ar, price, currency, metadata, available, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    legacyItems.forEach((item) => {
      insertItem.run(
        item.id,
        item.cafe_id,
        'cafe',
        item.name_en,
        item.name_ar || '',
        item.category_en || '',
        item.category_ar || '',
        item.description_en || '',
        item.description_ar || '',
        item.price,
        item.currency || 'EGP',
        JSON.stringify({ sizes: parseJsonArray(item.sizes) }),
        item.available === 0 ? 0 : 1,
        item.created_at || null
      );
    });
  }

  // Mark the one-time legacy data copy as complete so it never re-runs.
  rawDb.exec('PRAGMA user_version = 1;');
}

migrateLegacyCafeData();

const legacyAdminHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const defaultAdminHash = '$2a$10$kx69ZN/LvamVRScsPjB8aeDPF46oKClKAIsNFOXSw7bk6bSMle686';
rawDb.prepare('UPDATE admins SET password = ? WHERE username = ? AND password = ?')
  .run(defaultAdminHash, 'admin', legacyAdminHash);

// Fold the write-ahead log back into the main .db file. In WAL mode with
// synchronous = NORMAL, committed rows live in the -wal sidecar until a
// checkpoint moves them across. Without this, a freshly synced catalog (and
// its thumbnails) exists only in the -wal file — if the restart tooling drops
// or truncates that sidecar, SQLite reverts to the stale main file and the
// data appears to vanish until the next resync. TRUNCATE also keeps the -wal
// from growing without bound.
function checkpoint() {
  try {
    rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (error) {
    console.warn('[db] wal_checkpoint failed:', error.message);
  }
}

const db = {
  exec(sql) {
    return rawDb.exec(sql);
  },
  prepare(sql) {
    return rawDb.prepare(sql);
  },
  checkpoint,
  transaction(fn) {
    return (...args) => {
      rawDb.exec('BEGIN');
      try {
        const result = fn(...args);
        rawDb.exec('COMMIT');
        // Make the just-committed write durable in the main db file, not just
        // the -wal sidecar, so it survives any kind of restart.
        checkpoint();
        return result;
      } catch (error) {
        try {
          rawDb.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    };
  },
};

// Best-effort final checkpoint when the process is shutting down cleanly, so a
// graceful stop also leaves the main db file fully up to date.
process.once('exit', checkpoint);

module.exports = db;
