-- Raw SQL indexes that Prisma cannot express

CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_buy_per_user
  ON orders (user_id)
  WHERE order_type = 'BUY'
    AND status IN (
      'QUOTED','AWAITING_PAYMENT','PAYMENT_RECEIVED','PAYMENT_CONFIRMED',
      'TREASURY_SENDING','SEND_FAILED','MANUAL_REVIEW'
    );

CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_sell_per_user
  ON orders (user_id)
  WHERE order_type = 'SELL'
    AND status IN (
      'QUOTED','AWAITING_DEPOSIT','DEPOSIT_DETECTED','DEPOSIT_CONFIRMED',
      'PAYOUT_PENDING','PAYOUT_PROCESSING','PAYOUT_FAILED',
      'DEPOSIT_MISMATCH','MANUAL_REVIEW'
    );

CREATE INDEX IF NOT EXISTS webhook_events_unprocessed
  ON webhook_events (created_at)
  WHERE processed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_jobs_webhook_kind
  ON outbox_jobs (kind, webhook_event_id)
  WHERE webhook_event_id IS NOT NULL;
