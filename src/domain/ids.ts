import { randomBytes } from "node:crypto";

export function generatePublicId(type: "BUY" | "SELL"): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomBytes(2).toString("hex").toUpperCase().slice(0, 4);
  return `${type}-${date}-${suffix}`;
}

export function generatePaymentReference(publicId: string): string {
  return `injara_${publicId.toLowerCase().replace(/-/g, "_")}`;
}

export function generatePayoutReference(publicId: string): string {
  return `injara_po_${publicId.toLowerCase().replace(/-/g, "_")}`;
}

export function generateDepositMemo(publicId: string): string {
  return `INJARA-${publicId}`;
}

export function generateWebhookFingerprint(
  flwId: string | number,
  event: string,
  status: string,
): string {
  return `flutterwave:${flwId}:${event}:${status}`;
}
