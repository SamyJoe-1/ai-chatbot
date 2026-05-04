'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../../db/db');
const { authMiddleware, signToken } = require('../../middleware/auth');

const router = express.Router();
const findUser = db.prepare('SELECT * FROM admins WHERE username = ?');

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const user = findUser.get(username);
  if (!user) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = signToken({
    id: user.id,
    username: user.username,
    role: user.role,
    cafe_id: user.cafe_id,
  });

  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      cafe_id: user.cafe_id,
    },
  });
});

router.get('/me', authMiddleware, (req, res) => {
  return res.json(req.admin);
});

module.exports = router;
