'use strict';

// Per-IP and per-device AI rate limiting. Protects the AI balance: even if a
// hacker rotates sessions, the IP cap catches them; even behind a shared IP,
// the device (session) cap keeps one client from abusing the budget.
// Over the limit, the caller simply skips AI and answers from rules.

const db = require('../db/db');

const PER_HOUR = Number(process.env.AI_RATE_PER_HOUR || 30);
const PER_DAY = Number(process.env.AI_RATE_PER_DAY || 150);

const countStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM ai_usage
  WHERE business_id = ? AND scope = ? AND identifier = ?
    AND created_at >= datetime('now', ?)
`);
const insertStmt = db.prepare(`
  INSERT INTO ai_usage (business_id, scope, identifier) VALUES (?, ?, ?)
`);
const pruneStmt = db.prepare("DELETE FROM ai_usage WHERE created_at < datetime('now', '-2 days')");

let lastPruneAt = 0;
function maybePrune() {
  const now = Date.now();
  if (now - lastPruneAt > 60 * 60 * 1000) {
    lastPruneAt = now;
    try { pruneStmt.run(); } catch { /* non-fatal */ }
  }
}

function countWindow(businessId, scope, identifier, sqlInterval) {
  try {
    const row = countStmt.get(businessId, scope, identifier, sqlInterval);
    return row ? Number(row.n) : 0;
  } catch {
    return 0;
  }
}

function checkScope(businessId, scope, identifier) {
  if (!identifier) return { allowed: true };
  if (PER_HOUR > 0 && countWindow(businessId, scope, identifier, '-1 hour') >= PER_HOUR) {
    return { allowed: false, reason: `${scope}_hourly` };
  }
  if (PER_DAY > 0 && countWindow(businessId, scope, identifier, '-1 day') >= PER_DAY) {
    return { allowed: false, reason: `${scope}_daily` };
  }
  return { allowed: true };
}

// Returns { allowed: true } or { allowed: false, reason }.
function canUseAi({ businessId, ip, deviceId }) {
  if (PER_HOUR <= 0 && PER_DAY <= 0) return { allowed: true };
  const ipCheck = checkScope(businessId, 'ip', ip);
  if (!ipCheck.allowed) return ipCheck;
  return checkScope(businessId, 'device', deviceId);
}

// Log one AI call against both the IP and the device buckets.
function recordAiUse({ businessId, ip, deviceId }) {
  maybePrune();
  if (ip) { try { insertStmt.run(businessId, 'ip', ip); } catch { /* non-fatal */ } }
  if (deviceId) { try { insertStmt.run(businessId, 'device', deviceId); } catch { /* non-fatal */ } }
}

module.exports = {
  canUseAi,
  recordAiUse,
  AI_RATE_PER_HOUR: PER_HOUR,
  AI_RATE_PER_DAY: PER_DAY,
};
