'use strict';

/**
 * Import a business export file (produced by export-eglobal.js) into any
 * database — local dev or the live production DB.
 *
 * Safe to re-run: matching is by token, so running twice does not duplicate
 * the business. service_items are fully replaced (delete then re-insert)
 * so the catalog is always in sync with the export. brand_profile is upserted.
 *
 * IDs from the export are NOT preserved — new IDs are auto-assigned by the
 * target DB so there are no collisions with other businesses already there.
 *
 * Usage (local DB, default path):
 *   node scripts/import-business.js
 *   node scripts/import-business.js --in data/eglobal-export.json
 *
 * Usage (production DB via env var):
 *   DB_PATH=/path/to/prod/chatbot.db node scripts/import-business.js
 *   DB_PATH=/path/to/prod/chatbot.db node scripts/import-business.js --in /tmp/eglobal-export.json
 */

const path = require('path');
const fs   = require('fs');

const inArg = process.argv.find((a) => a.startsWith('--in='))?.split('=')[1]
           || (process.argv.indexOf('--in') !== -1
               ? process.argv[process.argv.indexOf('--in') + 1]
               : null);
const inPath = inArg ? path.resolve(inArg) : path.join(process.cwd(), 'data', 'eglobal-export.json');

if (!fs.existsSync(inPath)) {
  console.error(`Export file not found: ${inPath}`);
  console.error('Run  node scripts/export-eglobal.js  first to create it.');
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

// Load DB after reading the file so DB_PATH env var has been set by the caller.
const db = require('../src/db/db');

console.log(`Importing "${biz.name}" from ${inPath}`);
console.log(`  target DB: ${process.env.DB_PATH || 'data/chatbot.db (default)'}`);
console.log(`  items: ${(items || []).length} | brand_profile: ${profile ? 'yes' : 'none'}`);
console.log('');

// ── 1. Upsert business ─────────────────────────────────────────────────────
const existing = db.prepare('SELECT id FROM businesses WHERE token = ?').get(biz.token);

let businessId;

if (existing) {
  // Update all fields except id and token (token is the key we matched on).
  db.prepare(`
    UPDATE businesses SET
      service_type = ?, name = ?, name_ar = ?, primary_color = ?, secondary_color = ?,
      logo_url = ?, about_en = ?, about_ar = ?, phone = ?, email = ?,
      address_en = ?, address_ar = ?, working_hours_en = ?, working_hours_ar = ?,
      catalog_link = ?, contact_link = ?, drive_folder_id = ?, sheet_id = ?, sheet_name = ?,
      welcome_en = ?, welcome_ar = ?, suggestions_en = ?, suggestions_ar = ?,
      faq_en = ?, faq_ar = ?, ai_enabled = ?, franco_enabled = ?, sourcing_mode = ?, active = ?
    WHERE id = ?
  `).run(
    biz.service_type, biz.name, biz.name_ar, biz.primary_color, biz.secondary_color,
    biz.logo_url, biz.about_en, biz.about_ar, biz.phone, biz.email,
    biz.address_en, biz.address_ar, biz.working_hours_en, biz.working_hours_ar,
    biz.catalog_link, biz.contact_link, biz.drive_folder_id, biz.sheet_id, biz.sheet_name,
    biz.welcome_en, biz.welcome_ar, biz.suggestions_en, biz.suggestions_ar,
    biz.faq_en, biz.faq_ar, biz.ai_enabled, biz.franco_enabled, biz.sourcing_mode, biz.active,
    existing.id,
  );
  businessId = existing.id;
  console.log(`  business: updated existing (id=${businessId})`);
} else {
  // Insert new — let the DB auto-assign a new id.
  const result = db.prepare(`
    INSERT INTO businesses (
      token, service_type, name, name_ar, primary_color, secondary_color,
      logo_url, about_en, about_ar, phone, email,
      address_en, address_ar, working_hours_en, working_hours_ar,
      catalog_link, contact_link, drive_folder_id, sheet_id, sheet_name,
      welcome_en, welcome_ar, suggestions_en, suggestions_ar,
      faq_en, faq_ar, ai_enabled, franco_enabled, sourcing_mode, active, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    biz.token, biz.service_type, biz.name, biz.name_ar, biz.primary_color, biz.secondary_color,
    biz.logo_url, biz.about_en, biz.about_ar, biz.phone, biz.email,
    biz.address_en, biz.address_ar, biz.working_hours_en, biz.working_hours_ar,
    biz.catalog_link, biz.contact_link, biz.drive_folder_id, biz.sheet_id, biz.sheet_name,
    biz.welcome_en, biz.welcome_ar, biz.suggestions_en, biz.suggestions_ar,
    biz.faq_en, biz.faq_ar, biz.ai_enabled, biz.franco_enabled, biz.sourcing_mode, biz.active,
    biz.created_at || new Date().toISOString(),
  );
  businessId = result.lastInsertRowid;
  console.log(`  business: inserted new (id=${businessId})`);
}

// ── 2. Replace service_items ───────────────────────────────────────────────
if (Array.isArray(items) && items.length) {
  const del = db.prepare('DELETE FROM service_items WHERE business_id = ?');
  const ins = db.prepare(`
    INSERT INTO service_items (
      business_id, service_type, title_en, title_ar, category_en, category_ar,
      description_en, description_ar, price, currency, metadata, available, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const runImport = db.transaction(() => {
    del.run(businessId);
    for (const item of items) {
      ins.run(
        businessId,
        item.service_type || biz.service_type,
        item.title_en,
        item.title_ar || null,
        item.category_en || null,
        item.category_ar || null,
        item.description_en || null,
        item.description_ar || null,
        item.price ?? null,
        item.currency || 'EGP',
        item.metadata || '{}',
        item.available ?? 1,
        item.created_at || new Date().toISOString(),
      );
    }
  });

  runImport();
  console.log(`  service_items: replaced with ${items.length} items`);
} else {
  console.log('  service_items: (none in export, skipped)');
}

// ── 3. Upsert brand_profile ────────────────────────────────────────────────
if (profile && profile.profile_json) {
  db.prepare(`
    INSERT INTO brand_profiles (business_id, profile_json, source_hash, model, generated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(business_id) DO UPDATE SET
      profile_json = excluded.profile_json,
      source_hash  = excluded.source_hash,
      model        = excluded.model,
      generated_at = excluded.generated_at
  `).run(
    businessId,
    profile.profile_json,
    profile.source_hash || null,
    profile.model || null,
    profile.generated_at || new Date().toISOString(),
  );
  console.log('  brand_profile: upserted');
} else {
  console.log('  brand_profile: (none in export, skipped)');
}

console.log('');
console.log('Import complete.');
