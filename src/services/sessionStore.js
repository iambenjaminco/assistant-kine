// src/services/sessionStore.js
const redis = require("../config/redis");

const SESSION_PREFIX = "twilio_session:";
const SESSION_TTL_SECONDS = 60 * 15; // 15 minutes

function getSessionKey(callSid) {
  return `${SESSION_PREFIX}${callSid}`;
}

async function getSession(callSid) {
  if (!callSid || !redis) return null;

  try {
    const raw = await redis.get(getSessionKey(callSid));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[SESSION_STORE][GET_ERROR]", {
      callSid,
      message: err?.message,
    });
    return null;
  }
}

async function saveSession(callSid, session) {
  if (!callSid || !session || !redis) return;

  try {
    await redis.set(
      getSessionKey(callSid),
      JSON.stringify(session),
      "EX",
      SESSION_TTL_SECONDS
    );
  } catch (err) {
    console.error("[SESSION_STORE][SAVE_ERROR]", {
      callSid,
      message: err?.message,
    });
  }
}

async function clearSession(callSid) {
  if (!callSid || !redis) return;

  try {
    await redis.del(getSessionKey(callSid));
  } catch (err) {
    console.error("[SESSION_STORE][CLEAR_ERROR]", {
      callSid,
      message: err?.message,
    });
  }
}

module.exports = {
  getSession,
  saveSession,
  clearSession,
};