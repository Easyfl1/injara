import type { User, Order } from "@prisma/client";
import { koboToNgnString, injBaseToHuman } from "../domain/money.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ service: "notifications" });

let _bot: any = null;

export function setBot(bot: any) {
  _bot = bot;
}

async function sendMessage(chatId: string, text: string, options?: any): Promise<void> {
  if (!_bot) {
    log.warn("Bot not set, cannot send message");
    return;
  }
  try {
    await _bot.api.sendMessage(chatId, text, options);
  } catch (err) {
    log.error({ err, chatId }, "Failed to send Telegram message");
  }
}

export async function notifyBuyComplete(order: Order & { user: User }): Promise<void> {
  const injHuman = injBaseToHuman(order.injAmountBase);
  const ngnHuman = koboToNgnString(order.ngnAmountKobo);
  const feeHuman = koboToNgnString(order.feeKobo);

  const msg = [
    `Buy Order Completed`,
    ``,
    `Order: ${order.publicId}`,
    `INJ Amount: ${injHuman} INJ`,
    `NGN Paid: NGN ${ngnHuman}`,
    `Fee: NGN ${feeHuman}`,
    order.txHash ? `Tx Hash: ${order.txHash}` : ``,
    ``,
    `Your INJ has been sent to:`,
    `${order.injAddress}`,
  ]
    .filter(Boolean)
    .join("\n");

  await sendMessage(order.user.telegramId, msg);
}

export async function notifySellComplete(order: Order & { user: User }): Promise<void> {
  const injHuman = injBaseToHuman(order.injAmountBase);
  const ngnHuman = koboToNgnString(order.ngnAmountKobo);

  const msg = [
    `Sell Order Completed`,
    ``,
    `Order: ${order.publicId}`,
    `INJ Sold: ${injHuman} INJ`,
    `NGN Received: NGN ${ngnHuman}`,
    ``,
    `Payment has been sent to your bank account.`,
  ]
    .filter(Boolean)
    .join("\n");

  await sendMessage(order.user.telegramId, msg);
}

export async function notifyOrderExpired(order: Order & { user: User }): Promise<void> {
  const msg = [
    `Order Expired`,
    ``,
    `Order: ${order.publicId}`,
    ``,
    `Your order has expired. If you were debited, please contact support.`,
  ].join("\n");

  await sendMessage(order.user.telegramId, msg);
}

export async function notifyPaymentReceived(order: Order & { user: User }): Promise<void> {
  const msg = [
    `Payment Received`,
    ``,
    `Order: ${order.publicId}`,
    ``,
    `We've received your payment. Processing your order...`,
  ].join("\n");

  await sendMessage(order.user.telegramId, msg);
}

export async function notifySendInstructions(
  order: Order & { user: User },
  memo: string,
  treasuryAddress: string,
): Promise<void> {
  const injHuman = injBaseToHuman(order.injAmountBase);

  const msg = [
    `Send INJ Instructions`,
    ``,
    `Order: ${order.publicId}`,
    `Amount: ${injHuman} INJ`,
    ``,
    `Send exactly ${injHuman} INJ to:`,
    `${treasuryAddress}`,
    ``,
    `IMPORTANT: Include this memo exactly:`,
    `${memo}`,
    ``,
    `Without the correct memo, your deposit may not be processed.`,
    ``,
    `You have 15 minutes to complete the deposit.`,
  ].join("\n");

  await sendMessage(order.user.telegramId, msg);
}

export async function notifyAdmin(message: string): Promise<void> {
  const env = process.env.ADMIN_ALERT_CHAT_ID;
  if (!env) return;
  await sendMessage(env, `Admin Alert\n\n${message}`);
}
