import { createRequire } from "module";
import { getEnv } from "../config/env.js";

const require = createRequire(import.meta.url);

type RedisInstance = any;

let _redis: RedisInstance | null = null;

export function getRedis(): RedisInstance {
  if (!_redis) {
    const env = getEnv();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const IORedis = require("ioredis");
    _redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    _redis.on("error", (err: Error) => {
      console.error("Redis connection error:", err.message);
    });
  }
  return _redis;
}

export async function connectRedis(): Promise<void> {
  const redis = getRedis();
  await redis.connect();
}

export async function disconnectRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
