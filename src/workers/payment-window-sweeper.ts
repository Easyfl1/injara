import { prisma } from "../db/prisma.js";
import { getEnv } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { postTx } from "../services/ledger.js";
import { isSuccessfulBuyCharge, buyTotalKobo } from "../domain/money.js";

const log = childLogger({ worker: "payment-window-sweeper" });

export async function runPaymentWindowSweeper(): Promise<void> {
  const POLL_INTERVAL = 15_000;

  log.info("Payment window sweeper started");

  while (true) {
    try {
      const env = getEnv();
      const orders = await prisma.order.findMany({
        where: {
          orderType: "BUY",
          status: { in: ["AWAITING_PAYMENT", "PAYMENT_RECEIVED"] },
          paymentWindowEndsAt: { not: null },
        },
      });

      for (const order of orders) {
        await processOrder(order, env);
      }
    } catch (err) {
      log.error({ err }, "Payment window sweeper error");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function processOrder(order: any, env: any): Promise<void> {
  const now = new Date();
  const windowEnd = order.paymentWindowEndsAt;

  if (!windowEnd) return;

  if (now < windowEnd) {
    return;
  }

  const { verifyByReference } = await import("../services/flutterwave.js");

  const verifyResult = await verifyByReference(order.paymentReference);

  if (isSuccessfulBuyCharge(verifyResult, order)) {
    log.info({ orderId: order.id }, "Sweeper found successful charge");

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "PAYMENT_CONFIRMED",
          flwTransactionId: String(verifyResult.data.id),
          paymentConfirmedAt: new Date(),
        },
      });

      // Same NGN capture postings the webhook processor makes, so the books
      // record the inflow + fee revenue even when the webhook was missed.
      const bookTxId = `buy_ngn_captured:${order.id}`;
      await postTx(tx, bookTxId, order.id, [
        {
          account: "TREASURY_NGN_FLW",
          asset: "NGN",
          amountBase: order.ngnAmountKobo.toString(),
          direction: "debit",
        },
        {
          account: "USER_CLEARING_NGN",
          asset: "NGN",
          amountBase: order.ngnAmountKobo.toString(),
          direction: "credit",
        },
        {
          account: "TREASURY_NGN_FLW",
          asset: "NGN",
          amountBase: order.feeKobo.toString(),
          direction: "debit",
        },
        {
          account: "FEES_NGN",
          asset: "NGN",
          amountBase: order.feeKobo.toString(),
          direction: "credit",
        },
      ], "ngn_capture");

      await tx.outboxJob.create({
        data: {
          kind: "send-inj",
          payload: {
            orderId: order.id,
            idempotencyKey: `send:${order.id}`,
          },
        },
      });
    });
  } else if (verifyResult.data?.status === "pending" || verifyResult.data?.status === "processing") {
    const extensions = order.paymentWindowExtensions ?? 0;
    if (extensions < (env.MAX_PAYMENT_WINDOW_EXTENSIONS ?? 2)) {
      const newEnd = new Date(windowEnd.getTime() + (env.PENDING_GRACE_SEC ?? 1800) * 1000);
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentWindowEndsAt: newEnd,
          paymentWindowExtensions: extensions + 1,
        },
      });
      log.info(
        { orderId: order.id, extensions: extensions + 1 },
        "Extended payment window for pending status",
      );
    } else {
      log.warn(
        { orderId: order.id },
        "Payment window extensions exhausted, expiring order",
      );
      await expireOrder(order);
    }
  } else {
    log.info(
      { orderId: order.id, status: verifyResult.data?.status },
      "Order payment window expired without successful charge",
    );
    await expireOrder(order);
  }
}

async function expireOrder(order: any): Promise<void> {
  const { disablePaymentLink } = await import("../services/flutterwave.js");

  const expired = await prisma.$transaction(async (tx) => {
    // CAS on status: only expire if the order is still awaiting payment.
    // Prevents racing a webhook that just confirmed the payment.
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id,
        status: { in: ["AWAITING_PAYMENT", "PAYMENT_RECEIVED"] },
      },
      data: { status: "EXPIRED" },
    });
    if (claimed.count === 0) return false;

    const bookTxId = `buy_unreserve:${order.id}`;
    await postTx(tx, bookTxId, order.id, [
      {
        account: "TREASURY_INJ",
        asset: "INJ",
        amountBase: order.injAmountBase,
        direction: "debit",
      },
      {
        account: "TREASURY_INJ_RESERVED",
        asset: "INJ",
        amountBase: order.injAmountBase,
        direction: "credit",
      },
    ], "unreserve");

    // Serialize with acceptBuyQuote's row lock, then decrement atomically.
    // Clamp at zero so a stale reservation can never drive the counter negative.
    await tx.$executeRaw`SELECT id FROM treasury WHERE id = 1 FOR UPDATE`;
    const treasury = await tx.treasuryState.findUnique({ where: { id: 1 } });
    if (treasury) {
      const currentReserved = BigInt(treasury.reservedInjBase);
      const amount = BigInt(order.injAmountBase);
      if (currentReserved < amount) {
        log.warn(
          { orderId: order.id, reserved: currentReserved.toString(), amount: amount.toString() },
          "reservedInjBase below expected value during unreserve; clamping to zero",
        );
      }
      const newReserved = currentReserved > amount ? currentReserved - amount : 0n;
      await tx.treasuryState.update({
        where: { id: 1 },
        data: { reservedInjBase: newReserved.toString() },
      });
    }

    return true;
  });

  if (!expired) {
    log.info(
      { orderId: order.id, status: order.status },
      "Order no longer awaiting payment; skipping expiry",
    );
    return;
  }

  if (order.paymentLink) {
    await disablePaymentLink(order.paymentLink);
  }

  const { notifyOrderExpired } = await import("../services/notifications.js");
  await notifyOrderExpired(order);

  log.info({ orderId: order.id, publicId: order.publicId }, "Order expired");
}
