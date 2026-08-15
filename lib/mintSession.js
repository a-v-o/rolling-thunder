const sessions = new Map();

export function startSession(chatId, type) {
  const session = { step: "wallet", type: type };
  sessions.set(chatId, session);
  return session;
}

export function getSession(chatId) {
  return sessions.get(chatId);
}

export function clearSession(chatId) {
  sessions.delete(chatId);
}
