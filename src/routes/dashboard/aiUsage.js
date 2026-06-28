'use strict';

const express = require('express');

const db = require('../../db/db');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const businessesList = db.prepare('SELECT id, name FROM businesses ORDER BY name ASC');

// GET /dashboard/ai-usage?date=YYYY-MM-DD&business_id=ID
// Lists AI calls for a given day (default today, UTC) with totals.
router.get('/', (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : null;

    let businessId = Number(req.query.business_id) || null;
    // Business-scoped admins can only see their own business.
    if (req.admin && req.admin.role !== 'admin' && req.admin.business_id) {
      businessId = Number(req.admin.business_id);
    }

    const where = ['date(c.created_at) = date(?)'];
    const params = [date || 'now'];
    if (businessId) { where.push('c.business_id = ?'); params.push(businessId); }
    const whereSql = 'WHERE ' + where.join(' AND ');

    const rows = db.prepare(`
      SELECT c.id, c.business_id, b.name AS business_name, c.message, c.mode, c.model,
             c.duration_ms, c.prompt_tokens, c.completion_tokens, c.total_tokens,
             c.cost_usd, c.from_cache, c.created_at
      FROM ai_calls c
      LEFT JOIN businesses b ON b.id = c.business_id
      ${whereSql}
      ORDER BY c.id DESC
      LIMIT 1000
    `).all(...params);

    const totals = db.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(total_tokens), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost,
             COALESCE(SUM(CASE WHEN from_cache = 1 THEN 1 ELSE 0 END), 0) AS cached_calls
      FROM ai_calls c
      ${whereSql}
    `).get(...params);

    res.json({
      date: date || new Date().toISOString().slice(0, 10),
      business_id: businessId,
      businesses: businessesList.all(),
      totals,
      rows,
    });
  } catch (error) {
    console.error('[ai-usage]', error);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /dashboard/ai-usage/:id
// Full detail for one AI call — including the large full_input / full_output
// text columns, which the list query intentionally omits.
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });

    const row = db.prepare(`
      SELECT c.id, c.business_id, b.name AS business_name, c.session_id, c.message, c.mode,
             c.model, c.duration_ms, c.prompt_tokens, c.completion_tokens, c.total_tokens,
             c.cached_tokens, c.cost_usd, c.from_cache, c.full_input, c.full_output, c.created_at
      FROM ai_calls c
      LEFT JOIN businesses b ON b.id = c.business_id
      WHERE c.id = ?
    `).get(id);

    if (!row) return res.status(404).json({ error: 'not_found' });

    // Business-scoped admins can only open their own business's calls.
    if (req.admin && req.admin.role !== 'admin' && req.admin.business_id &&
        Number(row.business_id) !== Number(req.admin.business_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    res.json({ row });
  } catch (error) {
    console.error('[ai-usage:detail]', error);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
