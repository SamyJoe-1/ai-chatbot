require('dotenv').config();
const db = require('./src/db/db');
const q = (s, ...a) => { try { return db.prepare(s).all(...a); } catch (e) { return [{ err: e.message }]; } };

console.log('businesses ai_enabled:', JSON.stringify(q(
  "SELECT id, name, ai_enabled, service_type FROM businesses")));

const url = (process.env.AI_API_URL || process.env.AI_CALLBACK_API_URL || '').trim();
const secret = (process.env.AI_API_SECRET || process.env.AI_SECRET_KEY || process.env.SECRET_KEY || '').trim();
console.log('AI_API_URL set?:', Boolean(url), url ? '(' + url + ')' : '');
console.log('AI secret set?:', Boolean(secret));
console.log('=> isAiEnabledForBusiness needs: ai_enabled===1 AND url AND secret');
