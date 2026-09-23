import type { MyContext, MyConversation } from "../bot.js";
import { validateEmail } from "../../domain/address.js";
import { prisma } from "../../db/prisma.js";

export async function collectEmailConversation(
  conversation: MyConversation,
  ctx: MyContext,
): Promise<void> {
  const userId = String(ctx.from?.id);
  const user = await conversation.external(() =>
    prisma.user.findUnique({ where: { telegramId: userId } }),
  );

  if (user?.email) return;

  await ctx.reply("Please enter your email address:");

  while (true) {
    const emailCtx = await conversation.waitFor("message:text");
    const email = emailCtx.message.text.trim();

    if (!validateEmail(email)) {
      await ctx.reply("Invalid email. Please try again:");
      continue;
    }

    await conversation.external(() =>
      prisma.user.update({
        where: { telegramId: userId },
        data: { email },
      }),
    );

    await ctx.reply(`Email saved: ${email}`);
    return;
  }
}
