'use strict';

const express = require('express');

const db = require('../../db/db');
const { authMiddleware } = require('../../middleware/auth');
const { invalidateMenuCache } = require('../../engine/intent');
const { readMenuFromSheet } = require('../../services/googleSheets');

const router = express.Router();
router.use(authMiddleware);

function canAccess(admin, cafeId) {
  return admin.role === 'admin' || Number(admin.cafe_id) === Number(cafeId);
}

function parseSizes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

router.get('/:cafeId', (req, res) => {
  const cafeId = Number(req.params.cafeId);
  if (!canAccess(req.admin, cafeId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const items = db.prepare('SELECT * FROM menu_items WHERE cafe_id = ? ORDER BY category_en, name_en').all(cafeId);
  return res.json(items.map((item) => ({ ...item, sizes: parseSizes(item.sizes) })));
});

router.post('/:cafeId', (req, res) => {
  const cafeId = Number(req.params.cafeId);
  if (!canAccess(req.admin, cafeId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const body = req.body || {};
  const result = db.prepare(`
    INSERT INTO menu_items
      (cafe_id, name_en, name_ar, category_en, category_ar, description_en, description_ar, price, currency, sizes, available)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cafeId,
    body.name_en,
    body.name_ar || '',
    body.category_en || '',
    body.category_ar || '',
    body.description_en || '',
    body.description_ar || '',
    body.price ? Number(body.price) : null,
    body.currency || 'EGP',
    JSON.stringify(parseSizes(body.sizes)),
    body.available === false || body.available === 0 ? 0 : 1
  );

  invalidateMenuCache(cafeId);
  return res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/:cafeId/:itemId', (req, res) => {
  const cafeId = Number(req.params.cafeId);
  if (!canAccess(req.admin, cafeId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const body = req.body || {};
  db.prepare(`
    UPDATE menu_items SET
      name_en = ?, name_ar = ?, category_en = ?, category_ar = ?,
      description_en = ?, description_ar = ?, price = ?, currency = ?, sizes = ?, available = ?
    WHERE id = ? AND cafe_id = ?
  `).run(
    body.name_en,
    body.name_ar || '',
    body.category_en || '',
    body.category_ar || '',
    body.description_en || '',
    body.description_ar || '',
    body.price ? Number(body.price) : null,
    body.currency || 'EGP',
    JSON.stringify(parseSizes(body.sizes)),
    body.available === false || body.available === 0 ? 0 : 1,
    req.params.itemId,
    cafeId
  );

  invalidateMenuCache(cafeId);
  return res.json({ success: true });
});

router.delete('/:cafeId/:itemId', (req, res) => {
  const cafeId = Number(req.params.cafeId);
  if (!canAccess(req.admin, cafeId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  db.prepare('DELETE FROM menu_items WHERE id = ? AND cafe_id = ?').run(req.params.itemId, cafeId);
  invalidateMenuCache(cafeId);
  return res.json({ success: true });
});

router.post('/:cafeId/sync', async (req, res) => {
  const cafeId = Number(req.params.cafeId);
  if (!canAccess(req.admin, cafeId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const cafe = db.prepare('SELECT * FROM cafes WHERE id = ?').get(cafeId);
  if (!cafe) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!cafe.sheet_id) {
    return res.status(400).json({ error: 'no_sheet_id' });
  }

  try {
    const items = await readMenuFromSheet(cafe.sheet_id, req.body?.sheet_name || 'Menu');
    const deleteItems = db.prepare('DELETE FROM menu_items WHERE cafe_id = ?');
    const insertItem = db.prepare(`
      INSERT INTO menu_items
        (cafe_id, name_en, name_ar, category_en, category_ar, description_en, description_ar, price, currency, sizes, available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      deleteItems.run(cafeId);
      items.forEach((item) => {
        insertItem.run(
          cafeId,
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
    })();

    invalidateMenuCache(cafeId);
    return res.json({ synced: items.length });
  } catch (error) {
    console.error('[dashboard-menu-sync]', error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
