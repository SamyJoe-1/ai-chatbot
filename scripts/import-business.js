'use strict';

/**
 * Import a business export file into any database (local dev or live production).
 * Uses the `sqlite3` CLI — works on any Node.js version.
 *
 * Safe to re-run: matched by token, never duplicates. service_items are
 * fully replaced in a single transaction. brand_profile is upserted.
 * IDs are NOT preserved — target DB auto-assigns new IDs (no collision risk).
 *
 * Usage:
 *   node scripts/import-business.js
 *   node scripts/import-business.js --in /tmp/eglobal-export.json
 *   DB_PATH=/path/to/prod/chatbot.db node scripts/import-business.js --in /tmp/eglobal-export.json
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── resolve paths ────────────────────────────────────────────────────────────
const dbPath = path.resolve(process.env.DB_PATH || path.join(process.cwd(), 'data', 'chatbot.db'));
const inArg = (() => {
  const idx = process.argv.indexOf('--in');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith('--in='));
  return eq ? eq.split('=').slice(1).join('=') : null;
})();
const inPath = inArg ? path.resolve(inArg) : path.join(process.cwd(), 'data', 'eglobal-export.json');

// ── checks ───────────────────────────────────────────────────────────────────
try {
  execSync('sqlite3 --version', { stdio: 'pipe' });
} catch {
  console.error('sqlite3 CLI not found. Install it:  apt-get install sqlite3');
  process.exit(1);
}

if (!fs.existsSync(inPath)) {
  console.error(`Export file not found: ${inPath}`);
  console.error('Run  node scripts/export-eglobal.js  first to create it.');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(inPath, 'utf8'));
} catch (e) {
  console.error('Failed to parse export file:', e.message);
  process.exit(1);
}

const { business: biz, service_items: items, brand_profile: profile } = payload;
if (!biz || !biz.token) {
  console.error('Export file is missing the business record or token.');
  process.exit(1);
}

console.log(`Importing "${biz.name}" from ${inPath}`);
console.log(`  target DB: ${dbPath}`);
console.log(`  items: ${(items || []).length} | brand_profile: ${profile ? 'yes' : 'none'}`);
console.log('');

// ── helpers ───────────────────────────────────────────────────────────────────
function q(sql) {
  const out = execSync(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`, { stdio: 'pipe' }).toString().trim();
  if (!out) return [];
  try { return JSON.parse(out); } catch { return []; }
}

// Run a block of SQL statements via stdin (safe for large INSERT batches).
function runSql(sql) {
  const result = spawnSync('sqlite3', [dbPath], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || 'sqlite3 error');
  }
}

// Escape a value for embedding in a SQL literal.
function esc(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ── 1. Upsert business ────────────────────────────────────────────────────────
const existing = q(`SELECT id FROM businesses WHERE token = ${esc(biz.token)}`);
let businessId;

if (existing.length) {
  businessId = existing[0].id;
  runSql(`
    UPDATE businesses SET
      service_type = ${esc(biz.service_type)},
      name = ${esc(biz.name)},
      name_ar = ${esc(biz.name_ar)},
      primary_color = ${esc(biz.primary_color)},
      secondary_color = ${esc(biz.secondary_color)},
      logo_url = ${esc(biz.logo_url)},
      about_en = ${esc(biz.about_en)},
      about_ar = ${esc(biz.about_ar)},
      phone = ${esc(biz.phone)},
      email = ${esc(biz.email)},
      address_en = ${esc(biz.address_en)},
      address_ar = ${esc(biz.address_ar)},
      working_hours_en = ${esc(biz.working_hours_en)},
      working_hours_ar = ${esc(biz.working_hours_ar)},
      catalog_link = ${esc(biz.catalog_link)},
      contact_link = ${esc(biz.contact_link)},
      drive_folder_id = ${esc(biz.drive_folder_id)},
      sheet_id = ${esc(biz.sheet_id)},
      sheet_name = ${esc(biz.sheet_name)},
      welcome_en = ${esc(biz.welcome_en)},
      welcome_ar = ${esc(biz.welcome_ar)},
      suggestions_en = ${esc(biz.suggestions_en)},
      suggestions_ar = ${esc(biz.suggestions_ar)},
      faq_en = ${esc(biz.faq_en)},
      faq_ar = ${esc(biz.faq_ar)},
      ai_enabled = ${esc(biz.ai_enabled)},
      franco_enabled = ${esc(biz.franco_enabled)},
      sourcing_mode = ${esc(biz.sourcing_mode)},
      active = ${esc(biz.active)}
    WHERE id = ${businessId};
  `);
  console.log(`  business: updated existing (id=${businessId})`);
} else {
  runSql(`
    INSERT INTO businesses (
      token, service_type, name, name_ar, primary_color, secondary_color,
      logo_url, about_en, about_ar, phone, email,
      address_en, address_ar, working_hours_en, working_hours_ar,
      catalog_link, contact_link, drive_folder_id, sheet_id, sheet_name,
      welcome_en, welcome_ar, suggestions_en, suggestions_ar,
      faq_en, faq_ar, ai_enabled, franco_enabled, sourcing_mode, active, created_at
    ) VALUES (
      ${esc(biz.token)}, ${esc(biz.service_type)}, ${esc(biz.name)}, ${esc(biz.name_ar)},
      ${esc(biz.primary_color)}, ${esc(biz.secondary_color)},
      ${esc(biz.logo_url)}, ${esc(biz.about_en)}, ${esc(biz.about_ar)},
      ${esc(biz.phone)}, ${esc(biz.email)},
      ${esc(biz.address_en)}, ${esc(biz.address_ar)},
      ${esc(biz.working_hours_en)}, ${esc(biz.working_hours_ar)},
      ${esc(biz.catalog_link)}, ${esc(biz.contact_link)},
      ${esc(biz.drive_folder_id)}, ${esc(biz.sheet_id)}, ${esc(biz.sheet_name)},
      ${esc(biz.welcome_en)}, ${esc(biz.welcome_ar)},
      ${esc(biz.suggestions_en)}, ${esc(biz.suggestions_ar)},
      ${esc(biz.faq_en)}, ${esc(biz.faq_ar)},
      ${esc(biz.ai_enabled)}, ${esc(biz.franco_enabled)}, ${esc(biz.sourcing_mode)},
      ${esc(biz.active)}, ${esc(biz.created_at || new Date().toISOString())}
    );
  `);
  const inserted = q(`SELECT id FROM businesses WHERE token = ${esc(biz.token)}`);
  businessId = inserted[0].id;
  console.log(`  business: inserted new (id=${businessId})`);
}

// ── 2. Replace service_items ──────────────────────────────────────────────────
if (Array.isArray(items) && items.length) {
  // Build one big transaction: delete then insert all items.
  const lines = [
    'PRAGMA foreign_keys = ON;',
    'BEGIN;',
    `DELETE FROM service_items WHERE business_id = ${businessId};`,
  ];
  for (const item of items) {
    lines.push(
      `INSERT INTO service_items (business_id, service_type, title_en, title_ar, category_en, category_ar, description_en, description_ar, price, currency, metadata, available, created_at) VALUES (` +
      [
        businessId,
        esc(item.service_type || biz.service_type),
        esc(item.title_en),
        esc(item.title_ar),
        esc(item.category_en),
        esc(item.category_ar),
        esc(item.description_en),
        esc(item.description_ar),
        esc(item.price),
        esc(item.currency || 'EGP'),
        esc(item.metadata || '{}'),
        esc(item.available ?? 1),
        esc(item.created_at || new Date().toISOString()),
      ].join(', ') +
      ');'
    );
  }
  lines.push('COMMIT;');
  runSql(lines.join('\n'));
  console.log(`  service_items: replaced with ${items.length} items`);
} else {
  console.log('  service_items: (none in export, skipped)');
}

// ── 3. Upsert brand_profile ───────────────────────────────────────────────────
if (profile && profile.profile_json) {
  runSql(`
    INSERT INTO brand_profiles (business_id, profile_json, source_hash, model, generated_at)
    VALUES (
      ${businessId},
      ${esc(profile.profile_json)},
      ${esc(profile.source_hash)},
      ${esc(profile.model)},
      ${esc(profile.generated_at || new Date().toISOString())}
    )
    ON CONFLICT(business_id) DO UPDATE SET
      profile_json = excluded.profile_json,
      source_hash  = excluded.source_hash,
      model        = excluded.model,
      generated_at = excluded.generated_at;
  `);
  console.log('  brand_profile: upserted');
} else {
  console.log('  brand_profile: (none in export, skipped)');
}

console.log('');
console.log('Import complete.');
