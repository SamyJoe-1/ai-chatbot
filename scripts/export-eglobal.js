'use strict';

/**
 * Export E-Global Trading data from the local database.
 *
 * Exports:
 *   - businesses row (profile, settings, credentials)
 *   - service_items (catalog, 612 items)
 *   - brand_profiles (AI concept map)
 *
 * Does NOT export: sessions, messages, orders, ai_usage, ai_calls
 * (those are environment-specific and contain customer data).
 *
 * Usage:
 *   node scripts/export-eglobal.js
 *   node scripts/export-eglobal.js --out data/eglobal-export.json
 */

const path = require('path');
const fs   = require('fs');

const db = require('../src/db/db');

const BUSINESS_NAME = 'E-Global Trading';
const DEFAULT_OUT   = path.join(process.cwd(), 'data', 'eglobal-export.json');
const outArg = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]
            || (process.argv.indexOf('--out') !== -1
                ? process.argv[process.argv.indexOf('--out') + 1]
                : null);
const outPath = outArg ? path.resolve(outArg) : DEFAULT_OUT;

const business = db.prepare("SELECT * FROM businesses WHERE name = ?").get(BUSINESS_NAME);
if (!business) {
  console.error(`Business "${BUSINESS_NAME}" not found in the database.`);
  process.exit(1);
}

const items = db.prepare('SELECT * FROM service_items WHERE business_id = ? ORDER BY id').all(business.id);
const profile = db.prepare('SELECT * FROM brand_profiles WHERE business_id = ?').get(business.id);

const payload = {
  _meta: {
    exported_at: new Date().toISOString(),
    business_name: business.name,
    item_count: items.length,
  },
  business,
  service_items: items,
  brand_profile: profile || null,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

console.log(`Exported "${business.name}" (id=${business.id})`);
console.log(`  items: ${items.length}`);
console.log(`  brand_profile: ${profile ? 'yes' : 'none'}`);
console.log(`  -> ${outPath}`);
