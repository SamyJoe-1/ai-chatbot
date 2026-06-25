'use strict';

// Brand profile store + local consumption helpers.
//
// A brand profile is a compact JSON artifact generated ONCE per menu sync (see
// engine/brandProfile.js) and consumed here at query time with pure string math
// — no AI call, no tokens. Its job is to bridge the gap between "the customer
// asked for a concept" ("something from the sea") and "the catalog only lists
// concrete items" ("Shrimp", "Calamari"). The classifier never sees the menu,
// so this local map is what makes conceptual search work for free.
//
// profile_json shape:
// {
//   "identity": "short brand summary (used as a brand_info fallback)",
//   "concepts": {
//     "sea|seafood|ocean|بحري": ["Shrimp Napolitana Pizza", "Tuna Melt"],
//     "spicy|حار": ["Buffalo Wings"]
//   },
//   "item_keywords": { "<itemId>": ["seafood", "prawn", "ocean"] }
// }

const db = require('../../db/db');
const { normalize, tokenize } = require('../../engine/detector');

const profileCache = new Map(); // businessId -> { profile, ts }
const CACHE_TTL = 5 * 60 * 1000;

const EMPTY_PROFILE = { identity: '', concepts: {}, item_keywords: {} };

const selectStmt = db.prepare('SELECT profile_json, source_hash, model, generated_at FROM brand_profiles WHERE business_id = ?');
const upsertStmt = db.prepare(`
  INSERT INTO brand_profiles (business_id, profile_json, source_hash, model, generated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(business_id) DO UPDATE SET
    profile_json = excluded.profile_json,
    source_hash = excluded.source_hash,
    model = excluded.model,
    generated_at = excluded.generated_at
`);

function parseProfile(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_PROFILE };
    return {
      identity: typeof parsed.identity === 'string' ? parsed.identity : '',
      concepts: parsed.concepts && typeof parsed.concepts === 'object' ? parsed.concepts : {},
      item_keywords: parsed.item_keywords && typeof parsed.item_keywords === 'object' ? parsed.item_keywords : {},
    };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

// Cached read of the parsed profile object. Always returns a usable shape, even
// when no profile has been generated yet (empty concepts -> expansion is a no-op).
function getBrandProfile(businessId) {
  const id = Number(businessId);
  const cached = profileCache.get(id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.profile;

  const row = selectStmt.get(id);
  const profile = row ? parseProfile(row.profile_json) : { ...EMPTY_PROFILE };
  profileCache.set(id, { profile, ts: Date.now() });
  return profile;
}

// Raw row read (no cache) — used by the generator to compare source_hash and by
// the admin UI to show generated_at / model.
function getBrandProfileMeta(businessId) {
  const row = selectStmt.get(Number(businessId));
  if (!row) return null;
  return {
    profile: parseProfile(row.profile_json),
    source_hash: row.source_hash || null,
    model: row.model || null,
    generated_at: row.generated_at || null,
  };
}

function saveBrandProfile(businessId, { profile, sourceHash = null, model = null }) {
  const safe = parseProfile(typeof profile === 'string' ? profile : JSON.stringify(profile || {}));
  upsertStmt.run(Number(businessId), JSON.stringify(safe), sourceHash, model);
  profileCache.delete(Number(businessId));
  return safe;
}

function invalidateBrandProfileCache(businessId) {
  profileCache.delete(Number(businessId));
}

// --- Local consumption ------------------------------------------------------
// A concept key may bundle several synonyms with "|": "sea|seafood|ocean|بحري".
// Split and normalize them once per language so matching is cheap.
function conceptSynonyms(key, lang) {
  return String(key || '')
    .split('|')
    .map((part) => normalize(part.trim(), lang))
    .filter(Boolean);
}

// Does the (already-normalized) query mention any synonym of this concept?
// Whole-word/token match for short synonyms, substring for multi-word ones, so
// "sea" never fires inside "season" but "ice cream" still matches as a phrase.
function queryMentionsConcept(queryNorm, queryTokens, synonyms) {
  return synonyms.some((syn) => {
    if (!syn) return false;
    if (syn.includes(' ')) return queryNorm.includes(syn);
    return queryTokens.includes(syn);
  });
}

// Resolve a query through the concept map to the catalog items it implies.
// Returns matched item objects (deduped, original order). Empty when the profile
// is empty or nothing matches — callers treat that as "no concept hit" and fall
// back to their normal matching. Pure string work: zero AI, zero tokens.
function conceptMatchItems({ text, lang, items, profile }) {
  const concepts = profile && profile.concepts;
  if (!concepts || !items || !items.length) return [];

  const queryNorm = normalize(text, lang);
  if (!queryNorm) return [];
  const queryTokens = tokenize(queryNorm);

  // Collect the set of target item titles implied by every matched concept.
  const wantedTitles = new Set();
  for (const [key, titles] of Object.entries(concepts)) {
    if (!Array.isArray(titles) || !titles.length) continue;
    if (queryMentionsConcept(queryNorm, queryTokens, conceptSynonyms(key, lang))) {
      titles.forEach((title) => {
        const norm = normalize(String(title || ''), lang);
        if (norm) wantedTitles.add(norm);
      });
    }
  }
  if (!wantedTitles.size) return [];

  // Map wanted titles back to live catalog items (match either language title).
  return items.filter((item) => {
    const en = normalize(item.title_en || '', lang);
    const ar = normalize(item.title_ar || '', lang);
    return (en && wantedTitles.has(en)) || (ar && wantedTitles.has(ar));
  });
}

module.exports = {
  EMPTY_PROFILE,
  getBrandProfile,
  getBrandProfileMeta,
  saveBrandProfile,
  invalidateBrandProfileCache,
  conceptMatchItems,
};
