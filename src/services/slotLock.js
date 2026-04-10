// src/services/slotLock.js

const redis = require("../config/redis");
const crypto = require("crypto");

const LOCK_PREFIX = "slot_lock:";

function buildSlotLockKey(calendarId, startDate, endDate) {
    return `${LOCK_PREFIX}${calendarId}:${new Date(startDate).toISOString()}:${new Date(endDate).toISOString()}`;
}

// 🔐 Génère un token unique par lock
function generateLockToken() {
    return crypto.randomBytes(16).toString("hex");
}

// ✅ ACQUIRE avec ownership
async function acquireSlotLock(calendarId, startDate, endDate, ttlMs = 60000) {
    if (!redis) {
        console.warn("[SLOT_LOCK] Redis non dispo → lock ignoré");
        return { ok: true, token: null };
    }

    const key = buildSlotLockKey(calendarId, startDate, endDate);
    const token = generateLockToken();

    const result = await redis.set(key, token, "PX", ttlMs, "NX");

    if (result === "OK") {
        return { ok: true, token };
    }

    return { ok: false, token: null };
}

// 🔐 RELEASE sécurisé avec token
async function releaseSlotLock(calendarId, startDate, endDate, token) {
    if (!redis || !token) return;

    const key = buildSlotLockKey(calendarId, startDate, endDate);

    const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    `;

    try {
        await redis.eval(luaScript, 1, key, token);
    } catch (err) {
        console.error("[SLOT_LOCK][RELEASE_ERROR]", err.message);
    }
}

module.exports = {
    acquireSlotLock,
    releaseSlotLock,
    buildSlotLockKey,
};