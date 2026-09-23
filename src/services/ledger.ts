import type { LedgerAccount, LedgerDirection, Asset } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import type { PrismaTransactionClient } from "../db/tx.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger({ service: "ledger" });

export interface LedgerPosting {
  account: LedgerAccount;
  asset: Asset;
  amountBase: string;
  direction: LedgerDirection;
}

export async function post(
  bookTxId: string,
  orderId: string,
  postings: LedgerPosting[],
  idempotencySuffix: string,
): Promise<void> {
  for (const p of postings) {
    await prisma.ledgerEntry.create({
      data: {
        bookTxId,
        orderId,
        account: p.account,
        asset: p.asset,
        amountBase: p.amountBase,
        direction: p.direction,
        idempotencyKey: `${bookTxId}:${orderId}:${idempotencySuffix}:${p.account}:${p.direction}`,
      },
    });
  }

  await assertBalanced(bookTxId);
  log.debug({ bookTxId, orderId, count: postings.length }, "Ledger posted");
}

export async function postTx(
  tx: PrismaTransactionClient,
  bookTxId: string,
  orderId: string,
  postings: LedgerPosting[],
  idempotencySuffix: string,
): Promise<void> {
  for (const p of postings) {
    await tx.ledgerEntry.create({
      data: {
        bookTxId,
        orderId,
        account: p.account,
        asset: p.asset,
        amountBase: p.amountBase,
        direction: p.direction,
        idempotencyKey: `${bookTxId}:${orderId}:${idempotencySuffix}:${p.account}:${p.direction}`,
      },
    });
  }

  await assertBalancedTx(tx, bookTxId);
  log.debug({ bookTxId, orderId, count: postings.length }, "Ledger posted (tx)");
}

async function assertBalancedTx(
  tx: PrismaTransactionClient,
  bookTxId: string,
): Promise<void> {
  const entries = await tx.ledgerEntry.findMany({
    where: { bookTxId },
  });

  const byAsset: Record<string, { debit: bigint; credit: bigint }> = {};
  for (const e of entries) {
    if (!byAsset[e.asset]) byAsset[e.asset] = { debit: 0n, credit: 0n };
    const amount = BigInt(e.amountBase);
    if (e.direction === "debit") {
      byAsset[e.asset]!.debit += amount;
    } else {
      byAsset[e.asset]!.credit += amount;
    }
  }

  for (const [asset, { debit, credit }] of Object.entries(byAsset)) {
    if (debit !== credit) {
      throw new Error(
        `Ledger unbalanced for bookTxId=${bookTxId} asset=${asset}: debit=${debit} credit=${credit}`,
      );
    }
  }
}

async function assertBalanced(bookTxId: string): Promise<void> {
  const entries = await prisma.ledgerEntry.findMany({
    where: { bookTxId },
  });

  const byAsset: Record<string, { debit: bigint; credit: bigint }> = {};
  for (const e of entries) {
    if (!byAsset[e.asset]) byAsset[e.asset] = { debit: 0n, credit: 0n };
    const amount = BigInt(e.amountBase);
    if (e.direction === "debit") {
      byAsset[e.asset]!.debit += amount;
    } else {
      byAsset[e.asset]!.credit += amount;
    }
  }

  for (const [asset, { debit, credit }] of Object.entries(byAsset)) {
    if (debit !== credit) {
      throw new Error(
        `Ledger unbalanced for bookTxId=${bookTxId} asset=${asset}: debit=${debit} credit=${credit}`,
      );
    }
  }
}

export async function netBalance(
  accounts: LedgerAccount[],
  asset: Asset,
  since?: Date,
): Promise<bigint> {
  const where: any = { account: { in: accounts }, asset };
  if (since) where.createdAt = { gte: since };

  const entries = await prisma.ledgerEntry.findMany({ where });
  let net = 0n;
  for (const e of entries) {
    const amount = BigInt(e.amountBase);
    net += e.direction === "debit" ? amount : -amount;
  }
  return net;
}
