import type { MyContext } from "./bot.js";
import { prisma } from "../db/prisma.js";
import { injBaseToHuman, koboToNgnString } from "../domain/money.js";
import { mainMenu } from "./menus.js";
import { isAdmin } from "./admin/utils.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ module: "callbacks" });

export async function handleCallbacks(ctx: MyContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  if (data.startsWith("m:")) {
    await handleMenuCallback(ctx, data.slice(2));
  } else if (data.startsWith("q:")) {
    await handleQuoteCallback(ctx, data.slice(2));
  } else if (data.startsWith("a:")) {
    await handleAdminCallback(ctx, data.slice(2));
  }
}

async function handleMenuCallback(ctx: MyContext, action: string): Promise<void> {
  const env = (await import("../config/env.js")).getEnv();

  switch (action) {
    case "buy": {
      if (!env.BUY_ENABLED) {
        await ctx.reply("Buy is currently disabled.");
        return;
      }
      await ctx.conversation.enter("buy");
      break;
    }
    case "sell": {
      if (!env.SELL_ENABLED) {
        await ctx.reply("Sell is currently disabled.");
        return;
      }
      await ctx.conversation.enter("sell");
      break;
    }
    case "status": {
      const userId = String(ctx.from?.id);
      const user = await prisma.user.findUnique({
        where: { telegramId: userId },
      });
      if (!user) {
        await ctx.reply("Please /start first.");
        return;
      }

      const orders = await prisma.order.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 5,
      });

      if (orders.length === 0) {
        await ctx.reply("No orders found.", { reply_markup: mainMenu() });
        return;
      }

      const lines = orders.map((o) => {
        const inj = injBaseToHuman(o.injAmountBase);
        const ngn = koboToNgnString(o.ngnAmountKobo);
        return `${o.publicId} | ${o.orderType} | ${o.status} | ${inj} INJ | NGN ${ngn}`;
      });

      await ctx.reply(
        `Recent Orders\n\n${lines.join("\n")}`,
        { reply_markup: mainMenu() },
      );
      break;
    }
    case "hist": {
      await handleMenuCallback(ctx, "status");
      break;
    }
    case "help": {
      const helpText = [
        "Injara Help",
        "",
        "Buy INJ:",
        "1. Click 'Buy INJ'",
        "2. Enter amount of INJ you want",
        "3. Confirm the quote (locked for 3 minutes)",
        "4. Pay via Flutterwave (card, bank transfer, USSD)",
        "5. INJ is sent to your Injective address automatically",
        "",
        "Sell INJ:",
        "1. Click 'Sell INJ'",
        "2. Enter amount of INJ to sell",
        "3. Confirm the quote",
        "4. Send INJ to the treasury address with the memo",
        "5. NGN is sent to your bank account",
        "",
        "Important:",
        "- No-KYC limit: NGN 100,000 per order/day",
        "- Lifetime limit: NGN 500,000",
        "- Payment window: 45 minutes",
        "- Deposit window: 15 minutes",
        "",
        "For support, click 'Support' and describe your issue.",
      ].join("\n");

      await ctx.reply(helpText, { reply_markup: mainMenu() });
      break;
    }
    case "support": {
      await ctx.reply(
        "Please describe your issue. Include your order ID if you have one.\n\nOur team will respond shortly.",
        { reply_markup: mainMenu() },
      );
      break;
    }
    case "banks": {
      await ctx.conversation.enter("manage-banks");
      break;
    }
    case "back": {
      await ctx.reply("Main Menu:", { reply_markup: mainMenu() });
      break;
    }
  }
}

async function handleQuoteCallback(ctx: MyContext, action: string): Promise<void> {
  const [type, publicId] = action.split(":");
  if (!type || !publicId) return;

  if (type === "ok") {
    await handleQuoteAccept(ctx, publicId);
  } else if (type === "no") {
    await ctx.reply("Quote cancelled.", { reply_markup: mainMenu() });
  }
}

async function handleQuoteAccept(ctx: MyContext, publicId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { publicId },
    });

    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }

    if (order.orderType === "BUY") {
      const { acceptBuyQuote } = await import("../services/orders.js");
      const result = await acceptBuyQuote(order.id);
      await ctx.reply(
        [
          "Quote accepted!",
          "",
          "Click below to pay:",
          "Payment window: 45 minutes",
          "",
          `Amount: NGN ${koboToNgnString(order.ngnAmountKobo + order.feeKobo)}`,
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Pay Now", url: result.paymentLink }],
            ],
          },
        },
      );
    }
  } catch (err) {
    log.error({ err, publicId }, "Failed to accept quote");
    await ctx.reply(
      `Error: ${(err as Error).message}`,
      { reply_markup: mainMenu() },
    );
  }
}

async function handleAdminCallback(ctx: MyContext, action: string): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply("Not authorized.");
    return;
  }

  switch (action) {
    case "treasury": {
      const { getTreasury, availableInj } = await import("../services/treasury.js");
      const treasury = await getTreasury();
      const available = availableInj(treasury);

      await ctx.reply(
        [
          "Treasury Balance",
          "",
          `On-chain INJ: ${injBaseToHuman(treasury.onchainInjBase)} INJ`,
          `Reserved INJ: ${injBaseToHuman(treasury.reservedInjBase)} INJ`,
          `Available INJ: ${injBaseToHuman(available)} INJ`,
          `Gas Buffer: ${injBaseToHuman(treasury.gasBufferInjBase)} INJ`,
          "",
          `FLW NGN: NGN ${koboToNgnString(treasury.flwAvailableNgnKobo)}`,
          `Reserved NGN: NGN ${koboToNgnString(treasury.reservedNgnKobo)}`,
          "",
          `Last synced: ${treasury.lastSyncedAt.toISOString()}`,
        ].join("\n"),
      );
      break;
    }
    case "pending": {
      const pending = await prisma.order.findMany({
        where: {
          status: {
            in: ["AWAITING_PAYMENT", "AWAITING_DEPOSIT", "DEPOSIT_DETECTED", "PAYOUT_PENDING"],
          },
        },
        take: 20,
      });

      if (pending.length === 0) {
        await ctx.reply("No pending orders.");
        return;
      }

      const lines = pending.map(
        (o) => `${o.publicId} | ${o.orderType} | ${o.status}`,
      );

      await ctx.reply(
        `Pending Orders (${pending.length})\n\n${lines.join("\n")}`,
      );
      break;
    }
    case "halt": {
      process.env.MAINTENANCE_MODE = "true";
      await ctx.reply("Trading halted.");
      break;
    }
    case "resume": {
      process.env.MAINTENANCE_MODE = "false";
      await ctx.reply("Trading resumed.");
      break;
    }
    default:
      await ctx.reply(`Admin action: ${action}`);
  }
}
