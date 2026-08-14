const sessions = new Map();

export function startMintSession(chatId, initialStep = "chain") {
  const session = { step: initialStep };
  sessions.set(chatId, session);
  return session;
}

export function getMintSession(chatId) {
  return sessions.get(chatId);
}

export function clearMintSession(chatId) {
  sessions.delete(chatId);
}
