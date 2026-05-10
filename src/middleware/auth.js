'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'change-me-now';

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    req.admin = jwt.verify(header.slice(7), SECRET);
    if (req.admin && req.admin.business_id === undefined && req.admin.cafe_id !== undefined) {
      req.admin.business_id = req.admin.cafe_id;
    }
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function adminOnly(req, res, next) {
  if (req.admin?.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  return next();
}

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '12h' });
}

module.exports = { authMiddleware, adminOnly, signToken };
