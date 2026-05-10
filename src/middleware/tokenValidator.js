'use strict';

const db = require('../db/db');

const getBusiness = db.prepare('SELECT * FROM businesses WHERE token = ? AND active = 1');

function tokenValidator(req, res, next) {
  const token = req.query.token || req.headers['x-bot-token'] || req.body?.token;

  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  const business = getBusiness.get(token);
  if (!business) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  req.business = business;
  return next();
}

module.exports = { tokenValidator };
