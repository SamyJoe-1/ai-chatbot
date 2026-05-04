'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

require('./src/db/db');

const app = express();
const PORT = Number(process.env.PORT || 3500);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan('dev'));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'chatbot-e-glotech',
    dashboard: '/dashboard',
    health: '/health',
    widget: '/widget.js?token=YOUR_TOKEN',
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/widget.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'widget.js'));
});

app.use('/api/init', chatLimiter, require('./src/routes/api/init'));
app.use('/api/message', chatLimiter, require('./src/routes/api/message'));
app.use('/api/sync', require('./src/routes/api/sync'));

app.use('/dashboard/auth', require('./src/routes/dashboard/auth'));
app.use('/dashboard/cafes', require('./src/routes/dashboard/cafes'));
app.use('/dashboard/menu', require('./src/routes/dashboard/menu'));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

app.get('/dashboard/*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(500).json({ error: 'server_error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Chatbot backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;
