import { getRedis } from "./client.js";
import { RedisKeys } from "./keys.js";

export class RedisLock {
  private readonly redis = getRedis();
  private readonly key: string;
  private readonly ttlMs: number;
  private lockValue: string | null = null;

  constructor(key: string, ttlMs: number = 15_000) {
    this.key = key;
    this.ttlMs = ttlMs;
  }

  async acquire(): Promise<boolean> {
    const value = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const acquired = await this.redis.set(
      this.key,
      value,
      "PX",
      this.ttlMs,
      "NX",
    );
    if (acquired) {
      this.lockValue = value;
      return true;
    }
    return false;
  }

  async release(): Promise<void> {
    if (!this.lockValue) return;
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(lua, 1, this.key, this.lockValue);
    this.lockValue = null;
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const acquired = await this.acquire();
    if (!acquired) throw new Error(`Failed to acquire lock: ${this.key}`);
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }
}

export async function acquireOrderLock(
  orderId: string,
): Promise<RedisLock> {
  const lock = new RedisLock(RedisKeys.orderLock(orderId), 10_000);
  await lock.acquire();
  return lock;
}

export async function acquireTreasuryLock(): Promise<RedisLock> {
  const lock = new RedisLock(RedisKeys.treasurySend(), 15_000);
  await lock.acquire();
  return lock;
}
