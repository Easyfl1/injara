import { Context, SessionFlavor, session } from "grammy";
import {
  type Conversation,
  type ConversationFlavor,
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { RedisAdapter } from "@grammyjs/storage-redis";
import { limit } from "@grammyjs/ratelimiter";
import { Bot } from "grammy";
import { getEnv } from "../config/env.js";
import { getRedis } from "../redis/client.js";
import { prisma } from "../db/prisma.js";
import { childLogger } from "../utils/logger.js";
import { buyConversation } from "./conversations/buy.js";
import { sellConversation } from "./conversations/sell.js";
import { collectEmailConversation } from "./conversations/collect-email.js";
import { manageBanksConversation } from "./conversations/manage-banks.js";
import { mainMenu, adminMenu } from "./menus.js";
import { handleCallbacks } from "./callbacks.js";
import { isAdmin } from "./admin/utils.js";
import { assignWalletToUser } from "../services/wallet.js";
import { getBankBalance } from "../services/injective.js";
import { injBaseToHuman } from "../domain/money.js";

const log = childLogger({ module: "bot" });

export type SessionData = Record<string, never>;
export type BaseContext = Context & SessionFlavor<SessionData>;
export type MyContext = BaseContext & ConversationFlavor<BaseContext>;
export type MyConversation = Conversation<BaseContext>;

export function createBot(): Bot<MyContext> {
  const env = getEnv();
  const bot = new Bot<MyContext>(env.TELEGRAM_BOT_TOKEN);

  const redis = getRedis();
  const storage = new RedisAdapter({
    instance: redis,
  });

  bot.use(
    session({
      storage,
      initial: (): SessionData => ({}),
    }),
  );

  bot.use(
    limit({
      timeFrame: 60_000,
      limit: 20,
      keyGenerator: (ctx) => String(ctx.from?.id ?? 0),
    }),
  );

  bot.use(async (ctx, next) => {
    if (!ctx.from) return;

    const user = await prisma.user.upsert({
      where: { telegramId: String(ctx.from.id) },
      create: {
        telegramId: String(ctx.from.id),
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      },
      update: {
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      },
    });

    if (user.isBanned) {
      return ctx.reply("Your account has been suspended. Contact support.");
    }

    const env = getEnv();
    if (env.MAINTENANCE_MODE && !isAdmin(ctx.from.id)) {
      return ctx.reply("System is under maintenance. Please try again later.");
    }

    if (
      env.ALLOWED_TELEGRAM_IDS &&
      !env.ALLOWED_TELEGRAM_IDS.split(",").includes(String(ctx.from.id))
    ) {
      return ctx.reply("You are not in the allowed list. This is a private beta.");
    }

    return next();
  });

  bot.use(conversations() as any);
  bot.use(createConversation(buyConversation as any, "buy") as any);
  bot.use(createConversation(sellConversation as any, "sell") as any);
  bot.use(createConversation(collectEmailConversation as any, "collect-email") as any);
  bot.use(createConversation(manageBanksConversation as any, "manage-banks") as any);

  bot.command("start", async (ctx) => {
    log.info("Received /start from %s", ctx.from?.id);
    try {
      const userId = String(ctx.from?.id);

      const user = await prisma.user.findUnique({ where: { telegramId: userId } });
      if (!user) {
        await ctx.reply("Something went wrong. Please try again.");
        return;
      }

      let wallet;
      try {
        wallet = await assignWalletToUser(user.id);
      } catch (err) {
        log.error({ err }, "Failed to generate wallet");
        await ctx.reply("Failed to generate wallet. Please contact support.", {
          reply_markup: mainMenu(),
        });
        return;
      }

      let injBalanceHuman = "0";
      let ngnBalanceHuman = "₦0.00";

      try {
        const injBalanceBase = await getBankBalance(wallet.injAddress);
        injBalanceHuman = injBaseToHuman(injBalanceBase);
      } catch {
        log.warn({ address: wallet.injAddress }, "Failed to fetch INJ balance");
      }

      const welcomeMsg = [
        "Welcome to Injara!",
        "",
        "<b>Wallet</b>",
        `ID: <code>${wallet.walletId}</code>`,
        `Address: <code>${wallet.injAddress}</code>`,
        "",
        "<b>Balances</b>",
        `₦ Account: ${ngnBalanceHuman}`,
        `INJ Balance: ${injBalanceHuman} INJ`,
        "",
        "You can now buy or sell INJ.",
      ].join("\n");

      await ctx.reply(welcomeMsg, {
        parse_mode: "HTML",
        reply_markup: mainMenu(),
      });
      log.info("Replied to /start from %s", ctx.from?.id);
    } catch (err) {
      log.error({ err }, "Failed to reply to /start");
    }
  });

  bot.command("cancel", async (ctx) => {
    await ctx.conversation.exit("buy");
    await ctx.conversation.exit("sell");
    await ctx.conversation.exit("collect-email");
    await ctx.reply("Cancelled.", { reply_markup: mainMenu() });
  });

  bot.command("admin", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      return ctx.reply("Not authorized.");
    }
    await ctx.reply("Admin Panel", { reply_markup: adminMenu() });
  });

  bot.on("callback_query:data", handleCallbacks);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot.catch((err: any) => {
    log.error({ err }, "Bot error");
  });

  return bot;
}
