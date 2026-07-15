'use strict';

// One-command production cache clear. Run ON the server host:
//   npm run clear-cache
// Signs a short-lived admin JWT with the local JWT_SECRET and calls the
// running server's /dashboard/system/cache/clear — which flushes every
// in-memory cache AND the AI service's persistent classify cache (cache.db).
// Requires the chatbot server to be running (the caches live in its process).

require('dotenv').config();
const { signToken } = require('../src/middleware/auth');

const port = process.env.PORT || 3500;
const base = process.env.CACHE_CLEAR_BASE_URL || `http://localhost:${port}`;
const token = signToken({ id: 0, role: 'admin', username: 'clear-cache-cli' });

(async () => {
  try {
    const response = await fetch(`${base}/dashboard/system/cache/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) {
      console.error('FAILED:', response.status, JSON.stringify(body));
      process.exit(1);
    }
    console.log('Caches cleared.');
    console.log('  chatbot (in-memory):', JSON.stringify(body.local));
    console.log('  ai service (cache.db):', JSON.stringify(body.ai_service));
  } catch (error) {
    console.error(`FAILED: ${error.message} — is the server running on ${base}?`);
    process.exit(1);
  }
})();
