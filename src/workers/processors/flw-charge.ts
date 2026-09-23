import { prisma } from "../../db/prisma.js";
import { verifyByReference } from "../../services/flutterwave.js";
import { isSuccessfulBuyCharge } from "../../domain/money.js";
import { postTx } from "../../services/ledger.js";
import { childLogger } from "../../utils/logger.js";

const log = childLogger({ processor: "flw-charge" });

export async function processFlwCharge(job: any): Promise<void> {
  const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({
    where: { id: job.webhookEventId },
  });

  if (webhookEvent.processedAt) return;

  const payload = webhookEvent.payload as any;
  const txRef = payload.data?.tx_ref;
  if (!txRef) {
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date() },
    });
    return;
  }

  const verifyResult = await verifyByReference(txRef);

  const order = await prisma.order.findFirst({
    where: { paymentReference: txRef },
    include: { user: true },
  });

  if (!order) {
    log.warn({ txRef }, "No order found for payment reference");
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date() },
    });
    return;
  }

  if (
    ["COMPLETED", "REFUNDED", "TREASURY_SENDING", "PAYMENT_CONFIRMED"].includes(
      order.status,
    )
  ) {
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date() },
    });
    return;
  }

  if (order.status === "EXPIRED" || order.status === "CANCELLED") {
    log.warn({ orderId: order.id, status: order.status }, "Late payment on terminal order");
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        processedAt: new Date(),
        processError: "late payment on terminal order",
        orderId: order.id,
      },
    });
    return;
  }

  if (!isSuccessfulBuyCharge(verifyResult, order)) {
    if (verifyResult.data?.status === "successful") {
      log.warn(
        {
          txRef,
          status: verifyResult.data?.status,
          expectedKobo: (BigInt(order.ngnAmountKobo) + BigInt(order.feeKobo)).toString(),
          flwAmount: verifyResult.data?.amount,
          flwChargedAmount: verifyResult.data?.charged_amount,
        },
        "Charge successful but predicate failed - MANUAL_REVIEW",
      );
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: "MANUAL_REVIEW",
          failureReason: "Successful charge but amount/currency mismatch",
        },
      });
    }
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date(), orderId: order.id },
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "PAYMENT_CONFIRMED",
        flwTransactionId: String(verifyResult.data.id),
        paymentConfirmedAt: new Date(),
      },
    });

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

    await tx.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date(), orderId: order.id },
    });
  });

  log.info(
    { orderId: order.id, publicId: order.publicId },
    "Payment confirmed, INJ send enqueued",
  );
}

