## Design Document Review: Injara — Telegram P2P Exchange Bot for Injective (INJ / NGN)

### Summary
**Needs revision** (narrow). Round 1 blockers on split clocks, webhook insert+outbox, decimal/`data.amount`, payout `UNIQUE(order_id)`, Key Decisions K18–K30, PR order, refunds, and WORK.md alignment are in the spec and internally consistent. Do not start rails PRs until the remaining money-path contradictions are closed: sell accumulate auto-fulfills `EXPIRED` orders after NGN is unreserved; send rebuild cannot persist a new `broadcast_tx_hash`; unmatched INJ postings break recon; reservation SQL cannot run on string columns.

Canonical spec reviewed: `/workspaces/injara/docs/design.md` (revised 2026-09-20). `/workspaces/injara/WORK.md` matches the revised clocks, caps, env list, and PR ladder. `/tmp/grok-codespace/` copies were missing at review time.

---

### Issue 1: Sell accumulate auto-pays `EXPIRED` orders after NGN unreserve
- **Severity**: critical
- **Section**: Sell Flow → Accumulate-by-memo (K25); Order status machine (SELL); Settlement clocks
- **Description**: The state machine and clocks say late deposits on `EXPIRED` go to `MANUAL_REVIEW` and zero-deposit expire **releases NGN reservation**. The algorithm does the opposite:

  ```
  order = find Order where deposit_memo = tx.memo AND status in
          (AWAITING_DEPOSIT, DEPOSIT_DETECTED, DEPOSIT_MISMATCH, EXPIRED)
  ...
  if sum in [expected - dust, expected + dust]:
        CAS → DEPOSIT_CONFIRMED
        enqueue payout-ngn
  ```

  There is no `deposit_window_ends_at` check. A user who sends INJ at t=20 min (window is 15 min) on an `EXPIRED` order whose NGN reserve was already released will be auto-paid at the old quote. `EXPIRED` is **not** in `orders_one_open_sell_per_user`, so they may also have a second live sell. Same code auto-promotes `DEPOSIT_MISMATCH` → `DEPOSIT_CONFIRMED` after the window without admin `/match`, contradicting “keep NGN reservation until admin resolves.”
- **Suggestion**: Match only `AWAITING_DEPOSIT | DEPOSIT_DETECTED` for auto-accumulate. If `now >= deposit_window_ends_at` and sum still outside band → `DEPOSIT_MISMATCH` (partial) or `EXPIRED` (zero); further txs on those statuses → `unmatched_deposits` + page, never `enqueue payout-ngn`. Admin `/match` is the only path from `EXPIRED`/`DEPOSIT_MISMATCH` to `DEPOSIT_CONFIRMED`. If you want post-window top-up, say so explicitly and **do not** release NGN until that secondary window ends.
- **Status**: open

### Issue 2: `processed_chain_txs` insert before deposit apply can drop INJ
- **Severity**: critical
- **Section**: Accumulate-by-memo
- **Description**:

  ```
  insert processed_chain_txs (kind=deposit)
  order = find ...
  CAS add tx.amount into order.deposit_inj_base
  ```

  If the process crashes after the insert and before the CAS (or unmatched insert), the next poll hits `if tx.txHash in processed_chain_txs: return` and **never credits the user**. The buy send path correctly uses memo search as recovery; the deposit path has no equivalent once the hash is marked processed.
- **Suggestion**: One Postgres transaction: `processed_chain_txs` + (`deposit_inj_base` increment **or** `unmatched_deposits` + ledger). Unique on `tx_hash` is the idempotency key; do not mark processed until the credit landed.
- **Status**: open

### Issue 3: Send rebuild cannot persist a new `broadcast_tx_hash`
- **Severity**: major
- **Section**: Treasury send algorithm
- **Description**: Persist-before-broadcast is right. The write is:

  ```
  UPDATE orders SET broadcast_tx_hash = preHash WHERE id = order.id
    AND broadcast_tx_hash IS NULL
  ```

  On definite `code != 0` the spec says “fall through to rebuild tx with fresh sequence.” The old failed hash remains. The next `before_every_broadcast` sees `broadcast_tx_hash` set, `fetchTxByHash` returns `code != 0`, rebuilds, broadcasts, and **cannot store the new preHash** (`IS NULL` fails). Crash after that second broadcast is an unrecoverable unknown send.

  Unknown-result handling also has no terminal state: “poll, do not send” with no max age. A tx that never appears (dropped RPC, wrong hash function) leaves `TREASURY_SENDING` and the INJ reservation forever. Retry budget is only for definite `code != 0`.
- **Suggestion**: On definite failed inclusion, set `broadcast_tx_hash = NULL` (or store `broadcast_tx_hash_history[]` and a current hash) in the same CAS to `SEND_FAILED` before rebuilding. After `UNKNOWN_POLL_SEC` (e.g. 60s) of `fetchTxByHash` + memo miss → `MANUAL_REVIEW`, **never** rebuild. Document that `TxClient.hash` must match the hash the chain assigns (verify on testnet in PR-11; if it does not, persist the broadcast response hash and still memo-search).
- **Status**: open

### Issue 4: Reservation SQL is invalid on string INJ columns
- **Severity**: major
- **Section**: Treasury reservation; `TreasuryState.onchainInjBase` / `reservedInjBase`
- **Description**: K10 correctly stores INJ as integer **strings** (50 INJ × 10^18 overflows `BIGINT`). Confirm then does:

  ```
  UPDATE treasury SET reserved_inj_base = reserved_inj_base + order.inj_amount_base;
  ```

  In PostgreSQL that concatenates text (`"0" + "1500…"` → `"01500…"` or a type error), it does not add. `available_inj < order.inj_amount_base` is the same trap. NGN kobo as `BigInt` can use SQL `+`; INJ cannot.
- **Suggestion**: All INJ reservation math in `treasury.ts` with bigint-string helpers (`addBase`, `cmpBase`) inside `SELECT … FOR UPDATE`, then write the result string. Add a unit test that `reserved + 1 INJ` is not concatenation. Do not cast to `BIGINT`.
- **Status**: open

### Issue 5: Unmatched-deposit postings invert treasury and break recon
- **Severity**: major
- **Section**: Ledger posting table; Recon; Accumulate-by-memo
- **Description**: Matched sell deposit is correct: `Dr TREASURY_INJ / Cr USER_CLEARING_INJ` (asset up). Unmatched is:

  > Sell unmatched inbound: `Dr SUSPENSE_UNMATCHED_INJ / Cr TREASURY_INJ`

  On-chain treasury **increased**. Crediting `TREASURY_INJ` decreases the book asset. Recon is `net(TREASURY_INJ) + net(RESERVED) + net(SUSPENSE)` vs `onchain_inj_base`. Unmatched: TREASURY −X, SUSPENSE +X, sum 0, on-chain +X → **page on every forgotten memo**.

  Buy gas is “post if measurable.” After a successful send, on-chain dropped by `amount + gas` while book dropped by `amount` only. Recon will page on every buy until gas is mandatory.

  `USER_CLEARING_NGN` is credited on capture and “not touched by the INJ send.” After `COMPLETED` it is a permanent liability with no open obligation. Fine per-`bookTxId` balance; useless as “what we owe.”
- **Suggestion**: Unmatched inbound: `Dr TREASURY_INJ / Cr SUSPENSE_UNMATCHED_INJ`. Match: `Dr SUSPENSE / Cr USER_CLEARING_INJ` (and surplus to `FEES_INJ`). Make buy-gas a required posting (simulate `gasUsed` or `onchain_delta - sent`). On buy `COMPLETED`, either debit `USER_CLEARING_NGN` against a `SALES_NGN`/`INVENTORY_CONTRA` account or rename it so nobody uses it as open liability.
- **Status**: open

### Issue 6: Buy confirm reserves before Flutterwave link create with no compensating tx
- **Severity**: major
- **Section**: Buy Flow step 7; Treasury reservation
- **Description**: Confirm is one DB transaction: CAS `QUOTED → AWAITING_PAYMENT`, reserve INJ, set `payment_window_ends_at`. Flutterwave `POST /v3/payments` is **after** that commit. If FLW 4xx/5xx/timeout, the order sits 45 minutes in `AWAITING_PAYMENT` with INJ reserved and `payment_link` null. The old failure-modes table (“stay QUOTED, allow retry once”) was **removed** in this revision; there is no user copy, no unreserve, no retry.

  Same class of bug: `payment_reference` is allocated as `injara_buy_{publicId}` before the POST. A timeout where FLW actually created the link, then retry with the same `tx_ref`, is OK; retry with a new ref after a successful-but-unseen create can duplicate checkout. Not specified.
- **Suggestion**: After FLW failure: CAS `AWAITING_PAYMENT → QUOTED` (if `now < quote_expires_at`) or `CANCELLED`, unreserve, tell the user to confirm again. If FLW timeout: `GET verify_by_reference(tx_ref)` before creating a different ref. Restore a buy/sell failure-mode table (user message + system action) — algorithms replaced slogans, they did not replace the matrix.
- **Status**: open

### Issue 7: Payment-window end treats `pending` like `failed`
- **Severity**: major
- **Section**: Payment-window sweeper; Settlement clocks
- **Description**: At `payment_window_ends_at` the sweeper expires unless `isSuccessfulCharge` (status === `successful` and exact kobo). Flutterwave bank transfer / USSD is often `pending` for minutes after the user has paid. Nigerian bank credits also land after 45 minutes (weekends). The spec then unreserves and, if a later retry/verify is successful, `MANUAL_REVIEW` only. That is safer than auto-send, but it **is** the expected path for the rail you chose (policy B), not an edge case. 45 minutes + exact-success is still an expire-under-the-user clock, just slower than 180s.

  NGN reservation has the dual problem: `flw_available_ngn_kobo` defaults to 0 until `GET /v3/balances` is confirmed in PR-10. `available_ngn = 0 - reserved` refuses every sell in sandbox/mainnet until that optional endpoint works. Open Question 5 notes the fee/balance endpoints; it does not give a launch fallback.
- **Suggestion**: If final verify is `pending`/`processing` (not failed), **extend** `payment_window_ends_at` by `PENDING_GRACE_SEC` (capped, e.g. +30 min, max one or two extensions) and keep the reservation; only expire on terminal failed/cancelled or cap exceeded. For NGN: `FLW_NGN_BALANCE_KOBO` env override / ops-set gauge until `/v3/balances` is proven; never treat missing API as zero available.
- **Status**: open

### Issue 8: Webhook unique-violation path still unspecified
- **Severity**: minor
- **Section**: Webhook algorithm
- **Description**: The happy path is now insert+outbox in one transaction and `processed_at IS NULL` re-enqueue. Concurrent first deliveries: both `findUnique` miss, one `create` wins, the other throws Prisma `P2002`. That throw is not caught; Fastify 500. FLW retries, which usually recovers, but a 500 also trips their 30-minute retry storm. `findUnique` then `FOR UPDATE` is two round-trips; use `INSERT … ON CONFLICT (fingerprint) DO UPDATE RETURNING` (or catch P2002 and take the existing row) in the same transaction.
- **Suggestion**: Specify P2002 → lock row → `ensureOutbox`. Do not 500 on duplicate bodies.
- **Status**: open

---

### Strengths
- Settlement clocks are now three independent fields (`quote_expires_at`, `payment_window_ends_at`, `deposit_window_ends_at`) with an explicit unreserve predicate. `configurations.session_duration = 45` is nested correctly. Failed-attempt `charge.completed` is a non-event (K19).
- Webhook fulfillment is keyed on `tx_ref` + GET-verify; insert+outbox share a transaction; `verif-hash` is correctly described as a static secret. Verify-by-ref sweeper covers missed webhooks inside the window.
- Send algorithm is two-phase: search-by-memo, persist `TxClient.hash` before broadcast, lock only around the broadcast, poll on unknown (rebuild-hash hole aside).
- Payouts: `UNIQUE(order_id)`, frozen `injara_po_{publicId}`, GET-before-retry, 400 Duplicate Reference handled. Bank-first sell (K24). Accumulate-by-memo chosen over first-tx-wins (K25), modulo Issue 1.
- `decimal.js` + integer kobo; canonical predicate uses `data.amount` not `charged_amount`. INJ as numeric strings with a warning not to “simplify” to `BIGINT`.
- Buy send ledger pair is now `Dr EXTERNAL_USER_INJ / Cr TREASURY_INJ_RESERVED` (reserved decreases). Caps ₦100k/day, admin TOTP launch gate, sdk-ts **exact** `1.20.34` + denylist of `1.20.21`, CI in PR-01, race tests as AC of PR-10/12/15, `docs/design.md` in-repo, WORK.md filled as pre-implementation status and consistent with the PR ladder.
- Alternative 9 (3-minute everything vs long window vs re-quote vs card-only) is the product decision the first draft omitted.

---

### Previously raised issues not re-listed
Addressed in this revision: split clocks vs FLW 30-minute retries (with the pending-at-expiry caveat in Issue 7); webhook drop-on-unique 200-skip (remaining P2002 in Issue 8); poll-don’t-rebroadcast as policy; payout uniqueness + bank-before-quote + real refund path; decimal contract and `data.amount`; first-tx-wins vs accumulate as a *decision*; K18–K30; CI/race-test PR order; explorer V2 + tm dual-primary; Q8 memo closed; no `.invalid` email; partial unique open-order indexes; payout AES columns; chargeback table; no-KYC caps; TOTP; runbook sketches; PAYMENT_RECEIVED/PRICE_MAX_AGE/telegram route nits.

---

### Verification notes
- `GET /v3/transactions/verify_by_reference?tx_ref=` is a real v3 route (Node-v3 SDK and Odoo adapter). Not live-called here.
- `GET /v3/transfers/fee` and `GET /v3/balances` remain unverified; the spec correctly defers them to PR-10 with a kobo fallback for **fees**, but not for **available NGN** (Issue 7).
- Workspace is still README + `docs/design.md` + `WORK.md` (no application code). Claims about greenfield code are valid.

---

### Blocking before implementation
Issues 1–2 (sell credit/payout after expire; deposit hash marked processed before credit). Then 3–6 (send hash rebuild, string reservation math, unmatched/gas ledger, FLW-link compensating tx). Issue 7 should be decided before anyone treats 45 minutes as “bank transfer is OK.”
