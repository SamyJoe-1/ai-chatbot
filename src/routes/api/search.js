'use strict';

const express = require('express');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { matchItemsForOrder } = require('../../engine/orderFlow');
const { searchCatalogItems } = require('../../brains/shared/matcher');
const { getBusinessItems } = require('../../brains/shared/catalogStore');

const router = express.Router();

router.post('/', tokenValidator, (req, res) => {
  try {
    const business = req.business;
    const { query, lang, context } = req.body || {};

    const text = String(query || '').trim();
    if (!text) {
      return res.json({ items: [] });
    }

    const containsArabic = /[؀-ۿ]/.test(text);
    const activeLang = containsArabic ? 'ar' : (lang || 'en');

    // Primary: tiered local search (exact > prefix > substring > token > typo).
    // This handles incremental typing and small typos accurately. Safe to rank
    // loosely — the user only ever adds an item they click, always by exact title.
    let matched = searchCatalogItems({
      text,
      lang: activeLang,
      items: getBusinessItems(business.id),
      limit: 10,
    });

    // Fallback: the full chat matcher adds Franco ("2ahwa" -> قهوة) and Arabic
    // dictionary recovery that the tiered scorer can't do on its own.
    if (!matched.length) {
      matched = matchItemsForOrder({
        text,
        lang: activeLang,
        businessId: business.id,
        context: context || {},
      });
    }

    // Limit to top 10 items as requested
    const items = matched.slice(0, 10).map((item) => ({
      id: item.id,
      title_en: item.title_en,
      title_ar: item.title_ar,
      price: item.price,
      currency: item.currency || 'EGP',
    }));

    return res.json({ items });
  } catch (error) {
    console.error('[api-search]', error);
    return res.status(500).json({ error: 'search_failed' });
  }
});

module.exports = router;
