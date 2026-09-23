import { getEnv } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { prisma } from "./db/prisma.js";
import { connectRedis, disconnectRedis } from "./redis/client.js";
import { buildServer } from "./http/server.js";
import { flutterwaveWebhook } from "./http/routes/webhooks/flutterwave.js";
import { paymentsCallback } from "./http/routes/payments-callback.js";
import { telegramRoute } from "./http/routes/telegram.js";
import { createBot } from "./bot/bot.js";
import { setBot } from "./services/notifications.js";
import { runOutboxProcessor } from "./workers/outbox-processor.js";
import { runPaymentWindowSweeper } from "./workers/payment-window-sweeper.js";
import { runQuoteSweeper } from "./workers/quote-sweeper.js";
import { runDepositWindowSweeper } from "./workers/deposit-window-sweeper.js";
import { runDepositWatcher } from "./workers/deposit-watcher.js";

const log = logger;

async function main() {
  const env = getEnv();

  log.info({ role: env.PROCESS_ROLE }, "Starting Injara");

  await connectRedis();

  if (env.PROCESS_ROLE === "app") {
    await startApp(env);
  } else {
    await startWorker(env);
  }
}

async function startApp(env: ReturnType<typeof getEnv>) {
  const app = await buildServer();

  await app.register(flutterwaveWebhook);
  await app.register(paymentsCallback);

  const bot = createBot() as any;
  setBot(bot);

  await app.register((instance) => telegramRoute(instance, bot));

  const port = parseInt(process.env.PORT ?? "3000", 10);
  await app.listen({ port, host: "0.0.0.0" });

  log.info({ port }, "HTTP server started");

  if (env.TELEGRAM_MODE === "polling") {
    bot.start({
      onStart: () => log.info("Bot started with polling"),
    });
  } else {
    const webhookUrl = `${env.PUBLIC_BASE_URL}/telegram/webhook`;
    await bot.api.setWebhook(webhookUrl, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    });
    log.info({ webhookUrl }, "Bot webhook set");
  }
}

async function startWorker(env: ReturnType<typeof getEnv>) {
  log.info("Starting worker processes");

  const processors = [
    runOutboxProcessor(),
    runPaymentWindowSweeper(),
    runQuoteSweeper(),
    runDepositWindowSweeper(),
  ];

  if (env.DEPOSIT_MODE === "memo") {
    processors.push(runDepositWatcher());
  }

  await Promise.all(processors);
}

process.on("SIGTERM", async () => {
  log.info("SIGTERM received, shutting down");
  await prisma.$disconnect();
  await disconnectRedis();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log.info("SIGINT received, shutting down");
  await prisma.$disconnect();
  await disconnectRedis();
  process.exit(0);
});

main().catch((err) => {
  log.error({ err }, "Fatal error");
  process.exit(1);
});
