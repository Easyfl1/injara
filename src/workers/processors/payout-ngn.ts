import { prisma } from "../../db/prisma.js";
import { initiateTransfer, getTransferByReference } from "../../services/flutterwave.js";
import { decryptAccountNumber } from "../../services/banking.js";
import { koboToNgnString } from "../../domain/money.js";
import { postTx } from "../../services/ledger.js";
import { childLogger } from "../../utils/logger.js";

const log = childLogger({ processor: "payout-ngn" });

export async function processPayoutNgn(job: any): Promise<void> {
  const { orderId } = job.payload;

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { user: true },
  });

  if (order.status !== "DEPOSIT_CONFIRMED" && order.status !== "PAYOUT_PENDING") {
    log.info({ orderId, status: order.status }, "Order not ready for payout");
    return;
  }

  let payout = await prisma.payout.findUnique({ where: { orderId } });
  if (!payout) {
    const reference = `injara_po_${order.publicId.toLowerCase().replace(/-/g, "_")}`;

    const bankAccount = await prisma.bankAccount.findUniqueOrThrow({
      where: { id: order.bankAccountId! },
    });

    payout = await prisma.payout.create({
      data: {
        orderId,
        flutterwaveReference: reference,
        status: "PENDING",
        amountKobo: order.ngnAmountKobo - order.feeKobo,
        accountBank: bankAccount.bankCode,
        accountNumberCipher: bankAccount.accountNumberCipher,
        accountNumberIv: bankAccount.accountNumberIv,
        accountNumberTag: bankAccount.accountNumberTag,
        accountNameCipher: bankAccount.accountNameCipher,
        resolvedName: bankAccount.resolvedName,
        keyVersion: 1,
      },
    });

    await prisma.order.update({
      where: { id: orderId },
      data: { status: "PAYOUT_PENDING", payoutPendingAt: new Date() },
    });
  }

  if (payout.status === "SUCCESSFUL") {
    return;
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { status: "PAYOUT_PROCESSING" },
  });

  try {
    const existingTransfer = await getTransferByReference(payout.flutterwaveReference);
    if (existingTransfer && existingTransfer.status === "SUCCESSFUL") {
      await completePayout(order, payout.id);
      return;
    }
    if (existingTransfer && existingTransfer.status === "FAILED") {
      await prisma.payout.update({
        where: { id: payout.id },
        data: { status: "FAILED" },
      });
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "PAYOUT_FAILED" },
      });
      return;
    }
  } catch {
    // Transfer not found, proceed to create
  }

  const accountNumber = await decryptAccountNumber(order.bankAccountId!);
  const amountStr = koboToNgnString(payout.amountKobo);

  const transfer = await initiateTransfer({
    bankCode: payout.accountBank,
    accountNumber,
    amount: amountStr,
    narration: `Injara ${order.publicId}`,
    reference: payout.flutterwaveReference,
  });

  await prisma.payout.update({
    where: { id: payout.id },
    data: { flutterwaveId: String(transfer.id) },
  });

  if (transfer.status === "SUCCESSFUL") {
    await completePayout(order, payout.id);
  } else if (transfer.status === "FAILED") {
    await prisma.payout.update({
      where: { id: payout.id },
      data: { status: "FAILED" },
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "PAYOUT_FAILED" },
    });
  }
}

async function completePayout(order: any, payoutId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.payout.update({
      where: { id: payoutId },
      data: { status: "SUCCESSFUL" },
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    const bookTxId = `sell_payout:${order.id}`;
    const payoutKobo = order.ngnAmountKobo - order.feeKobo;
    await postTx(tx, bookTxId, order.id, [
      {
        account: "USER_CLEARING_INJ",
        asset: "INJ",
        amountBase: order.injAmountBase,
        direction: "debit",
      },
      {
        account: "TREASURY_INJ",
        asset: "INJ",
        amountBase: order.injAmountBase,
        direction: "credit",
      },
    ], "sell_inj_consumed");

    // NGN leaves inventory: payout to the user (= gross - fee, exactly what
    // was reserved at quote time, including FLW's own transfer fee).
    await postTx(tx, bookTxId, order.id, [
      {
        account: "EXTERNAL_USER_NGN",
        asset: "NGN",
        amountBase: payoutKobo.toString(),
        direction: "debit",
      },
      {
        account: "TREASURY_NGN_FLW",
        asset: "NGN",
        amountBase: payoutKobo.toString(),
        direction: "credit",
      },
    ], "payout");

    // Platform fee recognized as revenue (it never left inventory).
    await postTx(tx, bookTxId, order.id, [
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
    ], "payout_fee");

    // Release the NGN reservation made at quote time (payout + FLW fee = gross - fee).
    await tx.$executeRaw`SELECT id FROM treasury WHERE id = 1 FOR UPDATE`;
    const treasury = await tx.treasuryState.findUnique({ where: { id: 1 } });
    if (treasury) {
      const reserved = BigInt(treasury.reservedNgnKobo);
      const newReserved = reserved > payoutKobo ? reserved - payoutKobo : 0n;
      if (reserved < payoutKobo) {
        log.warn(
          { orderId: order.id, reserved: reserved.toString(), release: payoutKobo.toString() },
          "reservedNgnKobo below expected value at payout; clamping to zero",
        );
      }
      await tx.treasuryState.update({
        where: { id: 1 },
        data: { reservedNgnKobo: newReserved },
      });
    }

    await tx.outboxJob.create({
      data: {
        kind: "notify-sell-complete",
        payload: { orderId: order.id },
      },
    });
  });

  log.info(
    { orderId: order.id, publicId: order.publicId },
    "Payout completed",
  );
}
