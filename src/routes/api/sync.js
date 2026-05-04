'use strict';

const express = require('express');

const db = require('../../db/db');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { readMenuFromSheet } = require('../../services/googleSheets');
const { invalidateMenuCache } = require('../../engine/intent');

const router = express.Router();

const deleteItems = db.prepare('DELETE FROM menu_items WHERE cafe_id = ?');
const insertItem = db.prepare(`
  INSERT INTO menu_items
    (cafe_id, name_en, name_ar, category_en, category_ar, description_en, description_ar, price, currency, sizes, available)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

router.post('/', tokenValidator, async (req, res) => {
  const cafe = req.cafe;

  if (!cafe.sheet_id) {
    return res.status(400).json({ error: 'no_sheet_id' });
  }

  try {
    const items = await readMenuFromSheet(cafe.sheet_id, req.body?.sheet_name || 'Menu');
    if (!items.length) {
      return res.json({ synced: 0, message: 'No rows found in the sheet.' });
    }

    const transaction = db.transaction(() => {
      deleteItems.run(cafe.id);
      items.forEach((item) => {
        insertItem.run(
          cafe.id,
          item.name_en,
          item.name_ar,
          item.category_en,
          item.category_ar,
          item.description_en,
          item.description_ar,
          item.price,
          item.currency,
          item.sizes,
          item.available
        );
      });
    });

    transaction();
    invalidateMenuCache(cafe.id);

    return res.json({ synced: items.length, message: `Synced ${items.length} menu items.` });
  } catch (error) {
    console.error('[sync]', error);
    return res.status(500).json({ error: 'sync_failed', message: error.message });
  }
});

module.exports = router;
