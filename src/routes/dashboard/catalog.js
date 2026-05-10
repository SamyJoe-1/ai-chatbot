'use strict';

const express = require('express');

const db = require('../../db/db');
const { authMiddleware } = require('../../middleware/auth');
const { invalidateBusinessItemsCache, parseMetadata } = require('../../brains/shared/catalogStore');
const { readRecordsFromSheet } = require('../../services/googleSheets');
const { getBrain } = require('../../brains');

const router = express.Router();
router.use(authMiddleware);

function canAccess(admin, businessId) {
  return admin.role === 'admin' || Number(admin.business_id) === Number(businessId);
}

function serializeItem(item) {
  return {
    ...item,
    metadata: parseMetadata(item.metadata),
  };
}

router.get('/:businessId', (req, res) => {
  const businessId = Number(req.params.businessId);
  if (!canAccess(req.admin, businessId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const items = db.prepare('SELECT * FROM service_items WHERE business_id = ? ORDER BY category_en, title_en').all(businessId);
  return res.json(items.map(serializeItem));
});

router.post('/:businessId', (req, res) => {
  const businessId = Number(req.params.businessId);
  if (!canAccess(req.admin, businessId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) {
    return res.status(404).json({ error: 'not_found' });
  }

  const body = req.body || {};
  const metadata = typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata || {});
  const result = db.prepare(`
    INSERT INTO service_items
      (business_id, service_type, title_en, title_ar, category_en, category_ar, description_en, description_ar, price, currency, metadata, available)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    businessId,
    business.service_type,
    body.title_en,
    body.title_ar || '',
    body.category_en || '',
    body.category_ar || '',
    body.description_en || '',
    body.description_ar || '',
    body.price ? Number(body.price) : null,
    body.currency || 'EGP',
    metadata,
    body.available === false || body.available === 0 ? 0 : 1
  );

  invalidateBusinessItemsCache(businessId);
  return res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/:businessId/:itemId', (req, res) => {
  const businessId = Number(req.params.businessId);
  if (!canAccess(req.admin, businessId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const body = req.body || {};
  const metadata = typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata || {});
  db.prepare(`
    UPDATE service_items SET
      title_en = ?, title_ar = ?, category_en = ?, category_ar = ?,
      description_en = ?, description_ar = ?, price = ?, currency = ?, metadata = ?, available = ?
    WHERE id = ? AND business_id = ?
  `).run(
    body.title_en,
    body.title_ar || '',
    body.category_en || '',
    body.category_ar || '',
    body.description_en || '',
    body.description_ar || '',
    body.price ? Number(body.price) : null,
    body.currency || 'EGP',
    metadata,
    body.available === false || body.available === 0 ? 0 : 1,
    req.params.itemId,
    businessId
  );

  invalidateBusinessItemsCache(businessId);
  return res.json({ success: true });
});

router.delete('/:businessId/:itemId', (req, res) => {
  const businessId = Number(req.params.businessId);
  if (!canAccess(req.admin, businessId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  db.prepare('DELETE FROM service_items WHERE id = ? AND business_id = ?').run(req.params.itemId, businessId);
  invalidateBusinessItemsCache(businessId);
  return res.json({ success: true });
});

router.post('/:businessId/sync', async (req, res) => {
  const businessId = Number(req.params.businessId);
  if (!canAccess(req.admin, businessId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!business.sheet_id) {
    return res.status(400).json({ error: 'no_sheet_id' });
  }

  try {
    const brain = getBrain(business.service_type);
    const sheetName = req.body?.sheet_name || business.sheet_name || brain.defaultSheetName;
    const records = await readRecordsFromSheet(business.sheet_id, sheetName);
    const items = brain.mapSheetRecords(records);
    const deleteItems = db.prepare('DELETE FROM service_items WHERE business_id = ?');
    const insertItem = db.prepare(`
      INSERT INTO service_items
        (business_id, service_type, title_en, title_ar, category_en, category_ar, description_en, description_ar, price, currency, metadata, available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      deleteItems.run(businessId);
      items.forEach((item) => {
        insertItem.run(
          businessId,
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
    })();

    invalidateBusinessItemsCache(businessId);
    return res.json({ synced: items.length });
  } catch (error) {
    console.error('[dashboard-catalog-sync]', error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
