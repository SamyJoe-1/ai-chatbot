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
