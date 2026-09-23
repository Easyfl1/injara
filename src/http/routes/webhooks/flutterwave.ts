import type { FastifyInstance } from "fastify";
import { safeEqual } from "../../../utils/crypto.js";
import { getEnv } from "../../../config/env.js";
import { prisma } from "../../../db/prisma.js";
import { childLogger } from "../../../utils/logger.js";

const log = childLogger({ route: "flw-webhook" });

interface FlwWebhook {
  event: string;
  data: {
    id: number;
    status: string;
    amount: string;
    currency: string;
    tx_ref: string;
    reference?: string;
  };
}

export async function flutterwaveWebhook(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/flutterwave", async (req, reply) => {
    const env = getEnv();
    const verifHash = String(req.headers["verif-hash"] ?? "");

    if (!safeEqual(verifHash, env.FLW_SECRET_HASH)) {
      return reply.code(401).send();
    }

    const payload = req.body as FlwWebhook;

    if (!payload?.data) {
      return reply.code(200).send({ ok: true });
    }

    const fingerprint = `flutterwave:${payload.data.id}:${payload.event}:${payload.data.status}`;

    try {
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.webhookEvent.findUnique({
          where: { fingerprint },
        });

        if (existing) {
          if (existing.processedAt) return;

          await tx.$executeRaw`
            SELECT id FROM webhook_events
            WHERE fingerprint = ${fingerprint}
            FOR UPDATE
          `;

          const row = await tx.webhookEvent.findUniqueOrThrow({
            where: { fingerprint },
          });

          if (row.processedAt) return;

          await ensureOutbox(tx, row.id, payload);
          return;
        }

        const kind = outboxKind(payload);

        const row = await tx.webhookEvent.create({
          data: {
            fingerprint,
            provider: "flutterwave",
            event: payload.event,
            payload: payload as any,
            signatureValid: true,
            flwId: String(payload.data.id ?? ""),
            txRef: payload.data.tx_ref ?? payload.data.reference ?? null,
            status: payload.data.status ?? null,
          },
        });

        await enqueueOutbox(tx, row.id, kind);
      });
    } catch (err) {
      if ((err as any)?.code === "P2002") {
        log.info({ fingerprint }, "Webhook duplicate (P2002)");
      } else {
        log.error({ err, fingerprint }, "Webhook processing error");
      }
    }

    return reply.code(200).send({ ok: true });
  });
}

function outboxKind(payload: FlwWebhook): string {
  if (
    payload.event === "charge.completed" &&
    payload.data?.status === "successful"
  ) {
    return "process-flw-charge";
  }
  if (payload.event === "charge.completed") {
    return "ignore-flw-charge-attempt";
  }
  if (payload.event === "transfer.completed") {
    return "process-flw-transfer";
  }
  if (
    payload.event === "chargeback.created" ||
    payload.event === "chargeback.updated"
  ) {
    return "process-flw-chargeback";
  }
  return "ignore-flw-unknown";
}

async function ensureOutbox(
  tx: any,
  webhookEventId: string,
  payload: FlwWebhook,
): Promise<void> {
  const kind = outboxKind(payload);
  await tx.outboxJob.upsert({
    where: {
      id: webhookEventId,
    },
    create: {
      kind,
      payload: { webhookEventId },
      webhookEventId,
    },
    update: {},
  });
}

async function enqueueOutbox(
  tx: any,
  webhookEventId: string,
  kind: string,
): Promise<void> {
  await tx.outboxJob.create({
    data: {
      kind,
      payload: { webhookEventId },
      webhookEventId,
    },
  });
}
