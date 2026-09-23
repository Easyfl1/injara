const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS ?? "")
  .split(",")
  .filter(Boolean)
  .map(Number);

export function isAdmin(telegramId: number): boolean {
  return ADMIN_IDS.includes(telegramId);
}
