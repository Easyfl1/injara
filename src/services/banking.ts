import { getEnv } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { prisma } from "../db/prisma.js";
import { encrypt, decrypt } from "../utils/crypto.js";

const log = childLogger({ service: "banking" });

// Standard NIBSS bank codes used by Flutterwave's NG endpoints.
// NOTE: Flutterwave's /banks/NG list is authoritative — this map is only a
// fallback for when the list is unavailable, so it must use the SAME code
// scheme (3-digit NIBSS or 6-digit MMO codes) that the list returns.
const NIBSS_CODE_MAP: Record<string, string> = {
  moniepointmicrofinancebank: "50515",
  moniepointmfb: "50515",
  moniepoint: "50515",
  opaydigital: "999992",
  opay: "999992",
  palmpay: "999991",
  kuda: "50211",
  kudamicrofinancebank: "50211",
  accessbank: "044",
  gtbank: "058",
  gtb: "058",
  firstbank: "011",
  fidelity: "070",
  fidelitybank: "070",
  zenith: "057",
  zenithbank: "057",
  uba: "033",
  unitedbankforafrica: "033",
  stanbicibtc: "221",
  sterling: "232",
  sterlingbank: "232",
  unionbank: "032",
  fcmb: "214",
  wema: "035",
  wemabank: "035",
  polaris: "076",
  keystone: "082",
  unitybank: "215",
  suntrust: "100",
  providus: "101",
  sparkle: "51310",
  fairmoney: "562",
  carbon: "565",
  vfd: "566",
};

/**
 * Normalize a bank name for lookup: lowercase, strip ALL non-alphanumeric
 * characters (spaces, hyphens, dots, etc.) so "Moniepoint Microfinance Bank"
 * and "moniepointmicrofinancebank" both map to the same key.
 */
function normalizeBankName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getNibssCode(bankName: string, flwCode: string): string {
  const normalized = normalizeBankName(bankName);
  log.debug({ normalized, bankName, flwCode }, "NIBSS code lookup");
  if (NIBSS_CODE_MAP[normalized]) {
    const code = NIBSS_CODE_MAP[normalized]!;
    log.debug({ mappedCode: code }, "NIBSS code mapped");
    return code;
  }
  return flwCode;
}

export interface ResolvedAccount {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface FlwBank {
  id: number;
  code: string;
  name: string;
}

export async function listBanksNG(): Promise<FlwBank[]> {
  const { listBanksNG: flwListBanksNG } = await import("./flutterwave.js");
  return flwListBanksNG();
}

export async function resolveBankAccount(
  bankCode: string,
  accountNumber: string,
  bankName?: string,
): Promise<ResolvedAccount> {
  const { resolveAccount: flwResolveAccount } = await import("./flutterwave.js");
  const nibssCode = bankName ? getNibssCode(bankName, bankCode) : bankCode;
  log.debug({ bankCode, nibssCode, bankName, accountNumber }, "Resolving bank account with Flutterwave");

  let result;
  try {
    result = await flwResolveAccount(nibssCode, accountNumber);
  } catch (err) {
    // If the mapped/list code was rejected, fall back to the raw code once.
    if (nibssCode !== bankCode) {
      log.warn(
        { err, nibssCode, bankCode, bankName, accountNumber },
        "Resolve failed with mapped code, retrying with original FLW code",
      );
      result = await flwResolveAccount(bankCode, accountNumber);
    } else {
      throw err;
    }
  }

  const banks = await listBanksNG();
  const bank = banks.find((b) => b.code === bankCode);

  return {
    bankCode: nibssCode,
    bankName: bank?.name ?? bankName ?? "Unknown",
    accountNumber: result.data.account_number,
    accountName: result.data.account_name,
  };
}

export async function storeBankAccount(
  userId: string,
  bankCode: string,
  bankName: string,
  accountNumber: string,
  accountName: string,
): Promise<string> {
  const env = getEnv();
  if (!env.PII_ENCRYPTION_KEY) {
    throw new Error("PII_ENCRYPTION_KEY not configured");
  }

  const accountNumberEncrypted = encrypt(accountNumber, env.PII_ENCRYPTION_KEY);
  const accountNameEncrypted = encrypt(accountName, env.PII_ENCRYPTION_KEY);

  const existing = await prisma.bankAccount.findFirst({
    where: {
      userId,
      bankCode,
      accountNumberBlind: accountNumberEncrypted.blind,
    },
  });

  if (existing) return existing.id;

  const bankAccount = await prisma.bankAccount.create({
    data: {
      userId,
      bankCode,
      bankName,
      accountNumberCipher: Buffer.from(accountNumberEncrypted.cipher),
      accountNumberIv: Buffer.from(accountNumberEncrypted.iv),
      accountNumberTag: Buffer.from(accountNumberEncrypted.tag),
      accountNumberBlind: accountNumberEncrypted.blind,
      accountNameCipher: Buffer.from(accountNameEncrypted.cipher),
      resolvedName: accountName,
      keyVersion: 1,
    },
  });

  log.info({ userId, bankCode, bankAccountId: bankAccount.id }, "Bank account stored");
  return bankAccount.id;
}

export async function getUserBankAccounts(userId: string) {
  return prisma.bankAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function decryptAccountNumber(bankAccountId: string): Promise<string> {
  const env = getEnv();
  const account = await prisma.bankAccount.findUniqueOrThrow({
    where: { id: bankAccountId },
  });

  return decrypt(
    new Uint8Array(account.accountNumberCipher),
    new Uint8Array(account.accountNumberIv),
    new Uint8Array(account.accountNumberTag),
    env.PII_ENCRYPTION_KEY,
  );
}
