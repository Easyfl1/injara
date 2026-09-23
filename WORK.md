# Injara Telegram P2P Exchange Bot — Operational Status

## Current State: MVP Core Build Complete

All source code compiles cleanly (`tsc --noEmit` exits 0). All 29 unit tests pass. No database or runtime dependency available to execute the application yet.

---

## Build Status

| Gate | Status | Notes |
|------|--------|-------|
| TypeScript | ✅ PASS | `tsc --noEmit` exits 0, zero errors |
| Unit Tests | ✅ PASS | 29/29 pass — money, address, order-machine |
| Prisma Generate | ✅ PASS | Client generated from 16-model schema |
| Docker Build | ⚠️ NOT RUN | No Docker daemon available in this environment |
| Integration Tests | ⚠️ NOT RUN | Requires PostgreSQL + Redis |

---

## Implemented Services

### Domain Layer ✅
- `money.ts` — Decimal.js arithmetic for INJ (18 decimals) and NGN kobo. Buy/sell calculators with fee BPS and FLW payout fee
- `order-machine.ts` — State transition tables for BUY and SELL order lifecycle (18 statuses). Covers all webhook-triggered transitions including sweeper paths
- `address.ts` — INJ address validation (regex), NUBAN (10-digit), email
- `ids.ts` — PublicId generation (INJ-XXXX-XXXX), payment references, deposit memos

### Config & Database ✅
- `env.ts` — Zod-validated env with all required/optional vars (50+ config keys)
- `constants.ts` — INJ limits, dust thresholds, FLW payout fee, order type/status/outbox kind enums
- `prisma.ts` — Singleton PrismaClient
- `tx.ts` — Transaction helper with parameterized client type
- `schema.prisma` — 16 models: User, Order, QuoteSnapshot, TreasuryState, Payout, BankAccount, LedgerEntry, WebhookEvent, ChargebackEvent, UnmatchedDeposit, AuditLog, RiskFlag, OutboxJob, ProcessedChainTx, ChainCursor, SupportTicket. Partial unique indexes via raw SQL migration

### Redis ✅
- `client.ts` — ioredis connect/disconnect (using `require()` workaround for ESM)
- `keys.ts` — Key patterns for lock, outbox, rate limit, session
- `locks.ts` — Distributed lock with Lua release script

### Services ✅
- `pricing.ts` — CoinGecko /simple/price with 120s cache, retry, stale fallback
- `flutterwave.ts` — Full Flutterwave v3 API: payment links, transfers (bank/wallet), verify, transfer lookup, bank resolution (34 banks), refund, disable payment link. Idempotent via header key
- `injective.ts` — Bank balance queries, tm tx_search by memo, MsgSend broadcast with MsgBroadcasterWithPk, fetchTxByHash, getLatestHeight. Uses `@injectivelabs/sdk-ts@1.20.34`
- `ledger.ts` — Double-entry ledger with per-tx balance assertion (debit === credit per asset). In-tx and standalone variants
- `treasury.ts` — Treasury state management, INJ availability calc with gas buffer, NGN availability with staleness check
- `orders.ts` — Full buy/sell flow: create quote (with daily limit, treasury check), accept quote (reserve INJ/NGN, create payment link / generate memo), get order, user history. Enforces FLW_NGN_BALANCE_KOBO override
- `banking.ts` — FLW bank account resolution, AES-256-GCM encrypt/decrypt for account numbers, NUBAN validation, bank code lookup (34 banks)
- `notifications.ts` — Telegram messages for all order lifecycle events (buy/sell complete, expired, payment received, send instructions, admin alerts)

### Bot ✅
- `bot.ts` — grammY bot with session (GrammySessionStorage via Map), rate limiting (120/min user, 3/min anon), auth guard, 3 conversations, admin guard
- `menus.ts` — Main menu (Buy, Sell, Balance, History, Support) and Admin menu (PENDING, PAID, REVENUE, etc)
- `callbacks.ts` — Callback routing for menu items, quote accept/reject, email collect, admin actions. Rate-limited pending queue processor
- `conversations/buy.ts` — Collect INJ amount → fetch price → show quote with countdown → confirm/cancel
- `conversations/sell.ts` — Collect INJ amount → resolve bank account → fetch price → show quote → confirm/cancel
- `conversations/collect-email.ts` — Email collection for payment processing

### Workers ✅
- `outbox-processor.ts` — Polls outbox_jobs, locks via UPDATE WHERE locked_at IS NULL, dispatches to handler map. Supports 7 job kinds
- `payment-window-sweeper.ts` — Sweeps BUY orders past payment window. On success: confirms payment → enqueues send-inj. On pending: extends window (configurable max extensions). On timeout: expires → unreserves INJ → notifies user
- `quote-sweeper.ts` — Expires stale QUOTED orders
- `deposit-watcher.ts` — Polls tm tx_search by deposit memo, detects INJ deposits, confirms when within dust band → enqueues payout-ngn. Cursor-based height tracking
- `processors/flw-charge.ts` — Idempotent: verifies FLW charge → debits FLW, credits user clearing → enqueues send-inj
- `processors/send-inj.ts` — Acquires treasury lock → MsgSend → polls depth (configurable confirmation depth) → debits external, credits reserved → notifies user. Handles re-broadcast on unknown tx
- `processors/payout-ngn.ts` — Decrypts bank account → FLW transfer → debits external, credits reserved → notifies user. Handles pending transfer lookup for retries

### Entry Point ✅
- `index.ts` — App mode: starts bot, outbox processor, payment window sweeper, quote sweeper, deposit watcher. Worker mode: outbox processor only. Graceful SIGINT/SIGTERM shutdown

### HTTP ✅
- `server.ts` — Fastify with healthz/readyz (redis + prisma)
- `webhooks/flutterwave.ts` — Fastify route: HMAC-SHA512 verification, idempotent outbox insert
- `payments-callback.ts` — Fastify route: FLW redirect handler
- `telegram.ts` — Fastify route: webhook registration with setWebhook

### Scripts ✅
- `scripts/check-sdk-denylist.ts` — Verifies `@Injectivelabs/sdk-ts` is installed and functional

### CI ✅
- `.github/workflows/ci.yml` — Lint, typecheck, test, docker build on push/PR

---

## Test Coverage

| Module | Tests | Status |
|--------|-------|--------|
| money.ts | 16 | ✅ All pass — INJ/NGN conversion, fee calc, edge cases |
| address.ts | 7 | ✅ All pass — INJ address, NUBAN, email |
| order-machine.ts | 6 | ✅ All pass — BUY/SELL state transitions |
| **Total** | **29** | ✅ |

---

## Open Items for Runtime Readiness

1. **Docker Compose** — Need to start PostgreSQL 16 + Redis 7 to run Prisma migrations and seed
2. **Prisma Migrate** — Schema created but migrations not applied (`prisma migrate dev`)
3. **Seed** — `prisma/seed.ts` written but not executed
4. **Integration Tests** — Need running DB/Redis for end-to-end flows
5. **Bot Token** — Need real TELEGRAM_BOT_TOKEN for Telegram operations
6. **Flutterwave Keys** — Need real FLW_SECRET_KEY + FLW_ENCRYPTION_KEY for payment flows
7. **Injective Key** — Need real TREASURY_PRIVATE_KEY for on-chain operations
8. **npm CI** — `npm install --legacy-peer-deps` completed, but `pnpm approve-builds` still pending for native modules

---

## File Statistics

- **TypeScript source files**: ~50
- **Lines of code**: ~6,500
- **Test files**: 3 (unit)
- **Config files**: 6 (package.json, tsconfig, docker-compose, Dockerfile, .env.example, CI yaml)
