'use strict';

// Admin system actions. Currently: cache clear — one call flushes every
// in-memory cache in THIS process (catalog items, AI classifications, brand
// profiles, menus, routing signatures) AND the AI service's persistent
// classification cache (cache.db) over HTTP. Run it after editing prompts,
// FAQs, or catalog data in place so no stale reply survives.

const express = require('express');
const { authMiddleware, adminOnly } = require('../../middleware/auth');
const { clearAllCaches } = require('../../brains/shared/catalogStore');
const { clearProfileCache } = require('../../brains/shared/brandProfile');
const { clearMenuCache } = require('../../engine/intent');
const { clearRoutingCaches } = require('../../engine/aiRouting');

const router = express.Router();

function aiServiceBase() {
  const base = process.env.AI_API_URL || process.env.AI_CALLBACK_API_URL || '';
  return base.trim().replace(/\/+$/, '');
}

function aiServiceSecret() {
  return process.env.AI_API_SECRET || process.env.AI_SECRET_KEY || process.env.SECRET_KEY || '';
}

router.post('/cache/clear', authMiddleware, adminOnly, async (req, res) => {
  const local = {
    ...clearAllCaches(),
    brand_profiles: clearProfileCache(),
    menus: clearMenuCache(),
    routing_signatures: clearRoutingCaches(),
  };

  // Also flush the AI service's persistent classify cache, unless the caller
  // asks for local only ({ local_only: true }).
  let aiService = { skipped: true };
  const base = aiServiceBase();
  if (!req.body?.local_only && base && aiServiceSecret()) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${base}/cache/clear`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiServiceSecret()}`,
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      aiService = response.ok
        ? await response.json()
        : { ok: false, error: `status_${response.status}` };
    } catch (error) {
      aiService = { ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
    }
  }

  console.log('[system] cache cleared', { local, ai_service: aiService });
  res.json({ ok: true, local, ai_service: aiService });
});

module.exports = router;
