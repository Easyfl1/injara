import { prisma } from "../db/prisma.js";
import { childLogger } from "../utils/logger.js";
import { postTx } from "../services/ledger.js";

const log = childLogger({ worker: "deposit-window-sweeper" });

/**
 * SELL orders whose deposit window lapsed without a confirmed INJ deposit.
 * Expires the order and releases the NGN reserved at quote time, so
 * reservedNgnKobo no longer leaks and NGN availability recovers.
 */
export async function runDepositWindowSweeper(): Promise<void> {
  const POLL_INTERVAL = 15_000;

  log.info("Deposit window sweeper started");

  while (true) {
    try {
      const orders = await prisma.order.findMany({
        where: {
          orderType: "SELL",
          status: { in: ["AWAITING_DEPOSIT", "DEPOSIT_DETECTED"] },
          depositWindowEndsAt: { lt: new Date() },
        },
        take: 50,
      });

      for (const order of orders) {
        await expireSellOrder(order);
      }
    } catch (err) {
      log.error({ err }, "Deposit window sweeper error");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function expireSellOrder(order: {
  id: string;
  publicId: string;
  injAmountBase: string;
  status: string;
}): Promise<void> {
  const expired = await prisma.$transaction(async (tx) => {
    // CAS: only expire if still awaiting deposit. A late deposit detection
    // (deposit-watcher) races this; whoever wins, the state stays consistent.
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id,
        status: { in: ["AWAITING_DEPOSIT", "DEPOSIT_DETECTED"] },
      },
      data: { status: "EXPIRED" },
    });
    if (claimed.count === 0) return false;

    // Release the NGN reserved at quote time: payout = gross - fee
    // (= payout + FLW payout fee, exactly what createSellQuote reserved).
    const o = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    const releaseKobo = o.ngnAmountKobo - o.feeKobo;

    await tx.$executeRaw`SELECT id FROM treasury WHERE id = 1 FOR UPDATE`;
    const treasury = await tx.treasuryState.findUnique({ where: { id: 1 } });
    if (treasury) {
      const reserved = BigInt(treasury.reservedNgnKobo);
      const release = BigInt(releaseKobo);
      if (reserved < release) {
        log.warn(
          { orderId: order.id, reserved: reserved.toString(), release: release.toString() },
          "reservedNgnKobo below expected value at sell expiry; clamping to zero",
        );
      }
      const newReserved = reserved > release ? reserved - release : 0n;
      await tx.treasuryState.update({
        where: { id: 1 },
        data: { reservedNgnKobo: newReserved },
      });
    }

    // No INJ arrived, so there is nothing to unreserve on the INJ side.
    // SELL orders never reserve INJ; the ledger posting below only closes
    // the bookkeeping if a partial deposit slipped through unconfirmed.
    if (o.depositInjBase && BigInt(o.depositInjBase) > 0n) {
      const bookTxId = `sell_expire:${order.id}`;
      await postTx(tx, bookTxId, order.id, [
        {
          account: "USER_CLEARING_INJ",
          asset: "INJ",
          amountBase: o.depositInjBase,
          direction: "debit",
        },
        {
          account: "TREASURY_INJ",
          asset: "INJ",
          amountBase: o.depositInjBase,
          direction: "credit",
        },
      ], "expire_partial_deposit");
    }

    return true;
  });

  if (!expired) return;

  const { notifyOrderExpired } = await import("../services/notifications.js");
  const full = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { user: true },
  });
  await notifyOrderExpired(full as any).catch(() => {});

  log.info({ orderId: order.id, publicId: order.publicId }, "Sell order expired, NGN reservation released");
}
