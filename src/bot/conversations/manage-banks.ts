import type { MyContext, MyConversation } from "../bot.js";
import { prisma } from "../../db/prisma.js";
import { childLogger } from "../../utils/logger.js";
import { resolveBankAccount, storeBankAccount, getUserBankAccounts, listBanksNG } from "../../services/banking.js";
import { mainMenu, bankAccountKeyboard } from "../menus.js";

const log = childLogger({ conversation: "manage-banks" });

export async function manageBanksConversation(
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

  const accounts = await conversation.external(() => getUserBankAccounts(user.id));

  let msg = "Your Bank Accounts\n\n";
  if (accounts.length === 0) {
    msg += "No bank accounts added yet.";
  } else {
    accounts.forEach((acc, i) => {
      msg += `${i + 1}. ${acc.bankName}\n`;
      msg += `   ${acc.resolvedName} | ****${acc.accountNumberBlind.slice(-4)}\n\n`;
    });
  }
  msg += "\nChoose an action:";

  await ctx.reply(msg, {
    reply_markup: bankAccountKeyboard(accounts.map((a) => a.id)),
  });

  const actionCtx = await conversation.waitFor("callback_query:data");
  const action = actionCtx.callbackQuery?.data;

  if (!action) return;

  if (action === "add") {
    await addBankAccount(conversation, ctx, user.id);
  } else if (action.startsWith("del:")) {
    const bankId = action.split(":")[1];
    await deleteBankAccount(conversation, ctx, user.id, bankId);
  }
}

async function addBankAccount(
  conversation: MyConversation,
  ctx: MyContext,
  _userId: string,
): Promise<void> {
  const banks = await conversation.external(() => listBanksNG());

  if (banks.length === 0) {
    await ctx.reply("No banks available.", { reply_markup: mainMenu() });
    return;
  }

  await ctx.reply(
    "Enter the first 3 letters of your bank name (e.g., OPA for Opay, ACC for Access Bank):",
  );

  const searchCtx = await conversation.waitFor("message:text");
  const searchTerm = searchCtx.message.text.trim().toUpperCase();

  if (searchTerm.length < 3) {
    await ctx.reply("Please enter at least 3 letters.", { reply_markup: mainMenu() });
    return;
  }

  const matches = banks.filter((b) => b.name.toUpperCase().startsWith(searchTerm));

  if (matches.length === 0) {
    await ctx.reply(`No banks found starting with "${searchTerm}".`, { reply_markup: mainMenu() });
    return;
  }

  if (matches.length === 1) {
    await selectBank(conversation, ctx, _userId, matches[0]);
    return;
  }

  const shown = matches.slice(0, 20);
  const matchList = shown
    .map((b, i) => `${i + 1}. ${b.name}`)
    .join("\n");
  const overflowHint =
    matches.length > shown.length ? `\n(showing 1-${shown.length} of ${matches.length})` : "";

  await ctx.reply(
    `Found ${matches.length} bank(s) starting with "${searchTerm}":\n\n${matchList}${overflowHint}\n\nEnter the number of your bank:`,
  );

  const selectCtx = await conversation.waitFor("message:text");
  const selection = parseInt(selectCtx.message.text.trim(), 10) - 1;

  if (isNaN(selection) || selection < 0 || selection >= shown.length) {
    await ctx.reply(
      `Invalid selection. Enter a number between 1 and ${shown.length}.`,
      { reply_markup: mainMenu() },
    );
    return;
  }

  await selectBank(conversation, ctx, _userId, shown[selection]!);
}

async function selectBank(
  conversation: MyConversation,
  ctx: MyContext,
  userId: string,
  bank: { id: number; code: string; name: string },
): Promise<void> {
  await ctx.reply(`Selected: ${bank.name}\nEnter 10-digit account number:`);

  const acctCtx = await conversation.waitFor("message:text");
  const accountNumber = acctCtx.message.text.trim();

  if (!/^\d{10}$/.test(accountNumber)) {
    await ctx.reply("Invalid account number. Must be 10 digits.", { reply_markup: mainMenu() });
    return;
  }

  await ctx.reply("Resolving account...");

  let resolved;
  try {
    resolved = await conversation.external(() => resolveBankAccount(bank.code, accountNumber, bank.name));
  } catch (err) {
    const reason = (err as Error)?.message ?? "unknown error";
    log.error({ err, bankCode: bank.code, accountNumber, bankName: bank.name }, "Failed to resolve account");
    await ctx.reply(
      `Failed to resolve account: ${reason}\n\nCheck the account number and bank, then try again.`,
      { reply_markup: mainMenu() },
    );
    return;
  }

  await ctx.reply(
    `Found: ${bank.name}\nAccount: ${resolved.accountName}\n\nConfirm?`,
    { reply_markup: { inline_keyboard: [[{ text: "Yes, add", callback_data: "confirm_add" }, { text: "Cancel", callback_data: "cancel_add" }]] } },
  );

  const confirmCtx = await conversation.waitFor("callback_query:data");
  if (confirmCtx.callbackQuery?.data !== "confirm_add") {
    await ctx.reply("Cancelled.", { reply_markup: mainMenu() });
    return;
  }

  try {
    await conversation.external(() =>
      // Store the code FLW actually accepted for resolution (resolved.bankCode),
      // so payouts reuse a code known to work with this bank.
      storeBankAccount(userId, resolved.bankCode, bank.name, accountNumber, resolved.accountName),
    );
  } catch (err) {
    log.error({ err }, "Failed to store bank account");
    await ctx.reply("Failed to save. PII_ENCRYPTION_KEY may be missing.", { reply_markup: mainMenu() });
    return;
  }

  await ctx.reply(`Bank account added!\n${bank.name} - ${resolved.accountName}`, { reply_markup: mainMenu() });
}

async function deleteBankAccount(
  conversation: MyConversation,
  ctx: MyContext,
  _userId: string,
  bankAccountId: string,
): Promise<void> {
  await ctx.reply("Delete this bank account?", {
    reply_markup: { inline_keyboard: [[{ text: "Yes, delete", callback_data: "confirm_del" }, { text: "Cancel", callback_data: "cancel_del" }]] },
  });

  const confirmCtx = await conversation.waitFor("callback_query:data");
  if (confirmCtx.callbackQuery?.data !== "confirm_del") {
    await ctx.reply("Cancelled.", { reply_markup: mainMenu() });
    return;
  }

  try {
    await conversation.external(() =>
      prisma.bankAccount.delete({ where: { id: bankAccountId, userId: _userId } }),
    );
    await ctx.reply("Bank account deleted.", { reply_markup: mainMenu() });
  } catch {
    await ctx.reply("Failed to delete.", { reply_markup: mainMenu() });
  }
}