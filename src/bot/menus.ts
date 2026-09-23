import { InlineKeyboard } from "grammy";

export function mainMenu(): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("Buy INJ", "m:buy")
    .text("Sell INJ", "m:sell")
    .row()
    .text("Bank Accounts", "m:banks")
    .text("Check Order", "m:status")
    .row()
    .text("History", "m:hist")
    .text("Help", "m:help")
    .row()
    .text("Support", "m:support");

  return kb;
}

export function adminMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Treasury Balance", "a:treasury")
    .text("Pending Orders", "a:pending")
    .row()
    .text("Failed Orders", "a:failed")
    .text("Users", "a:users")
    .row()
    .text("Revenue", "a:revenue")
    .text("Unmatched", "a:unmatched")
    .row()
    .text("Halt Trading", "a:halt")
    .text("Resume Trading", "a:resume");
}

export function quoteConfirmKeyboard(publicId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Confirm", `q:ok:${publicId}`)
    .text("Cancel", `q:no:${publicId}`);
}

export function statusKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Refresh", "m:status")
    .row()
    .text("Back", "m:back");
}

export function bankAccountKeyboard(bankIds: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("Add Bank Account", "add");

  bankIds.forEach((id) => {
    kb.row().text("Delete", `del:${id}`);
  });

  kb.row().text("Back", "m:back");

  return kb;
}
