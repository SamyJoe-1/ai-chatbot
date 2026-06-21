// Quick chat tester (handles UTF-8 / Arabic correctly, unlike bash curl on Windows).
// Usage:  node chat.js "your message here"
//         node chat.js "عايز بيتزا فيها جمبري"
const T = process.env.BOT_TOKEN || '872d67d86f64474ab5fe9330e14375c9';
const U = process.env.BOT_URL || 'http://localhost:3500';
const msg = process.argv.slice(2).join(' ') || 'cheapest pizza';

const post = (p, b) =>
  fetch(U + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

(async () => {
  const { session_key: SK } = await post('/api/init', { token: T });
  await post('/api/message', { token: T, session_key: SK, message: 'Sam' });
  await post('/api/message', { token: T, session_key: SK, message: '01012345678' });
  const r = await post('/api/message', { token: T, session_key: SK, message: msg });
  console.log('You:', msg);
  console.log('Bot [' + r.intent + ']:\n' + (r.response || {}).text);
})().catch((e) => console.error('error:', e.message));
