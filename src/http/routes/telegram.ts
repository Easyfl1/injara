import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";
import { webhookCallback } from "grammy";
import { getEnv } from "../../config/env.js";

export async function telegramRoute(
  app: FastifyInstance,
  bot: Bot,
): Promise<void> {
  const env = getEnv();

  if (env.TELEGRAM_MODE === "webhook") {
    app.post(
      "/telegram/webhook",
      webhookCallback(bot, "fastify", {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      }),
    );
  }
}
