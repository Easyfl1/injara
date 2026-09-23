import {
  generatePublicId,
  generatePaymentReference,
  generateDepositMemo,
} from "../domain/ids.js";
import {
  injHumanToBase,
  injBaseToHuman,
  buyPayableKobo,
  sellPayoutKobo,
  koboToNgnString,
  cmpBase,
  type NgnKobo,
} from "../domain/money.js";
import { getSpot } from "./pricing.js";
import {
  canBuyInj,
  ngnAvailable,
  NgnInventoryUnknownError,
} from "./treasury.js";
import { postTx } from "./ledger.js";
import { createPaymentLink } from "./flutterwave.js";
import { getEnv } from "../config/env.js";
import { FLW_PAYOUT_FEE_KOBO } from "../config/constants.js";
import { prisma } from "../db/prisma.js";

export class OrderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

export interface OrderView {
  orderId: string;
  publicId: string;
  orderType: "BUY" | "SELL";
  status: string;
  injAmountBase: string;
  ngnAmountKobo: string;
  feeKobo: string;
  payableKobo: string;
  quoteExpiresAt: Date;
  paymentLink?: string;
  depositMemo?: string;
  treasuryAddress?: string;
}

export async function createBuyQuote(
  userId: string,
  injHuman: string,
): Promise<OrderView> {
  const env = getEnv();
  if (!env.BUY_ENABLED) throw new OrderError("Buy is currently disabled", "BUY_DISABLED");

  const price = await getSpot();
  const snapshot = price;
  const injAmountBase = injHumanToBase(injHuman);

  const { ok, available } = await canBuyInj(injAmountBase);
  if (!ok) {
    throw new OrderError(
      `Insufficient treasury INJ. Available: ${available}`,
      "INSUFFICIENT_TREASURY",
    );
  }

  const { gross, fee, payable } = buyPayableKobo(
    injHuman,
    snapshot.injNgn,
    env.BUY_FEE_BPS,
  );

  if (payable > BigInt(env.MAX_PAYABLE_KOBO)) {
    throw new OrderError(
      `Order exceeds maximum payable amount of NGN ${koboToNgnString(BigInt(env.MAX_PAYABLE_KOBO))}`,
      "EXCEEDS_MAX",
    );
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const dailyTotal = await prisma.order.aggregate({
    where: {
      userId,
      createdAt: { gte: today },
      orderType: "BUY",
      status: { notIn: ["CANCELLED", "EXPIRED"] },
    },
    _sum: { ngnAmountKobo: true },
  });

  const dailySum = (dailyTotal._sum.ngnAmountKobo ?? 0n) + payable;
  if (dailySum > BigInt(env.DAILY_USER_NGN_KOBO)) {
    throw new OrderError("Daily NGN limit exceeded", "DAILY_LIMIT");
  }

  const publicId = generatePublicId("BUY");
  const quoteExpiresAt = new Date(Date.now() + env.QUOTE_TTL_SEC * 1000);

  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.order.create({
      data: {
        publicId,
        orderType: "BUY",
        userId,
        status: "QUOTED",
        injAmountBase,
        ngnAmountKobo: gross,
        feeKobo: fee,
        injAddress: user.injAddress ?? "",
        quoteExpiresAt,
      },
    });

    await tx.quoteSnapshot.create({
      data: {
        orderId: o.id,
        source: "coingecko",
        injNgn: snapshot.injNgn,
        injUsd: snapshot.injUsd,
        priceUpdatedAt: snapshot.priceUpdatedAt,
        feeBps: env.BUY_FEE_BPS,
        injAmountBase,
        grossKobo: gross,
        feeKobo: fee,
        flwPayoutFeeKobo: 0n,
        payableOrPayoutKobo: payable,
        rawPayload: snapshot.rawPayload as any,
      },
    });

    return o;
  });

  return {
    orderId: order.id,
    publicId,
    orderType: "BUY",
    status: "QUOTED",
    injAmountBase,
    ngnAmountKobo: gross.toString(),
    feeKobo: fee.toString(),
    payableKobo: payable.toString(),
    quoteExpiresAt,
  };
}

export async function acceptBuyQuote(orderId: string): Promise<{
  paymentLink: string;
  paymentWindowEndsAt: Date;
}> {
  const env = getEnv();

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { user: true, quoteSnapshot: true },
  });

  if (order.status !== "QUOTED") {
    throw new OrderError("Order is not in QUOTED status", "INVALID_STATUS");
  }

  if (new Date() > order.quoteExpiresAt) {
    throw new OrderError("Quote has expired", "QUOTE_EXPIRED");
  }

  const paymentReference = generatePaymentReference(order.publicId);
  const injAmountBase = order.injAmountBase;
  const payable = order.ngnAmountKobo + order.feeKobo;
  const paymentWindowEndsAt = new Date(
    Date.now() + env.PAYMENT_WINDOW_SEC * 1000,
  );

  await prisma.$transaction(async (tx) => {
    // Serialize concurrent accepts: lock the treasury row, re-read, re-check.
    // Prevents the lost-update race where two accepts read the same
    // reservedInjBase and one increment is silently dropped.
    await tx.$executeRaw`SELECT id FROM treasury WHERE id = 1 FOR UPDATE`;

    const treasury = await tx.treasuryState.findUnique({ where: { id: 1 } });
    if (!treasury) throw new Error("Treasury not found");

    const reserved = BigInt(treasury.reservedInjBase);
    const onchain = BigInt(treasury.onchainInjBase);
    const gasBuffer = BigInt(treasury.gasBufferInjBase);
    const available = onchain - reserved - gasBuffer;

    if (available < BigInt(injAmountBase)) {
      throw new OrderError("Insufficient treasury INJ", "INSUFFICIENT_TREASURY");
    }

    // CAS on order status: only transition QUOTED -> AWAITING_PAYMENT once,
    // so a double-tap cannot reserve INJ twice for the same order.
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: "QUOTED" },
      data: {
        status: "AWAITING_PAYMENT",
        paymentReference,
        paymentWindowEndsAt,
        awaitingPaymentAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new OrderError("Order is not in QUOTED status", "INVALID_STATUS");
    }

    await tx.treasuryState.update({
      where: { id: 1 },
      data: { reservedInjBase: { increment: BigInt(injAmountBase) } },
    });

    const bookTxId = `buy_reserve:${order.id}`;
    await postTx(tx, bookTxId, order.id, [
      {
        account: "TREASURY_INJ_RESERVED",
        asset: "INJ",
        amountBase: injAmountBase,
        direction: "debit",
      },
      {
        account: "TREASURY_INJ",
        asset: "INJ",
        amountBase: injAmountBase,
        direction: "credit",
      },
    ], "reserve");
  });

  const amountStr = koboToNgnString(payable);

  const flwResult = await createPaymentLink({
    txRef: paymentReference,
    amount: amountStr,
    redirectUrl: `${env.PUBLIC_BASE_URL}/payments/callback`,
    customer: {
      email: order.user.email ?? "user@injara.app",
      name: order.user.firstName ?? order.user.username ?? "User",
    },
    customizations: {
      title: "Injara",
      description: `Buy ${injBaseToHuman(injAmountBase)} INJ - ${order.publicId}`,
    },
    meta: { order_public_id: order.publicId },
    sessionDuration: 45,
  });

  await prisma.order.update({
    where: { id: orderId },
    data: { paymentLink: flwResult.link },
  });

  return { paymentLink: flwResult.link, paymentWindowEndsAt };
}

export async function createSellQuote(
  userId: string,
  injHuman: string,
  bankAccountId: string,
): Promise<OrderView> {
  const env = getEnv();
  if (!env.SELL_ENABLED) throw new OrderError("Sell is currently disabled", "SELL_DISABLED");

  const price = await getSpot();
  const snapshot = price;
  const injAmountBase = injHumanToBase(injHuman);

  let availableNgn: NgnKobo;
  try {
    availableNgn = await ngnAvailable();
  } catch (err) {
    if (err instanceof NgnInventoryUnknownError) {
      throw new OrderError("NGN inventory unknown - try later", "NGN_UNKNOWN");
    }
    throw err;
  }

  const { gross, fee, payout } = sellPayoutKobo(
    injHuman,
    snapshot.injNgn,
    env.SELL_FEE_BPS,
    FLW_PAYOUT_FEE_KOBO,
  );

  if (payout + FLW_PAYOUT_FEE_KOBO > availableNgn) {
    throw new OrderError("Insufficient NGN in treasury", "INSUFFICIENT_NGN");
  }

  if (payout > BigInt(env.MAX_PAYABLE_KOBO)) {
    throw new OrderError("Order exceeds maximum payout", "EXCEEDS_MAX");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const publicId = generatePublicId("SELL");
  const depositMemo = generateDepositMemo(publicId);
  const quoteExpiresAt = new Date(Date.now() + env.QUOTE_TTL_SEC * 1000);

  const order = await prisma.$transaction(async (tx) => {
    await tx.treasuryState.update({
      where: { id: 1 },
      data: {
        reservedNgnKobo: {
          increment: payout + FLW_PAYOUT_FEE_KOBO,
        },
      },
    });

    const o = await tx.order.create({
      data: {
        publicId,
        orderType: "SELL",
        userId,
        status: "QUOTED",
        injAmountBase,
        ngnAmountKobo: gross,
        feeKobo: fee,
        injAddress: user.injAddress ?? "",
        bankAccountId,
        quoteExpiresAt,
      },
    });

    await tx.quoteSnapshot.create({
      data: {
        orderId: o.id,
        source: "coingecko",
        injNgn: snapshot.injNgn,
        injUsd: snapshot.injUsd,
        priceUpdatedAt: snapshot.priceUpdatedAt,
        feeBps: env.SELL_FEE_BPS,
        injAmountBase,
        grossKobo: gross,
        feeKobo: fee,
        flwPayoutFeeKobo: FLW_PAYOUT_FEE_KOBO,
        payableOrPayoutKobo: payout,
        rawPayload: snapshot.rawPayload as any,
      },
    });

    return o;
  });

  return {
    orderId: order.id,
    publicId,
    orderType: "SELL",
    status: "QUOTED",
    injAmountBase,
    ngnAmountKobo: gross.toString(),
    feeKobo: fee.toString(),
    payableKobo: payout.toString(),
    quoteExpiresAt,
    depositMemo,
    treasuryAddress: env.TREASURY_INJ_ADDRESS,
  };
}

export async function acceptSellQuote(orderId: string): Promise<{
  memo: string;
  treasuryAddress: string;
}> {
  const env = getEnv();
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
  });

  if (order.status !== "QUOTED") {
    throw new OrderError("Order is not in QUOTED status", "INVALID_STATUS");
  }
  if (new Date() > order.quoteExpiresAt) {
    throw new OrderError("Quote has expired", "QUOTE_EXPIRED");
  }

  const depositMemo = generateDepositMemo(order.publicId);
  const depositWindowEndsAt = new Date(
    Date.now() + env.DEPOSIT_WINDOW_SEC * 1000,
  );

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: "AWAITING_DEPOSIT",
      depositMemo,
      depositWindowEndsAt,
      awaitingDepositAt: new Date(),
    },
  });

  return { memo: depositMemo, treasuryAddress: env.TREASURY_INJ_ADDRESS };
}

export async function getOrder(
  publicId: string,
): Promise<OrderView | null> {
  const order = await prisma.order.findUnique({
    where: { publicId },
  });
  if (!order) return null;

  const payable =
    order.orderType === "BUY"
      ? order.ngnAmountKobo + order.feeKobo
      : order.ngnAmountKobo - order.feeKobo;

  return {
    orderId: order.id,
    publicId: order.publicId,
    orderType: order.orderType,
    status: order.status,
    injAmountBase: order.injAmountBase,
    ngnAmountKobo: order.ngnAmountKobo.toString(),
    feeKobo: order.feeKobo.toString(),
    payableKobo: payable.toString(),
    quoteExpiresAt: order.quoteExpiresAt,
    paymentLink: order.paymentLink ?? undefined,
    depositMemo: order.depositMemo ?? undefined,
  };
}

export async function getUserOrders(
  userId: string,
  limit = 10,
): Promise<OrderView[]> {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return orders.map((o) => ({
    orderId: o.id,
    publicId: o.publicId,
    orderType: o.orderType,
    status: o.status,
    injAmountBase: o.injAmountBase,
    ngnAmountKobo: o.ngnAmountKobo.toString(),
    feeKobo: o.feeKobo.toString(),
    payableKobo: (o.ngnAmountKobo + o.feeKobo).toString(),
    quoteExpiresAt: o.quoteExpiresAt,
    paymentLink: o.paymentLink ?? undefined,
    depositMemo: o.depositMemo ?? undefined,
  }));
}
