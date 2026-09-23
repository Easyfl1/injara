import { prisma } from "../../db/prisma.js";
import { broadcastMsgSend, searchByMemo, fetchTxByHash, getLatestHeight } from "../../services/injective.js";
import { postTx } from "../../services/ledger.js";
import { acquireTreasuryLock } from "../../redis/locks.js";
import { childLogger } from "../../utils/logger.js";

const log = childLogger({ processor: "send-inj" });

const MEMO = (publicId: string) => `INJARA-${publicId}`;

export async function processSendInj(job: any): Promise<void> {
  const { orderId } = job.payload;

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { user: true },
  });

  // States that can reach the send step: first entry (from PAYMENT_CONFIRMED)
  // and every retryable in-flight state. Returning "successfully" on states
  // that will never reach the send step prevents a dead job from blocking
  // anything, but keeps genuinely stuck orders out of the hot path.
  const ELIGIBLE = [
    "PAYMENT_CONFIRMED",   // first attempt
    "TREASURY_SENDING",    // crash/retry mid-send (recovery path below)
    "SEND_FAILED",         // admin/worker retry
  ];
  if (!ELIGIBLE.includes(order.status)) {
    log.info({ orderId, status: order.status }, "Order not eligible for send");
    return;
  }

  // Guard against unbounded retries for genuinely broken sends.
  if (order.sendAttempts >= 10) {
    log.error({ orderId, attempts: order.sendAttempts }, "Send attempts exhausted - MANUAL_REVIEW");
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "MANUAL_REVIEW",
        failureReason: `Send attempts exhausted (${order.sendAttempts})`,
      },
    });
    return;
  }

  // ── Recovery path 1: a send was already broadcast for this memo ──────────
  // Reachable on every retry because TREASURY_SENDING is eligible above.
  const memo = MEMO(order.publicId);
  const existingTx = await searchByMemo(memo);
  if (existingTx.length > 0) {
    const tx = existingTx[0]!;
    if (tx.code === 0) {
      log.info({ memo, txHash: tx.txHash }, "Found existing send by memo");
      await completeSend(order, tx.txHash, tx.height);
      return;
    }
    log.warn({ memo, code: tx.code }, "Existing memo tx failed on-chain; will rebroadcast");
  }

  // ── Recovery path 2: we recorded a broadcastTxHash in a previous attempt ──
  if (order.broadcastTxHash) {
    const result = await fetchTxByHash(order.broadcastTxHash);
    if (result) {
      if (result.code === 0) {
        await completeSend(order, order.broadcastTxHash, result.height);
        return;
      }
      // Definitely failed on-chain: clear the hash and fall through to rebroadcast.
      log.warn({ orderId, hash: order.broadcastTxHash, code: result.code }, "Recorded tx failed; rebroadcasting");
      await prisma.order.update({
        where: { id: orderId },
        data: { broadcastTxHash: null },
      });
    } else {
      // Not yet indexed — could be pending mempool. Keep order in
      // TREASURY_SENDING and requeue ourselves with a delay so polling
      // continues instead of silently dying.
      log.info({ orderId, hash: order.broadcastTxHash }, "Tx not yet indexed; requeueing");
      await requeueSendInj(orderId);
      return;
    }
  }

  // Mark in-flight BEFORE broadcast so a crash after broadcast is recoverable
  // via the memo search / broadcastTxHash paths above.
  if (order.status !== "TREASURY_SENDING") {
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "TREASURY_SENDING",
        treasurySendingAt: new Date(),
      },
    });
  }

  const lock = await acquireTreasuryLock();
  try {
    const result = await broadcastMsgSend({
      to: order.injAddress,
      amountBase: order.injAmountBase,
      memo,
    });

    await prisma.order.update({
      where: { id: orderId },
      data: {
        broadcastTxHash: result.txHash,
        sendAttempts: { increment: 1 },
      },
    });

    if (result.code === 0) {
      await waitForDepth(order, result.txHash, result.height);
    } else {
      log.error({ orderId, code: result.code }, "Send broadcast failed");
      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: "SEND_FAILED",
          failureReason: `Code ${result.code}`,
        },
      });
    }
  } catch (err) {
    // Throwing keeps the job retryable (outbox attempts++ / backoff).
    log.error({ err, orderId }, "Send processor error");
    throw err;
  } finally {
    await lock.release();
  }
}

async function requeueSendInj(orderId: string): Promise<void> {
  const { getEnv } = await import("../../config/env.js");
  const env = getEnv();
  const delaySec = env.UNKNOWN_POLL_SEC ?? 60;

  await prisma.outboxJob.create({
    data: {
      kind: "send-inj",
      payload: { orderId, idempotencyKey: `send:${orderId}` },
      runAfter: new Date(Date.now() + delaySec * 1000),
    },
  });
}

async function waitForDepth(
  order: any,
  txHash: string,
  height?: bigint,
): Promise<void> {
  const { getEnv } = await import("../../config/env.js");
  const env = getEnv();
  const CONFIRMATION_DEPTH = env.CONFIRMATION_DEPTH;

  if (!height) {
    const result = await fetchTxByHash(txHash);
    if (!result || result.code !== 0) {
      // Broadcast may still be propagating; requeue instead of declaring failure.
      log.warn({ orderId: order.id, txHash }, "Tx not found at depth check start; requeueing");
      await requeueSendInj(order.id);
      return;
    }
    height = result.height;
  }

  const checkInterval = 3000;
  const maxWait = 60_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const latestHeight = await getLatestHeight();
    if (latestHeight - height! >= BigInt(CONFIRMATION_DEPTH)) {
      await completeSend(order, txHash, height!);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  // Depth not reached within the poll window: requeue rather than
  // marking complete without confirmations or leaving the job dead.
  log.warn({ orderId: order.id, txHash }, "Depth wait timed out; requeueing");
  await requeueSendInj(order.id);
}

async function completeSend(
  order: any,
  txHash: string,
  _height: bigint,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "COMPLETED",
        txHash,
        completedAt: new Date(),
      },
    });

    const bookTxId = `buy_send:${order.id}`;
    await postTx(tx, bookTxId, order.id, [
      {
        account: "EXTERNAL_USER_INJ",
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
    ], "send");

    await tx.outboxJob.create({
      data: {
        kind: "notify-buy-complete",
        payload: { orderId: order.id },
      },
    });
  });

  log.info(
    { orderId: order.id, publicId: order.publicId, txHash },
    "INJ sent successfully",
  );
}
