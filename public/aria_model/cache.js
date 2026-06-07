const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'cache.db');

let db = null;

const initDB = async () => {
    if (db) return db;

    const SQL = await initSqlJs();

    // Load existing DB from disk if it exists, otherwise create fresh
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
    CREATE TABLE IF NOT EXISTS cache (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      service   TEXT    NOT NULL,
      message   TEXT    NOT NULL,
      response  TEXT    NOT NULL,
      UNIQUE(service, message)
    )
  `);

    persistDB();
    return db;
};

// Write DB back to disk after every write
const persistDB = () => {
    if (!db) return;
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
};

// Normalize: lowercase + collapse whitespace + trim
// This is intentionally strict per your requirement: exact match after normalization
const normalize = (str) => str.toLowerCase().replace(/\s+/g, ' ').trim();

const getCache = async (service, message) => {
    await initDB();
    const key = normalize(message);
    const result = db.exec(
        'SELECT response FROM cache WHERE service = ? AND message = ?',
        [service, key]
    );
    if (result.length && result[0].values.length) {
        return result[0].values[0][0];
    }
    return null;
};

const setCache = async (service, message, response) => {
    await initDB();
    const key = normalize(message);
    db.run(
        'INSERT OR REPLACE INTO cache (service, message, response) VALUES (?, ?, ?)',
        [service, key, response]
    );
    persistDB();
};

module.exports = { getCache, setCache };