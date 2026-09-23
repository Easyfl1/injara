import { getRedis } from "../redis/client.js";
import { RedisKeys } from "../redis/keys.js";
import { getEnv } from "../config/env.js";
import { priceToDecimal, type Decimal } from "../domain/money.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ service: "pricing" });

export interface PriceSnapshot {
  injNgn: string;
  injUsd: string;
  priceUpdatedAt: Date;
  rawPayload: Record<string, unknown>;
}

export async function getSpot(): Promise<PriceSnapshot> {
  const redis = getRedis();
  const env = getEnv();
  const cacheKey = RedisKeys.price("inj");
  const ageKey = RedisKeys.priceAge("inj");

  const cached = await redis.get(cacheKey);
  const cachedAge = await redis.get(ageKey);

  if (cached && cachedAge) {
    const ageSec = (Date.now() - parseInt(cachedAge, 10)) / 1000;
    if (ageSec < env.PRICE_MAX_AGE_SEC) {
      return JSON.parse(cached) as PriceSnapshot;
    }
  }

  return fetchAndCache();
}

async function fetchAndCache(): Promise<PriceSnapshot> {
  const env = getEnv();
  const url = `${env.COINGECKO_BASE_URL}/simple/price?ids=injective-protocol&vs_currencies=ngn,usd&include_last_updated_at=true&precision=full`;

  const headers: Record<string, string> = {};
  if (env.COINGECKO_API_KEY) {
    const headerName =
      env.COINGECKO_PLAN === "pro"
        ? "x-cg-pro-api-key"
        : "x-cg-demo-api-key";
    headers[headerName] = env.COINGECKO_API_KEY;
  }

  log.debug({ url }, "Fetching INJ price from CoinGecko");

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status}`);
  }

  const data = (await response.json()) as Record<string, Record<string, string | number>>;
  const injData = data["injective-protocol"];
  if (!injData) {
    throw new Error("CoinGecko returned no INJ data");
  }

  const injNgn = String(injData.ngn);
  const injUsd = String(injData.usd);
  const lastUpdatedAt = injData.last_updated_at
    ? new Date(Number(injData.last_updated_at) * 1000)
    : new Date();

  const snapshot: PriceSnapshot = {
    injNgn,
    injUsd,
    priceUpdatedAt: lastUpdatedAt,
    rawPayload: data,
  };

  const redis = getRedis();
  await redis.set(RedisKeys.price("inj"), JSON.stringify(snapshot), "EX", 120);
  await redis.set(RedisKeys.priceAge("inj"), Date.now().toString(), "EX", 120);

  log.info({ injNgn, injUsd }, "INJ price updated");
  return snapshot;
}

export async function isStale(): Promise<boolean> {
  const redis = getRedis();
  const ageKey = RedisKeys.priceAge("inj");
  const cachedAge = await redis.get(ageKey);
  if (!cachedAge) return true;
  const ageSec = (Date.now() - parseInt(cachedAge, 10)) / 1000;
  return ageSec > getEnv().PRICE_MAX_AGE_SEC;
}

export function parseInjNgn(snapshot: PriceSnapshot): Decimal {
  return priceToDecimal(snapshot.injNgn);
}
