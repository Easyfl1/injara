export const MIN_INJ = "0.05";
export const MAX_INJ = "50";
export const INJ_DECIMALS = 18;
export const INJ_DENOM = "inj";

export const DUST_THRESHOLD_INJ_BASE =
  "1000000000000000"; // 0.001 INJ in base units

export const FLW_PAYOUT_FEE_KOBO = 1075n; // ₦10.75 fallback

export const SUPPORT_COMMANDS = [
  "buy",
  "sell",
  "status",
  "history",
  "help",
  "support",
] as const;

export const ADMIN_COMMANDS = [
  "treasury",
  "pending",
  "failed",
  "users",
  "revenue",
  "unmatched",
  "halt",
  "resume",
  "refund",
  "retry-send",
  "retry-payout",
  "match",
] as const;

export const ORDER_TYPE = {
  BUY: "BUY",
  SELL: "SELL",
} as const;

export const ORDER_STATUS = {
  QUOTED: "QUOTED",
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  TREASURY_SENDING: "TREASURY_SENDING",
  AWAITING_DEPOSIT: "AWAITING_DEPOSIT",
  DEPOSIT_DETECTED: "DEPOSIT_DETECTED",
  DEPOSIT_CONFIRMED: "DEPOSIT_CONFIRMED",
  PAYOUT_PENDING: "PAYOUT_PENDING",
  PAYOUT_PROCESSING: "PAYOUT_PROCESSING",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  SEND_FAILED: "SEND_FAILED",
  DEPOSIT_MISMATCH: "DEPOSIT_MISMATCH",
  PAYOUT_FAILED: "PAYOUT_FAILED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  REFUNDED: "REFUNDED",
} as const;

export const OUTBOX_KIND = {
  PROCESS_FLW_CHARGE: "process-flw-charge",
  IGNORE_FLW_CHARGE_ATTEMPT: "ignore-flw-charge-attempt",
  PROCESS_FLW_TRANSFER: "process-flw-transfer",
  PROCESS_FLW_CHARGEBACK: "process-flw-chargeback",
  IGNORE_FLW_UNKNOWN: "ignore-flw-unknown",
  SEND_INJ: "send-inj",
  PAYOUT_NGN: "payout-ngn",
} as const;
