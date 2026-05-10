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

  if (tableExists('admins') && hasColumn('admins', 'cafe_id')) {
    rawDb.prepare('UPDATE admins SET business_id = COALESCE(business_id, cafe_id) WHERE business_id IS NULL').run();
    try { rawDb.exec('ALTER TABLE admins DROP COLUMN cafe_id'); } catch (e) { console.warn('Could not drop cafe_id from admins:', e.message); }
  }

  if (tableExists('sessions') && hasColumn('sessions', 'cafe_id')) {
    rawDb.prepare('UPDATE sessions SET business_id = COALESCE(business_id, cafe_id) WHERE business_id IS NULL').run();
    try { rawDb.exec('ALTER TABLE sessions DROP COLUMN cafe_id'); } catch (e) { console.warn('Could not drop cafe_id from sessions:', e.message); }
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
}

migrateLegacyCafeData();

const legacyAdminHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const defaultAdminHash = '$2a$10$kx69ZN/LvamVRScsPjB8aeDPF46oKClKAIsNFOXSw7bk6bSMle686';
rawDb.prepare('UPDATE admins SET password = ? WHERE username = ? AND password = ?')
  .run(defaultAdminHash, 'admin', legacyAdminHash);

const db = {
  exec(sql) {
    return rawDb.exec(sql);
  },
  prepare(sql) {
    return rawDb.prepare(sql);
  },
  transaction(fn) {
    return (...args) => {
      rawDb.exec('BEGIN');
      try {
        const result = fn(...args);
        rawDb.exec('COMMIT');
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

module.exports = db;
