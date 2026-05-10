'use strict';

const { COMMON_RESPONSES } = require('../brains/shared/commonResponses');
const { getBrain } = require('../brains');

const SESSION_TIMEOUT_HOURS = 6;
const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;

function isSessionExpired(lastActive) {
  if (!lastActive) return false;
  const timestamp = Date.parse(`${String(lastActive).replace(' ', 'T')}Z`);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp >= SESSION_TIMEOUT_MS;
}

function buildFreshSessionMessages(business, language) {
  const brain = getBrain(business.service_type);
  return [
    { role: 'bot', content: brain.getWelcomeMessage(business, language), intent: 'welcome' },
    { role: 'bot', content: COMMON_RESPONSES.collect_name[language](), intent: 'collect_name' },
  ];
}

function resetSessionState(db, sessionId, language, business) {
  db.prepare(`
    UPDATE sessions
    SET guest_name = NULL, guest_phone = NULL, language = ?, phase = 'collect_name', context = '{}', last_active = datetime('now')
    WHERE id = ?
  `).run(language, sessionId);

  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

  const insertMessage = db.prepare('INSERT INTO messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)');
  const freshMessages = buildFreshSessionMessages(business, language);
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
