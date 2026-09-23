import { z } from "zod";

const envSchema = z.object({
  PROCESS_ROLE: z.enum(["app", "worker"]).default("app"),
  WORKER_SEND_ENABLED: z.string().default("false").transform((v) => v === "true"),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  ALLOWED_TELEGRAM_IDS: z.string().default(""),
  ADMIN_TELEGRAM_IDS: z.string().default(""),
  ADMIN_ALERT_CHAT_ID: z.string().default(""),

  ADMIN_TOTP_SECRET: z.string().default(""),
  REQUIRE_ADMIN_2FA: z.string().default("false").transform((v) => v === "true"),

  FLW_PUBLIC_KEY: z.string().default(""),
  FLW_SECRET_KEY: z.string().default(""),
  FLW_SECRET_HASH: z.string().default(""),
  FLW_ENV: z.enum(["sandbox", "live"]).default("sandbox"),

  COINGECKO_API_KEY: z.string().default(""),
  COINGECKO_BASE_URL: z
    .string()
    .default("https://api.coingecko.com/api/v3"),
  COINGECKO_PLAN: z.enum(["demo", "pro"]).default("demo"),

  INJECTIVE_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  TREASURY_PRIVATE_KEY: z.string().default(""),
  TREASURY_INJ_ADDRESS: z.string().default(""),
  WALLET_MASTER_MNEMONIC: z.string().default(""),

  PII_ENCRYPTION_KEY: z.string().default(""),
  PII_BLIND_INDEX_KEY: z.string().default(""),

  BUY_FEE_BPS: z.coerce.number().int().default(200),
  SELL_FEE_BPS: z.coerce.number().int().default(200),
  QUOTE_TTL_SEC: z.coerce.number().int().default(180),
  PAYMENT_WINDOW_SEC: z.coerce.number().int().default(2700),
  PENDING_GRACE_SEC: z.coerce.number().int().default(1800),
  MAX_PAYMENT_WINDOW_EXTENSIONS: z.coerce.number().int().default(2),
  DEPOSIT_WINDOW_SEC: z.coerce.number().int().default(900),
  UNKNOWN_POLL_SEC: z.coerce.number().int().default(60),
  PRICE_MAX_AGE_SEC: z.coerce.number().int().default(120),
  CONFIRMATION_DEPTH: z.coerce.number().int().default(2),
  DAILY_USER_NGN_KOBO: z.coerce.number().int().default(10_000_000),
  MAX_PAYABLE_KOBO: z.coerce.number().int().default(10_000_000),
  LIFETIME_USER_NGN_KOBO: z.coerce.number().int().default(50_000_000),
  FLW_NGN_BALANCE_KOBO: z.coerce.number().int().optional(),

  MAINTENANCE_MODE: z.string().default("false").transform((v) => v === "true"),
  BUY_ENABLED: z.string().default("true").transform((v) => v === "true"),
  SELL_ENABLED: z.string().default("true").transform((v) => v === "true"),
  DEPOSIT_MODE: z.enum(["memo", "hd"]).default("memo"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

export function getEnvUnsafe(): Env {
  return _env!;
}
