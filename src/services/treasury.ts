import { prisma } from "../db/prisma.js";
import type { InjBase, NgnKobo } from "../domain/money.js";
import { subBase, cmpBase } from "../domain/money.js";
import { getEnv } from "../config/env.js";
import { getBankBalance } from "./injective.js";

export async function getTreasury() {
  let treasury = await prisma.treasuryState.findUnique({ where: { id: 1 } });
  if (!treasury) {
    treasury = await prisma.treasuryState.create({
      data: {
        id: 1,
        walletAddress: getEnv().TREASURY_INJ_ADDRESS,
        onchainInjBase: "0",
        reservedInjBase: "0",
        gasBufferInjBase: "50000000000000000", // 0.05 INJ
        flwAvailableNgnKobo: 0n,
        reservedNgnKobo: 0n,
        lastSyncedAt: new Date(),
      },
    });
  }
  return treasury;
}

export async function syncTreasuryInj(): Promise<void> {
  const env = getEnv();
  const balance = await getBankBalance(env.TREASURY_INJ_ADDRESS);
  await prisma.treasuryState.update({
    where: { id: 1 },
    data: { onchainInjBase: balance, lastSyncedAt: new Date() },
  });
}

export function availableInj(treasury: {
  onchainInjBase: string;
  reservedInjBase: string;
  gasBufferInjBase: string;
}): InjBase {
  return subBase(
    subBase(treasury.onchainInjBase, treasury.reservedInjBase),
    treasury.gasBufferInjBase,
  );
}

export async function ngnAvailable(): Promise<NgnKobo> {
  const env = getEnv();

  if (env.FLW_NGN_BALANCE_KOBO !== undefined) {
    return BigInt(env.FLW_NGN_BALANCE_KOBO);
  }

  const treasury = await getTreasury();
  if (
    treasury.flwAvailableNgnKobo === 0n &&
    treasury.lastSyncedAt.getTime() < Date.now() - 5 * 60 * 1000
  ) {
    throw new NgnInventoryUnknownError();
  }

  if (treasury.lastSyncedAt.getTime() < Date.now() - 5 * 60 * 1000) {
    throw new NgnInventoryUnknownError();
  }

  return treasury.flwAvailableNgnKobo - treasury.reservedNgnKobo;
}

export class NgnInventoryUnknownError extends Error {
  constructor() {
    super("NGN inventory unknown - try later");
    this.name = "NgnInventoryUnknownError";
  }
}

export async function canBuyInj(amountBase: InjBase): Promise<{
  ok: boolean;
  treasury: Awaited<ReturnType<typeof getTreasury>>;
  available: InjBase;
}> {
  const treasury = await getTreasury();
  const available = availableInj(treasury);
  const ok = cmpBase(available, amountBase) >= 0;
  return { ok, treasury, available };
}
