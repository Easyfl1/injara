import { getEnv } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ service: "flutterwave" });

const FLW_BASE = "https://api.flutterwave.com/v3";

function headers(): Record<string, string> {
  const env = getEnv();
  return {
    Authorization: `Bearer ${env.FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

export interface FlwPaymentLink {
  link: string;
  id: string;
}

export async function createPaymentLink(args: {
  txRef: string;
  amount: string;
  currency?: string;
  redirectUrl: string;
  customer: { email: string; name?: string };
  customizations: { title: string; description: string };
  meta?: Record<string, unknown>;
  sessionDuration?: number;
}): Promise<FlwPaymentLink> {
  const payload = {
    tx_ref: args.txRef,
    amount: args.amount,
    currency: args.currency ?? "NGN",
    redirect_url: args.redirectUrl,
    payment_options: "card,banktransfer,ussd,account",
    customer: args.customer,
    customizations: args.customizations,
    meta: args.meta ?? {},
    configurations: {
      session_duration: args.sessionDuration ?? 45,
      max_retry_attempt: 5,
    },
  };

  log.info({ txRef: args.txRef, amount: args.amount }, "Creating FLW payment link");

  const response = await fetch(`${FLW_BASE}/payments`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await response.json()) as {
    status: string;
    data: { link: string; id: string };
  };

  if (data.status !== "success" || !data.data?.link) {
    throw new Error(`FLW create payment failed: ${JSON.stringify(data)}`);
  }

  log.info({ txRef: args.txRef, flwId: data.data.id }, "FLW payment link created");
  return { link: data.data.link, id: data.data.id };
}

export interface FlwVerifyResponse {
  status: string;
  data: {
    id: number;
    status: string;
    currency: string;
    amount: string;
    charged_amount: string;
    tx_ref: string;
    customer: { email: string };
  };
}

export async function verifyTransaction(id: number): Promise<FlwVerifyResponse> {
  const response = await fetch(`${FLW_BASE}/transactions/${id}/verify`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
  return (await response.json()) as FlwVerifyResponse;
}

export async function verifyByReference(
  txRef: string,
): Promise<FlwVerifyResponse> {
  const response = await fetch(
    `${FLW_BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
    {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return (await response.json()) as FlwVerifyResponse;
}

export interface FlwAccountResolve {
  status: string;
  message?: string;
  data: {
    account_number: string;
    account_name: string;
    bank_code: string;
  };
}

export async function resolveAccount(
  bankCode: string,
  accountNumber: string,
): Promise<FlwAccountResolve> {
  const response = await fetch(`${FLW_BASE}/accounts/resolve`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode }),
    signal: AbortSignal.timeout(10_000),
  });

  const text = await response.text();
  let data: FlwAccountResolve;
  try {
    data = JSON.parse(text);
  } catch {
    log.error({ status: response.status, body: text.slice(0, 200) }, "FLW resolve account: non-JSON response");
    throw new Error(`FLW API error: ${response.status} - ${text.slice(0, 200)}`);
  }

  if (!response.ok || data.status !== "success") {
    log.error({ status: response.status, data }, "FLW resolve account failed");
    throw new Error(data.message || `FLW resolve failed: ${response.status}`);
  }

  return data;
}

export interface FlwBank {
  id: number;
  code: string;
  name: string;
}

export async function listBanksNG(): Promise<FlwBank[]> {
  const response = await fetch(`${FLW_BASE}/banks/NG`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });

  const text = await response.text();
  let data: { status: string; message?: string; data: FlwBank[] };
  try {
    data = JSON.parse(text);
  } catch {
    log.error({ status: response.status, body: text.slice(0, 200) }, "FLW list banks: non-JSON response");
    throw new Error(`FLW API error: ${response.status} - ${text.slice(0, 200)}`);
  }

  if (!response.ok || data.status !== "success") {
    log.error({ status: response.status, data }, "FLW list banks failed");
    throw new Error(data.message || `FLW list banks failed: ${response.status}`);
  }

  log.debug({ count: data.data?.length, sample: data.data?.slice(0, 3) }, "FLW banks list");
  return data.data ?? [];
}

export interface FlwTransfer {
  id: number;
  reference: string;
  status: string;
  complete_message?: string;
}

export async function initiateTransfer(args: {
  bankCode: string;
  accountNumber: string;
  amount: string;
  currency?: string;
  narration: string;
  reference: string;
  debitCurrency?: string;
}): Promise<FlwTransfer> {
  const payload = {
    account_bank: args.bankCode,
    account_number: args.accountNumber,
    amount: args.amount,
    currency: args.currency ?? "NGN",
    narration: args.narration,
    reference: args.reference,
    debit_currency: args.debitCurrency ?? "NGN",
  };

  log.info({ reference: args.reference, amount: args.amount }, "Initiating FLW transfer");

  const response = await fetch(`${FLW_BASE}/transfers`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await response.json()) as {
    status: string;
    message: string;
    data: FlwTransfer;
  };

  if (data.status === "error" && data.message?.includes("Duplicate reference")) {
    const existing = await getTransferByReference(args.reference);
    return existing;
  }

  if (data.status !== "success") {
    throw new Error(`FLW transfer failed: ${JSON.stringify(data)}`);
  }

  return data.data;
}

export async function getTransferById(id: number): Promise<FlwTransfer> {
  const response = await fetch(`${FLW_BASE}/transfers/${id}`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json()) as {
    status: string;
    data: FlwTransfer;
  };
  return data.data;
}

export async function getTransferByReference(
  reference: string,
): Promise<FlwTransfer> {
  const response = await fetch(
    `${FLW_BASE}/transfers?reference=${encodeURIComponent(reference)}`,
    {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const data = (await response.json()) as {
    status: string;
    data: FlwTransfer[];
  };
  return data.data?.[0] as FlwTransfer;
}

export async function refundCharge(flwTransactionId: number): Promise<void> {
  const response = await fetch(`${FLW_BASE}/transactions/${flwTransactionId}/refund`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ amount: 0 }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json()) as { status: string };
  if (data.status !== "success") {
    throw new Error(`FLW refund failed: ${JSON.stringify(data)}`);
  }
}

export async function disablePaymentLink(link: string): Promise<void> {
  try {
    await fetch(`${FLW_BASE}/payments/link/disable`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ link }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn({ err }, "Failed to disable FLW payment link (non-fatal)");
  }
}
