import { prisma } from "../db/prisma.js";
import { searchByMemo, getLatestHeight } from "../services/injective.js";
import { addBase, cmpBase } from "../domain/money.js";
import { postTx } from "../services/ledger.js";
import { DUST_THRESHOLD_INJ_BASE } from "../config/constants.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ worker: "deposit-watcher" });

export async function runDepositWatcher(): Promise<void> {
  const POLL_INTERVAL = 4_000;

  log.info("Deposit watcher started");

  let lastHeight = 0n;

  const cursor = await prisma.chainCursor.findUnique({ where: { id: "deposit" } });
  if (cursor) {
    lastHeight = cursor.lastHeight;
  }

  while (true) {
    try {
      const latestHeight = await getLatestHeight();
      if (latestHeight <= lastHeight) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const orders = await prisma.order.findMany({
        where: {
          orderType: "SELL",
          status: { in: ["AWAITING_DEPOSIT", "DEPOSIT_DETECTED"] },
          depositWindowEndsAt: { gte: new Date() },
          depositMemo: { not: null },
        },
      });

      for (const order of orders) {
        if (!order.depositMemo) continue;

        const txs = await searchByMemo(
          order.depositMemo,
          Number(lastHeight),
        );

        for (const tx of txs) {
          if (tx.denom !== "inj" || tx.code !== 0) continue;

          const processed = await prisma.processedChainTx.findUnique({
            where: { txHash: tx.txHash },
          });
          if (processed) continue;

          await prisma.$transaction(async (prismaTx) => {
            await prismaTx.processedChainTx.create({
              data: {
                txHash: tx.txHash,
                height: tx.height,
                kind: "deposit",
                orderId: order.id,
              },
            });

            const currentDeposit = order.depositInjBase;
            const newDeposit = addBase(currentDeposit, tx.amount);

            await prismaTx.order.update({
              where: { id: order.id },
              data: {
                depositInjBase: newDeposit,
                status: "DEPOSIT_DETECTED",
                depositDetectedAt: order.depositDetectedAt ?? new Date(),
              },
            });
          });

          order.depositInjBase = addBase(order.depositInjBase, tx.amount);
        }

        if (cmpBase(order.depositInjBase, "0") > 0) {
          const expected = order.injAmountBase;
          const dust = BigInt(DUST_THRESHOLD_INJ_BASE);
          const expectedBigInt = BigInt(expected);
          const depositBigInt = BigInt(order.depositInjBase);

          const diff = depositBigInt > expectedBigInt
            ? depositBigInt - expectedBigInt
            : expectedBigInt - depositBigInt;

          if (diff <= dust) {
            log.info(
              { orderId: order.id, deposit: order.depositInjBase },
              "Deposit confirmed within dust band",
            );

            await prisma.$transaction(async (tx) => {
              await tx.order.update({
                where: { id: order.id },
                data: { status: "DEPOSIT_CONFIRMED" },
              });

              await tx.outboxJob.create({
                data: {
                  kind: "payout-ngn",
                  payload: {
                    orderId: order.id,
                    idempotencyKey: `payout:${order.id}`,
                  },
                },
              });

              const bookTxId = `sell_deposit:${order.id}`;
              await postTx(tx, bookTxId, order.id, [
                {
                  account: "TREASURY_INJ",
                  asset: "INJ",
                  amountBase: order.depositInjBase,
                  direction: "debit",
                },
                {
                  account: "USER_CLEARING_INJ",
                  asset: "INJ",
                  amountBase: order.depositInjBase,
                  direction: "credit",
                },
              ], "deposit");
            });
          }
        }
      }

      await prisma.chainCursor.upsert({
        where: { id: "deposit" },
        create: { id: "deposit", lastHeight: latestHeight },
        update: { lastHeight: latestHeight },
      });

      lastHeight = latestHeight;
    } catch (err) {
      log.error({ err }, "Deposit watcher error");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
