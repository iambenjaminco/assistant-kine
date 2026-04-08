const sessions = new Map();

function getSession(callSid) {
  return sessions.get(callSid);
}

function saveSession(callSid, session) {
  sessions.set(callSid, session);
}

function clearSession(callSid) {
  sessions.delete(callSid);
}

module.exports = {
  getSession,
  saveSession,
  clearSession,
};