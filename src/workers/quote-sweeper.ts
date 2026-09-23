import { prisma } from "../db/prisma.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ worker: "quote-sweeper" });

export async function runQuoteSweeper(): Promise<void> {
  const POLL_INTERVAL = 15_000;

  log.info("Quote sweeper started");

  while (true) {
    try {
      const now = new Date();
      const expired = await prisma.order.updateMany({
        where: {
          status: "QUOTED",
          quoteExpiresAt: { lte: now },
        },
        data: { status: "EXPIRED" },
      });

      if (expired.count > 0) {
        log.info({ count: expired.count }, "Expired stale quotes");
      }
    } catch (err) {
      log.error({ err }, "Quote sweeper error");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
