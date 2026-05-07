'use strict';

const { RESPONSES } = require('./patterns');

const SESSION_TIMEOUT_HOURS = 6;
const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;

function isSessionExpired(lastActive) {
  if (!lastActive) return false;
  const timestamp = Date.parse(`${String(lastActive).replace(' ', 'T')}Z`);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp >= SESSION_TIMEOUT_MS;
}

function buildFreshSessionMessages(cafe, language) {
  return [
    { role: 'bot', content: RESPONSES.welcome[language](cafe), intent: 'welcome' },
    { role: 'bot', content: RESPONSES.collect_name[language](), intent: 'collect_name' },
  ];
}

function resetSessionState(db, sessionId, language, cafe) {
  db.prepare(`
    UPDATE sessions
    SET guest_name = NULL, guest_phone = NULL, language = ?, phase = 'collect_name', context = '{}', last_active = datetime('now')
    WHERE id = ?
  `).run(language, sessionId);

  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

  const insertMessage = db.prepare('INSERT INTO messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)');
  const freshMessages = buildFreshSessionMessages(cafe, language);
  freshMessages.forEach((message) => {
    insertMessage.run(sessionId, message.role, message.content, message.intent);
  });

  return freshMessages;
}

module.exports = {
  SESSION_TIMEOUT_HOURS,
  buildFreshSessionMessages,
  isSessionExpired,
  resetSessionState,
};
