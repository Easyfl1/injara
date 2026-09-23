import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { stringToPath } from "@cosmjs/crypto";
import { getEnv } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ service: "wallet" });

const HD_PREFIX = "m/44'/60'/0'/0/";

let _nextIndex: number | null = null;

async function getNextWalletIndex(): Promise<number> {
  if (_nextIndex === null) {
    const last = await prisma.user.findFirst({
      where: { walletIndex: { not: null } },
      orderBy: { walletIndex: "desc" },
      select: { walletIndex: true },
    });
    _nextIndex = (last?.walletIndex ?? -1) + 1;
  }
  const idx = _nextIndex;
  _nextIndex++;
  return idx;
}

function generateWalletId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "W-";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  id += "-";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export interface UserWallet {
  walletId: string;
  injAddress: string;
  walletIndex: number;
}

export async function generateUserWallet(): Promise<UserWallet> {
  const env = getEnv();
  if (!env.WALLET_MASTER_MNEMONIC) {
    throw new Error("WALLET_MASTER_MNEMONIC not configured");
  }

  const index = await getNextWalletIndex();
  const hdPath = stringToPath(`${HD_PREFIX}${index}`);

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(
    env.WALLET_MASTER_MNEMONIC,
    {
      prefix: "inj",
      hdPaths: [hdPath],
    },
  );

  const [{ address }] = await wallet.getAccounts();
  const walletId = generateWalletId();

  log.info({ walletIndex: index, address, walletId }, "Generated user wallet");

  return { walletId, injAddress: address, walletIndex: index };
}

export async function assignWalletToUser(
  userId: string,
): Promise<UserWallet> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (existing?.injAddress && existing?.walletId) {
    return {
      walletId: existing.walletId,
      injAddress: existing.injAddress,
      walletIndex: existing.walletIndex!,
    };
  }

  const wallet = await generateUserWallet();

  await prisma.user.update({
    where: { id: userId },
    data: {
      injAddress: wallet.injAddress,
      walletId: wallet.walletId,
      walletIndex: wallet.walletIndex,
    },
  });

  return wallet;
}
