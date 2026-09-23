import type { MyContext, MyConversation } from "../bot.js";
import { injBaseToHuman, koboToNgnString, injHumanToBase } from "../../domain/money.js";
import { createSellQuote } from "../../services/orders.js";
import { quoteConfirmKeyboard, mainMenu } from "../menus.js";
import { prisma } from "../../db/prisma.js";
import { childLogger } from "../../utils/logger.js";
import { getBankBalance } from "../../services/injective.js";

const log = childLogger({ conversation: "sell" });

export async function sellConversation(
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
    "Enter the amount of INJ you want to sell (e.g., 2):",
  );

  const amountCtx = await conversation.waitFor("message:text");
  const injAmount = amountCtx.message.text.trim();

  if (!/^\d+(\.\d{1,8})?$/.test(injAmount)) {
    await ctx.reply("Invalid amount. Please enter a numeric value.", {
      reply_markup: mainMenu(),
    });
    return;
  }

  let userInjBalanceBase = "0";
  try {
    userInjBalanceBase = await getBankBalance(user.injAddress);
  } catch {
    log.warn({ address: user.injAddress }, "Failed to fetch INJ balance");
  }

  const injAmountBase = injHumanToBase(injAmount);
  if (BigInt(injAmountBase) > BigInt(userInjBalanceBase)) {
    const userBalHuman = injBaseToHuman(userInjBalanceBase);
    await ctx.reply(
      `Insufficient INJ balance. You want to sell ${injAmount} INJ but have ${userBalHuman} INJ.`,
      { reply_markup: mainMenu() },
    );
    return;
  }

  let quote;
  try {
    const accounts = await conversation.external(() =>
      prisma.bankAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    );
    if (accounts.length === 0) {
      await ctx.reply("No bank account added. Go to 'Bank Accounts' to add one.", { reply_markup: mainMenu() });
      return;
    }
    quote = await conversation.external(() =>
      createSellQuote(user!.id, injAmount, accounts[0].id),
    );
  } catch (err) {
    log.error({ err, userId }, "Failed to create sell quote");
    await ctx.reply(
      `Error: ${(err as Error).message}`,
      { reply_markup: mainMenu() },
    );
    return;
  }

  const injHuman = injBaseToHuman(quote.injAmountBase);
  const ngnHuman = koboToNgnString(BigInt(quote.ngnAmountKobo));
  const feeHuman = koboToNgnString(BigInt(quote.feeKobo));
  const payoutHuman = koboToNgnString(BigInt(quote.payableKobo));

  const quoteMsg = [
    "Sell Quote",
    "",
    `INJ Amount: ${injHuman} INJ`,
    "",
    `NGN Gross: NGN ${ngnHuman}`,
    `Platform Fee: NGN ${feeHuman}`,
    `You Receive: NGN ${payoutHuman}`,
    "",
    `Quote valid for 3 minutes`,
    "",
    `Order ID: ${quote.publicId}`,
  ].join("\n");

  await ctx.reply(quoteMsg, {
    reply_markup: quoteConfirmKeyboard(quote.publicId),
  });
}
