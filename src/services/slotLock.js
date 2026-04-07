// src/services/slotLock.js
const Redis = require("ioredis");

let redisClient = null;

function getRedisClient() {
    if (redisClient) return redisClient;

    if (!process.env.REDIS_URL) {
        throw new Error("REDIS_URL manquante");
    }

    redisClient = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
    });

    redisClient.on("connect", () => {
        console.log("[REDIS][SLOT_LOCK] connected");
    });

    redisClient.on("error", (err) => {
        console.error("[REDIS][SLOT_LOCK][ERROR]", err?.message || err);
    });

    return redisClient;
}

function buildSlotLockKey(calendarId, startDate, endDate) {
    return `slot_lock:${calendarId}:${new Date(startDate).toISOString()}:${new Date(endDate).toISOString()}`;
}

async function acquireSlotLock(calendarId, startDate, endDate, ttlMs = 60_000) {
    const redis = getRedisClient();
    const key = buildSlotLockKey(calendarId, startDate, endDate);

    const result = await redis.set(key, "1", "PX", ttlMs, "NX");
    return result === "OK";
}

async function releaseSlotLock(calendarId, startDate, endDate) {
    const redis = getRedisClient();
    const key = buildSlotLockKey(calendarId, startDate, endDate);
    await redis.del(key);
}

module.exports = {
    acquireSlotLock,
    releaseSlotLock,
    buildSlotLockKey,
};