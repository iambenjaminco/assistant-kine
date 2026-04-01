const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.warn("[REDIS] REDIS_URL manquante. Redis désactivé.");
}

const redis = redisUrl
  ? new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: false,
    })
  : null;

if (redis) {
  redis.on("connect", () => {
    console.log("✅ Redis connecté");
  });

  redis.on("ready", () => {
    console.log("✅ Redis prêt");
  });

  redis.on("error", (err) => {
    console.error("❌ Redis error:", err.message);
  });
}

module.exports = redis;