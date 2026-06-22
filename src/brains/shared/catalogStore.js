'use strict';

const db = require('../../db/db');

const itemCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getBusinessItems(businessId) {
  const cacheKey = Number(businessId);
  const cached = itemCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.items;
  }

  const items = db.prepare('SELECT * FROM service_items WHERE business_id = ? AND available = 1 ORDER BY id ASC').all(cacheKey)
    .map((item) => ({ ...item, metadata: parseMetadata(item.metadata) }));

  itemCache.set(cacheKey, { items, ts: Date.now() });
  return items;
}

// --- AI classification cache -------------------------------------------------
// The external AI classifier is deterministic for a given question + catalog:
// the same message always maps to the same pipeline string ("[2] searching for
// wifi ...") until the catalog changes. We cache that raw string per business so
// an identical question never re-bills the AI. Context-dependent follow-ups are
// NOT cached (the caller passes cacheable=false), and the whole cache for a
// business is cleared on sync alongside the item cache.
const classifyCache = new Map(); // businessId -> Map<key, { raw, ts }>
const CLASSIFY_TTL = 30 * 60 * 1000;

function getCachedClassification(businessId, key) {
  const perBusiness = classifyCache.get(Number(businessId));
  if (!perBusiness) return null;
  const hit = perBusiness.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts >= CLASSIFY_TTL) {
    perBusiness.delete(key);
    return null;
  }
  return hit.raw;
}

function setCachedClassification(businessId, key, raw) {
  if (!key || !raw) return;
  const id = Number(businessId);
  let perBusiness = classifyCache.get(id);
  if (!perBusiness) {
    perBusiness = new Map();
    classifyCache.set(id, perBusiness);
  }
  perBusiness.set(key, { raw, ts: Date.now() });
}

function invalidateBusinessItemsCache(businessId) {
  itemCache.delete(Number(businessId));
  classifyCache.delete(Number(businessId));
}

module.exports = {
  getBusinessItems,
  invalidateBusinessItemsCache,
  getCachedClassification,
  setCachedClassification,
  parseMetadata,
};
