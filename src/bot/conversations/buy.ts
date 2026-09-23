import type { MyContext, MyConversation } from "../bot.js";
import { injBaseToHuman, koboToNgnString } from "../../domain/money.js";
import { createBuyQuote } from "../../services/orders.js";
import { quoteConfirmKeyboard, mainMenu } from "../menus.js";
import { prisma } from "../../db/prisma.js";
import { childLogger } from "../../utils/logger.js";
import { getEnv } from "../../config/env.js";

const log = childLogger({ conversation: "buy" });

export async function buyConversation(
  conversation: MyConversation,
  ctx: MyContext,
): Promise<void> {
  const userId = String(ctx.from?.id);

  const user = await conversation.external(() =>
    prisma.user.findUnique({ where: { telegramId: userId } }),
  );

  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  if (!user.injAddress) {
    await ctx.reply("Wallet not set. Please /start to generate your wallet.");
    return;
  }

  await ctx.reply(
    "Enter the amount of INJ you want to buy (e.g., 1.5):",
  );

  const amountCtx = await conversation.waitFor("message:text");
  const injAmount = amountCtx.message.text.trim();

  if (!/^\d+(\.\d{1,8})?$/.test(injAmount)) {
    await ctx.reply("Invalid amount. Please enter a numeric value.", {
      reply_markup: mainMenu(),
    });
    return;
  }

  const env = getEnv();
  const ngnBalanceKobo = env.FLW_NGN_BALANCE_KOBO ?? 0;
  const { getSpot } = await import("../../services/pricing.js");
  const price = await getSpot();
  const { buyPayableKobo } = await import("../../domain/money.js");
  const { payable } = buyPayableKobo(injAmount, price.injNgn, env.BUY_FEE_BPS);

  if (payable > BigInt(ngnBalanceKobo)) {
    await ctx.reply(
      `Insufficient NGN balance. You need NGN ${koboToNgnString(payable)} but have NGN ${koboToNgnString(BigInt(ngnBalanceKobo))}.`,
      { reply_markup: mainMenu() },
    );
    return;
  }

  let quote;
  try {
    quote = await conversation.external(() =>
      createBuyQuote(user!.id, injAmount),
    );
  } catch (err) {
    log.error({ err, userId }, "Failed to create buy quote");
    await ctx.reply(
      `Error: ${(err as Error).message}`,
      { reply_markup: mainMenu() },
    );
    return;
  }

  const injHuman = injBaseToHuman(quote.injAmountBase);
  const ngnHuman = koboToNgnString(BigInt(quote.ngnAmountKobo));
  const feeHuman = koboToNgnString(BigInt(quote.feeKobo));
  const payableHuman = koboToNgnString(BigInt(quote.payableKobo));

  const quoteMsg = [
    "Buy Quote",
    "",
    `INJ Amount: ${injHuman} INJ`,
    `INJ Price: NGN ${Number(price.injNgn).toLocaleString()}`,
    "",
    `NGN Subtotal: NGN ${ngnHuman}`,
    `Platform Fee: NGN ${feeHuman}`,
    `Total Payable: NGN ${payableHuman}`,
    "",
    `Quote valid for 3 minutes`,
    "",
    `Order ID: ${quote.publicId}`,
  ].join("\n");

  await ctx.reply(quoteMsg, {
    reply_markup: quoteConfirmKeyboard(quote.publicId),
  });
}
