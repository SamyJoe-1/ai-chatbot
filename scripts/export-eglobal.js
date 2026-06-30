'use strict';

/**
 * Export E-Global Trading data from the database.
 * Uses the `sqlite3` CLI — works on any Node.js version.
 *
 * Exports: businesses row, service_items, brand_profile
 * Skips:   sessions, messages, orders, ai_usage, ai_calls (customer/env data)
 *
 * Usage:
 *   node scripts/export-eglobal.js
 *   node scripts/export-eglobal.js --out /tmp/eglobal-export.json
 *   DB_PATH=/other/chatbot.db node scripts/export-eglobal.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── resolve paths ────────────────────────────────────────────────────────────
const dbPath = path.resolve(process.env.DB_PATH || path.join(process.cwd(), 'data', 'chatbot.db'));
const outArg = (() => {
  const idx = process.argv.indexOf('--out');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith('--out='));
  return eq ? eq.split('=').slice(1).join('=') : null;
})();
const outPath = outArg ? path.resolve(outArg) : path.join(process.cwd(), 'data', 'eglobal-export.json');

// ── check sqlite3 is available ───────────────────────────────────────────────
try {
  execSync('sqlite3 --version', { stdio: 'pipe' });
} catch {
  console.error('sqlite3 CLI not found. Install it:  apt-get install sqlite3');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

// ── query helper ─────────────────────────────────────────────────────────────
function query(sql) {
  const out = execSync(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`, { stdio: 'pipe' }).toString().trim();
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

// ── fetch data ───────────────────────────────────────────────────────────────
const businesses = query("SELECT * FROM businesses WHERE name = 'E-Global Trading'");
if (!businesses.length) {
  console.error('Business "E-Global Trading" not found in the database.');
  process.exit(1);
}
const biz = businesses[0];

const items   = query(`SELECT * FROM service_items WHERE business_id = ${biz.id} ORDER BY id`);
const profiles = query(`SELECT * FROM brand_profiles WHERE business_id = ${biz.id}`);
const profile = profiles[0] || null;

// ── write JSON ───────────────────────────────────────────────────────────────
const payload = {
  _meta: {
    exported_at: new Date().toISOString(),
    business_name: biz.name,
    item_count: items.length,
  },
  business: biz,
  service_items: items,
  brand_profile: profile,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

console.log(`Exported "${biz.name}" (id=${biz.id})`);
console.log(`  items: ${items.length}`);
console.log(`  brand_profile: ${profile ? 'yes' : 'none'}`);
console.log(`  -> ${outPath}`);
