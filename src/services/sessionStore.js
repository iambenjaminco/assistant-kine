const redis = require("../config/redis");

const SESSION_PREFIX = "call_session:";
const SESSION_TTL_SECONDS = 15 * 60;
const IS_PROD = process.env.NODE_ENV === "production";

// Fallback mémoire local uniquement en développement
const memoryStore = new Map();

function getKey(callSid) {
  return `${SESSION_PREFIX}${callSid}`;
}

function getMemoryExpiry() {
  return Date.now() + SESSION_TTL_SECONDS * 1000;
}

function canUseMemoryFallback() {
  return !IS_PROD;
}

function cleanupExpiredMemorySession(callSid) {
  const key = getKey(callSid);
  const entry = memoryStore.get(key);

  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }

  return entry.value;
}

function saveToMemory(callSid, session) {
  memoryStore.set(getKey(callSid), {
    value: JSON.parse(JSON.stringify(session)),
    expiresAt: getMemoryExpiry(),
  });
}

function validateSessionShape(session) {
  if (!session || typeof session !== "object") return false;
  if (typeof session.step !== "string" || !session.step.trim()) return false;
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) return false;

  if (
    session.metricsTracked !== undefined &&
    (typeof session.metricsTracked !== "object" || session.metricsTracked === null)
  ) {
    return false;
  }

  if (
    session.processedActions !== undefined &&
    (typeof session.processedActions !== "object" || session.processedActions === null || Array.isArray(session.processedActions))
  ) {
    return false;
  }

  return true;
}

async function getSession(callSid) {
  if (!callSid) return null;

  if (!redis) {
    if (canUseMemoryFallback()) {
      console.warn("[SESSION_STORE][REDIS_UNAVAILABLE][DEV_FALLBACK_GET]", {
        callSid,
      });
      return cleanupExpiredMemorySession(callSid);
    }

    throw new Error("SESSION_STORE_UNAVAILABLE");
  }

  try {
    const raw = await redis.get(getKey(callSid));
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (!validateSessionShape(parsed)) {
      console.error("[SESSION_STORE][INVALID_SESSION_SHAPE]", {
        callSid,
      });

      try {
        await redis.del(getKey(callSid));
      } catch (deleteErr) {
        console.error("[SESSION_STORE][DELETE_INVALID_SESSION_FAILED]", {
          callSid,
          message: deleteErr?.message,
        });
      }

      return null;
    }

    return parsed;
  } catch (err) {
    console.error("[SESSION_STORE][GET_ERROR]", {
      callSid,
      message: err?.message,
    });

    if (canUseMemoryFallback()) {
      console.warn("[SESSION_STORE][DEV_FALLBACK_GET_AFTER_ERROR]", {
        callSid,
      });
      return cleanupExpiredMemorySession(callSid);
    }

    throw new Error("SESSION_STORE_GET_FAILED");
  }
}

async function saveSession(callSid, session) {
  if (!callSid || !session) return false;

  if (!validateSessionShape(session)) {
    console.error("[SESSION_STORE][SAVE_INVALID_SESSION_SHAPE]", {
      callSid,
    });
    return false;
  }

  // ✅ PAR :
  if (!redis) {
    if (canUseMemoryFallback()) {
      console.warn("[SESSION_STORE][REDIS_UNAVAILABLE][DEV_FALLBACK_SAVE]", {
        callSid,
      });
      saveToMemory(callSid, session);
      return true;
    }

    console.error("[SESSION_STORE][REDIS_UNAVAILABLE_PROD]", { callSid });
    return false;
  }

  try {
    await redis.set(
      getKey(callSid),
      JSON.stringify(session),
      "EX",
      SESSION_TTL_SECONDS
    );

    if (!IS_PROD) {
      console.log("[SESSION_STORE][SAVE_OK]", {
        callSid,
        ttlSeconds: SESSION_TTL_SECONDS,
      });
    }

    return true;
  } catch (err) {
    console.error("[SESSION_STORE][SAVE_ERROR]", {
      callSid,
      message: err?.message,
    });

    if (canUseMemoryFallback()) {
      console.warn("[SESSION_STORE][DEV_FALLBACK_SAVE_AFTER_ERROR]", {
        callSid,
      });
      saveToMemory(callSid, session);
      return true;
    }

    throw new Error("SESSION_STORE_SAVE_FAILED");
  }
}

async function clearSession(callSid) {
  if (!callSid) return false;

  memoryStore.delete(getKey(callSid));

  if (!redis) {
    if (canUseMemoryFallback()) {
      console.warn("[SESSION_STORE][REDIS_UNAVAILABLE][DEV_FALLBACK_CLEAR]", {
        callSid,
      });
      return true;
    }

    throw new Error("SESSION_STORE_UNAVAILABLE");
  }

  try {
    await redis.del(getKey(callSid));
    return true;
  } catch (err) {
    console.error("[SESSION_STORE][CLEAR_ERROR]", {
      callSid,
      message: err?.message,
    });

    if (canUseMemoryFallback()) {
      console.warn("[SESSION_STORE][DEV_FALLBACK_CLEAR_AFTER_ERROR]", {
        callSid,
      });
      return true;
    }

    throw new Error("SESSION_STORE_CLEAR_FAILED");
  }
}

module.exports = {
  getSession,
  saveSession,
  clearSession,
};