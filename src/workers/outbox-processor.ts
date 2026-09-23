import { prisma } from "../db/prisma.js";
import { childLogger } from "../utils/logger.js";
import { processFlwCharge } from "./processors/flw-charge.js";
import { processSendInj } from "./processors/send-inj.js";
import { processPayoutNgn } from "./processors/payout-ngn.js";
import {
  notifyBuyComplete,
  notifySellComplete,
  notifyAdmin,
} from "../services/notifications.js";

const log = childLogger({ worker: "outbox" });

const MAX_ATTEMPTS = 5;
const LEASE_STALE_MS = 5 * 60 * 1000; // reclaim jobs whose worker died mid-flight
const BACKOFF_STEPS_SEC = [10, 30, 120, 600] as const;

const HANDLERS: Record<string, (job: any) => Promise<void>> = {
  "process-flw-charge": processFlwCharge,
  "ignore-flw-charge-attempt": async (job) => {
    await prisma.webhookEvent.update({
      where: { id: job.webhookEventId },
      data: { processedAt: new Date() },
    });
  },
  "process-flw-transfer": async (job) => {
    log.info({ jobId: job.id }, "Processing FLW transfer webhook");
  },
  "process-flw-chargeback": async (job) => {
    log.info({ jobId: job.id }, "Processing FLW chargeback");
  },
  "ignore-flw-unknown": async (job) => {
    log.info({ jobId: job.id }, "Ignoring unknown FLW webhook event");
  },
  "send-inj": processSendInj,
  "payout-ngn": processPayoutNgn,

  // Notification jobs (previously created by processors but never handled)
  "notify-buy-complete": async (job) => {
    const order = await prisma.order.findUnique({
      where: { id: job.payload.orderId },
      include: { user: true },
    });
    if (order) await notifyBuyComplete(order as any);
  },
  "notify-sell-complete": async (job) => {
    const order = await prisma.order.findUnique({
      where: { id: job.payload.orderId },
      include: { user: true },
    });
    if (order) await notifySellComplete(order as any);
  },
};

export async function processOutboxJob(job: any): Promise<void> {
  const handler = HANDLERS[job.kind];
  if (!handler) {
    log.warn({ kind: job.kind, jobId: job.id }, "Unknown outbox job kind");
    await markProcessed(job.id, "unknown kind");
    return;
  }

  try {
    await handler(job);
    await markProcessed(job.id, null);
  } catch (err) {
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      log.error(
        { err, jobId: job.id, kind: job.kind, attempts },
        "Outbox job exhausted retries - dead-lettering",
      );
      await prisma.outboxJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError: `DEAD LETTER after ${attempts} attempts: ${(err as Error).message}`,
          lockedAt: null,
          lockedBy: null,
        },
      });
      await notifyAdmin(
        `Outbox job dead-lettered\nKind: ${job.kind}\nJob: ${job.id}\nError: ${(err as Error).message}`,
      ).catch(() => {});
    } else {
      const delaySec = BACKOFF_STEPS_SEC[Math.min(attempts - 1, BACKOFF_STEPS_SEC.length - 1)]!;
      log.warn(
        { err, jobId: job.id, kind: job.kind, attempts, retryInSec: delaySec },
        "Outbox job failed; will retry with backoff",
      );
      await prisma.outboxJob.update({
        where: { id: job.id },
        data: {
          attempts: { increment: 1 },
          lastError: (err as Error).message,
          // Future-dated runAfter = backoff; poller only picks up due jobs.
          runAfter: new Date(Date.now() + delaySec * 1000),
          lockedAt: null,
          lockedBy: null,
        },
      });
    }
  }
}

async function markProcessed(jobId: string, error: string | null): Promise<void> {
  await prisma.outboxJob.update({
    where: { id: jobId },
    data: {
      processedAt: new Date(),
      lastError: error,
      lockedAt: null,
      lockedBy: null,
    },
  });
}

export async function runOutboxProcessor(): Promise<void> {
  const POLL_INTERVAL = 2000;
  const INSTANCE_ID = `worker-${process.pid}-${Date.now()}`;

  log.info({ instanceId: INSTANCE_ID }, "Outbox processor started");

  while (true) {
    try {
      const now = new Date();
      const staleLeaseCutoff = new Date(now.getTime() - LEASE_STALE_MS);

      // Lease reclaim: a worker that crashed between claiming a job and
      // completing it leaves lockedAt set forever. Reclaim stale leases so
      // the job is retried (handlers are idempotent by design).
      await prisma.outboxJob.updateMany({
        where: {
          processedAt: null,
          lockedAt: { not: null, lt: staleLeaseCutoff },
        },
        data: {
          lockedAt: null,
          lockedBy: null,
          lastError: "lease reclaimed after stale lock",
        },
      });

      const jobs = await prisma.outboxJob.findMany({
        where: {
          processedAt: null,
          runAfter: { lte: now },
          lockedAt: null,
          attempts: { lt: MAX_ATTEMPTS },
        },
        orderBy: { createdAt: "asc" },
        take: 10,
      });

      for (const job of jobs) {
        const locked = await prisma.$executeRaw`
          UPDATE outbox_jobs
          SET locked_at = NOW(), locked_by = ${INSTANCE_ID}
          WHERE id = ${job.id} AND locked_at IS NULL
        `;

        if (locked === 0) continue;

        await processOutboxJob(job);
      }
    } catch (err) {
      log.error({ err }, "Outbox processor error");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
