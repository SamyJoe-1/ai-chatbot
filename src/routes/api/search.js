'use strict';

const express = require('express');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { matchItemsForOrder } = require('../../engine/orderFlow');

const router = express.Router();

router.post('/', tokenValidator, (req, res) => {
  try {
    const business = req.business;
    const { query, lang, context } = req.body || {};

    if (!query || !String(query).trim()) {
      return res.json({ items: [] });
    }

    const matched = matchItemsForOrder({
      text: String(query).trim(),
      lang: lang || 'en',
      businessId: business.id,
      context: context || {},
    });

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
