'use strict';

// One-time brand profile generation.
//
// This runs RARELY — when a business syncs its menu, or an admin clicks
// "Regenerate" — NOT on customer messages. It asks the AI service (profile mode)
// to distill the brand + full catalog into a compact concept map, validates the
// result against the real catalog, and stores it. From then on the map is
// consumed locally (see brains/shared/brandProfile.js) at zero token cost.

const crypto = require('crypto');

const db = require('../db/db');
const { getBusinessItems } = require('../brains/shared/catalogStore');
const { saveBrandProfile, getBrandProfileMeta } = require('../brains/shared/brandProfile');
const { normalize } = require('./detector');

const PROFILE_TIMEOUT_MS = Number(process.env.AI_PROFILE_TIMEOUT_MS || 30000);

function getAiApiUrl() {
  const base = process.env.AI_API_URL || process.env.AI_CALLBACK_API_URL || '';
  if (!base.trim()) return '';
  return base.replace(/\/+$/, '') + '/chat';
}

function getAiSecret() {
  return process.env.AI_API_SECRET || process.env.AI_SECRET_KEY || process.env.SECRET_KEY || '';
}

function isAiConfigured() {
  return Boolean(getAiApiUrl()) && Boolean(getAiSecret());
}

// The exact brand + catalog snapshot we hand the AI. Kept lean: only the fields
// that inform identity/concepts, so the one-time prompt stays as small as it can.
function gatherProfileSource(business) {
  const items = getBusinessItems(business.id).map((item) => ({
    id: item.id,
    title_en: item.title_en || '',
    title_ar: item.title_ar || '',
    category_en: item.category_en || '',
    category_ar: item.category_ar || '',
    description_en: item.description_en || '',
    description_ar: item.description_ar || '',
    price: item.price,
  }));

  return {
    brand: {
      name: business.name || '',
      name_ar: business.name_ar || '',
      about_en: business.about_en || '',
      about_ar: business.about_ar || '',
      service_type: business.service_type || 'cafe',
    },
    categories: [...new Set(items.map((i) => i.category_en || i.category_ar).filter(Boolean))],
    items,
  };
}

function computeSourceHash(source) {
  return crypto.createHash('sha1').update(JSON.stringify(source)).digest('hex');
}

// Pull a JSON object out of the model reply, tolerating ```json fences or stray
// prose around it. Returns null if nothing parseable is found.
function extractJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Keep only concept->title mappings that point at REAL catalog items. This drops
// any title the model paraphrased or invented, so the stored map can only ever
// resolve to items that actually exist.
function sanitizeProfile(parsed, items) {
  const titleIndex = new Map();
  items.forEach((item) => {
    [item.title_en, item.title_ar].forEach((t) => {
      const norm = normalize(String(t || ''), 'en');
      if (norm) titleIndex.set(norm, item.title_en || item.title_ar);
    });
  });

  const concepts = {};
  const rawConcepts = parsed && parsed.concepts && typeof parsed.concepts === 'object' ? parsed.concepts : {};
  for (const [key, titles] of Object.entries(rawConcepts)) {
    if (!key || !Array.isArray(titles)) continue;
    const resolved = [];
    const seen = new Set();
    titles.forEach((title) => {
      const norm = normalize(String(title || ''), 'en');
      const canonical = titleIndex.get(norm);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        resolved.push(canonical);
      }
    });
    if (resolved.length) concepts[key] = resolved;
  }

  return {
    identity: typeof parsed?.identity === 'string' ? parsed.identity.slice(0, 400) : '',
    concepts,
    item_keywords: {},
  };
}

async function callProfileGeneration(business, source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const response = await fetch(getAiApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAiSecret()}`,
      },
      body: JSON.stringify({
        prompt: 'Generate the brand concept map as specified.',
        mode: 'profile',
        service_type: business.service_type || 'cafe',
        stream: false,
        ...(process.env.AI_PROFILE_MODEL ? { model: process.env.AI_PROFILE_MODEL } : (process.env.AI_MODEL ? { model: process.env.AI_MODEL } : {})),
        temperature: Number(process.env.AI_PROFILE_TEMPERATURE || 0.2),
        max_tokens: Number(process.env.AI_PROFILE_MAX_TOKENS || 1800),
        source_data: source,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `status_${response.status}` };
    const data = await response.json();
    return { ok: true, raw: String(data.response || ''), model: data.model || null, usage: data.usage || null };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

// Generate (or refresh) a business's brand profile. Skips the AI call when the
// brand + catalog are unchanged since the last generation, unless force=true.
// Returns a small status object; never throws (callers can fire-and-forget).
async function generateBrandProfile(business, { force = false } = {}) {
  try {
    if (!isAiConfigured()) return { ok: false, skipped: true, reason: 'ai_not_configured' };

    const source = gatherProfileSource(business);
    if (!source.items.length) return { ok: false, skipped: true, reason: 'no_items' };

    const hash = computeSourceHash(source);
    if (!force) {
      const meta = getBrandProfileMeta(business.id);
      if (meta && meta.source_hash === hash) {
        return { ok: true, skipped: true, reason: 'unchanged' };
      }
    }

    const result = await callProfileGeneration(business, source);
    if (!result.ok) {
      console.warn('[brand-profile] generation failed', { businessId: business.id, error: result.error });
      return { ok: false, error: result.error };
    }

    const parsed = extractJson(result.raw);
    if (!parsed) {
      console.warn('[brand-profile] could not parse JSON', { businessId: business.id });
      return { ok: false, error: 'unparseable' };
    }

    const profile = sanitizeProfile(parsed, source.items);
    saveBrandProfile(business.id, { profile, sourceHash: hash, model: result.model });
    db.checkpoint();
    const conceptCount = Object.keys(profile.concepts).length;
    console.log('[brand-profile] generated', { businessId: business.id, concepts: conceptCount, model: result.model });
    return { ok: true, concepts: conceptCount, model: result.model };
  } catch (error) {
    console.warn('[brand-profile] unexpected error', { businessId: business.id, error: error.message });
    return { ok: false, error: error.message };
  }
}

module.exports = {
  gatherProfileSource,
  computeSourceHash,
  generateBrandProfile,
  isAiConfigured,
};
