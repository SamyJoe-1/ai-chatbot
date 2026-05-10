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

function invalidateBusinessItemsCache(businessId) {
  itemCache.delete(Number(businessId));
}

module.exports = {
  getBusinessItems,
  invalidateBusinessItemsCache,
  parseMetadata,
};
