export const RedisKeys = {
  price: (asset: string) => `price:${asset}`,
  rateLimit: (id: string) => `rl:tg:${id}`,
  orderLock: (id: string) => `lock:order:${id}`,
  treasurySend: () => "lock:treasury:send",
  payoutLock: (id: string) => `lock:payout:${id}`,
  haltTrading: () => "halt:trading",
  priceAge: (asset: string) => `price:age:${asset}`,
} as const;
