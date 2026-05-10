'use strict';

const express = require('express');

const db = require('../../db/db');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { readRecordsFromSheet } = require('../../services/googleSheets');
const { invalidateBusinessItemsCache } = require('../../brains/shared/catalogStore');
const { getBrain } = require('../../brains');

const router = express.Router();

const deleteItems = db.prepare('DELETE FROM service_items WHERE business_id = ?');
const insertItem = db.prepare(`
  INSERT INTO service_items
    (business_id, service_type, title_en, title_ar, category_en, category_ar, description_en, description_ar, price, currency, metadata, available)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

router.post('/', tokenValidator, async (req, res) => {
  const business = req.business;
  const brain = getBrain(business.service_type);

  if (!business.sheet_id) {
    return res.status(400).json({ error: 'no_sheet_id' });
  }

  try {
    const sheetName = req.body?.sheet_name || business.sheet_name || brain.defaultSheetName;
    const records = await readRecordsFromSheet(business.sheet_id, sheetName);
    const items = brain.mapSheetRecords(records);

    if (!items.length) {
      return res.json({ synced: 0, message: 'No rows found in the sheet.' });
    }

    const transaction = db.transaction(() => {
      deleteItems.run(business.id);
      items.forEach((item) => {
        insertItem.run(
          business.id,
          business.service_type,
          item.title_en,
          item.title_ar,
          item.category_en,
          item.category_ar,
          item.description_en,
          item.description_ar,
          item.price,
          item.currency,
          item.metadata,
          item.available
        );
      });
    });

    transaction();
    invalidateBusinessItemsCache(business.id);

    return res.json({ synced: items.length, message: `Synced ${items.length} catalog items.` });
  } catch (error) {
    console.error('[sync]', error);
    return res.status(500).json({ error: 'sync_failed', message: error.message });
  }
});

module.exports = router;
