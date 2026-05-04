'use strict';

const db = require('../db/db');

const getCafe = db.prepare('SELECT * FROM cafes WHERE token = ? AND active = 1');

function tokenValidator(req, res, next) {
  const token = req.query.token || req.headers['x-bot-token'] || req.body?.token;

  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  const cafe = getCafe.get(token);
  if (!cafe) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  req.cafe = cafe;
  return next();
}

module.exports = { tokenValidator };
