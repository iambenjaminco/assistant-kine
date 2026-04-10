const redis = require("../config/redis");

const SESSION_PREFIX = "call_session:";
const SESSION_TTL_SECONDS = 15 * 60;

// fallback mémoire local si Redis indisponible
const memoryStore = new Map();

function getKey(callSid) {
  return `${SESSION_PREFIX}${callSid}`;
}

function getMemoryExpiry() {
  return Date.now() + SESSION_TTL_SECONDS * 1000;
}

function cleanupExpiredMemorySession(callSid) {
  const entry = memoryStore.get(getKey(callSid));
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(getKey(callSid));
    return null;
  }

  return entry.value;
}

async function getSession(callSid) {
  if (!callSid) return null;

  if (!redis) {
    return cleanupExpiredMemorySession(callSid);
  }

  try {
    const raw = await redis.get(getKey(callSid));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[SESSION_STORE][GET_ERROR]", err.message);
    return cleanupExpiredMemorySession(callSid);
  }
}

async function saveSession(callSid, session) {
  if (!callSid || !session) return false;

  if (!redis) {
    memoryStore.set(getKey(callSid), {
      value: session,
      expiresAt: getMemoryExpiry(),
    });
    return true;
  }

  try {
    await redis.set(
      getKey(callSid),
      JSON.stringify(session),
      "EX",
      SESSION_TTL_SECONDS
    );
    return true;
  } catch (err) {
    console.error("[SESSION_STORE][SAVE_ERROR]", err.message);
    memoryStore.set(getKey(callSid), {
      value: session,
      expiresAt: getMemoryExpiry(),
    });
    return true;
  }
}

async function clearSession(callSid) {
  if (!callSid) return false;

  memoryStore.delete(getKey(callSid));

  if (!redis) {
    return true;
  }

  try {
    await redis.del(getKey(callSid));
    return true;
  } catch (err) {
    console.error("[SESSION_STORE][CLEAR_ERROR]", err.message);
    return true;
  }
}

module.exports = {
  getSession,
  saveSession,
  clearSession,
};