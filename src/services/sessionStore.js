const redis = require("../config/redis");

const SESSION_PREFIX = "call_session:";
const SESSION_TTL_SECONDS = 15 * 60;

function getKey(callSid) {
  return `${SESSION_PREFIX}${callSid}`;
}

async function getSession(callSid) {
  if (!callSid) return null;

  const raw = await redis.get(getKey(callSid));
  if (!raw) return null;

  return JSON.parse(raw);
}

async function saveSession(callSid, session) {
  if (!callSid || !session) return false;

  await redis.set(
    getKey(callSid),
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS
  );

  return true;
}

async function clearSession(callSid) {
  if (!callSid) return false;

  await redis.del(getKey(callSid));
  return true;
}

module.exports = {
  getSession,
  saveSession,
  clearSession,
};